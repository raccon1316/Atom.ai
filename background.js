import { AI } from './ai.js';

const DEFAULT_USER_SETTINGS = {
  isPro: false,
  apiKey: '',
  model: 'meta/llama-3.1-8b-instruct',
  dailyCallsUsed: 0,
  lastResetDate: '',
  webhookUrl: ''
};

const DEFAULT_WORKFLOW_STATE = {
  recording: false,
  recordedSteps: [],
  status: 'No workflow recorded.',
  tabId: null
};

const DEFAULT_QUOTA_STATE = {
  day: '',
  count: 0,
  minuteWindowStart: 0,
  minuteCount: 0
};

const FREE_DAILY_LIMIT = 20;
const MAX_CALLS_PER_MINUTE = 25;
const AUTOFILL_MAX_WAIT_MS = 30000;
const DEBUG_LOG_LIMIT = 200;

let userSettings = { ...DEFAULT_USER_SETTINGS };
let quotaState = { ...DEFAULT_QUOTA_STATE };
let sessionApiKey = '';
const autofillJobs = new Map();

async function hydrateState() {
  try {
    const [localData, sessionData] = await Promise.all([
      chrome.storage.local.get(['userSettings', 'quotaState']),
      chrome.storage.session.get(['sessionApiKey'])
    ]);
    const data = localData || {};
    if (data.userSettings) userSettings = { ...DEFAULT_USER_SETTINGS, ...data.userSettings };
    if (data.quotaState) quotaState = { ...DEFAULT_QUOTA_STATE, ...data.quotaState };
    sessionApiKey = sessionData?.sessionApiKey || '';
  } catch (e) {}
}

async function persistUserSettings() {
  await chrome.storage.local.set({ userSettings });
}

async function persistQuotaState() {
  await chrome.storage.local.set({ quotaState });
}

function normalizeDateKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

function isProActive() {
  const rawFlag = !!userSettings.isPro;
  const licenseStatus = String(userSettings.licenseStatus || '').toLowerCase();
  const expiresAt = Number(userSettings.licenseExpiresAt || 0);
  const notExpired = !expiresAt || Date.now() < expiresAt;
  if (licenseStatus === 'active' && notExpired) return true;
  if (rawFlag && notExpired && !userSettings.licenseKey) return true;
  return false;
}

async function appendDebugLog(entry = {}) {
  try {
    const data = await chrome.storage.local.get(['debugLog']);
    const list = Array.isArray(data.debugLog) ? data.debugLog : [];
    list.unshift({
      ts: new Date().toISOString(),
      scope: entry.scope || 'general',
      level: entry.level || 'error',
      message: String(entry.message || ''),
      detail: entry.detail || null
    });
    if (list.length > DEBUG_LOG_LIMIT) list.length = DEBUG_LOG_LIMIT;
    await chrome.storage.local.set({ debugLog: list });
  } catch (e) {}
}

async function enforceQuotaAndIncrement() {
  const now = Date.now();
  const today = normalizeDateKey();

  if (quotaState.day !== today) {
    quotaState.day = today;
    quotaState.count = 0;
    quotaState.minuteWindowStart = now;
    quotaState.minuteCount = 0;
  }

  if (!quotaState.minuteWindowStart || now - quotaState.minuteWindowStart > 60000) {
    quotaState.minuteWindowStart = now;
    quotaState.minuteCount = 0;
  }

  if (quotaState.minuteCount >= MAX_CALLS_PER_MINUTE) {
    return {
      allowed: false,
      reason: 'Too many requests in a short time. Please wait a minute and try again.'
    };
  }

  const dailyLimit = isProActive() ? Number.MAX_SAFE_INTEGER : FREE_DAILY_LIMIT;
  if (quotaState.count >= dailyLimit) {
    return {
      allowed: false,
      reason: `Daily limit reached (${FREE_DAILY_LIMIT} free calls). Upgrade to Pro for unlimited calls.`
    };
  }

  quotaState.minuteCount += 1;
  quotaState.count += 1;
  userSettings.dailyCallsUsed = quotaState.count;
  userSettings.lastResetDate = new Date().toDateString();

  await Promise.all([persistQuotaState(), persistUserSettings()]);
  return { allowed: true };
}

const ai = new AI({
  getApiKey: () => sessionApiKey || userSettings.apiKey,
  getModel: () => userSettings.model,
  onCall: async () => await enforceQuotaAndIncrement()
});

function sanitizeUserSettings(input = {}) {
  const next = { ...userSettings, apiKey: '' };
  if (typeof input.isPro === 'boolean') next.isPro = input.isPro;
  if (typeof input.licenseStatus === 'string') next.licenseStatus = input.licenseStatus;
  if (typeof input.licenseKey === 'string') next.licenseKey = input.licenseKey;
  if (typeof input.licenseExpiresAt === 'number') next.licenseExpiresAt = input.licenseExpiresAt;
  if (typeof input.model === 'string') next.model = input.model;
  if (typeof input.webhookUrl === 'string') next.webhookUrl = input.webhookUrl;
  return next;
}

function isTrustedSender(sender) {
  return !sender || sender.id === chrome.runtime.id;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeInTab(tabId, func, args = []) {
  const out = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });
  return out?.[0]?.result;
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.status === "complete") return true;
    } catch (e) {
      return false;
    }
    await sleep(200);
  }
  return false;
}

async function waitForTarget(tabId, action, timeoutMs = AUTOFILL_MAX_WAIT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await executeInTab(tabId, (a) => {
      const normalize = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
      const findByHint = (hint) => {
        const key = normalize(hint);
        if (!key) return null;
        const nodes = [...document.querySelectorAll("input,textarea,select,button,[role='button'],a,[contenteditable='true'],[role='combobox']")];
        let best = null;
        let bestScore = -1;
        for (const el of nodes) {
          const hay = normalize([
            el.innerText || "",
            el.labels?.[0]?.innerText || "",
            el.closest("label")?.innerText || "",
            el.getAttribute("aria-label") || "",
            el.getAttribute("title") || "",
            el.name || "",
            el.id || "",
            el.placeholder || ""
          ].join(" "));
          let score = 0;
          if (hay.includes(key)) score += 5;
          score += key.split(" ").filter((t) => t.length > 2 && hay.includes(t)).length;
          if (score > bestScore) {
            bestScore = score;
            best = el;
          }
        }
        return bestScore > 0 ? best : null;
      };
      const sel = String(a.selector || "").trim();
      if (sel && document.querySelector(sel)) return true;
      const hinted = findByHint(a.field || a.value || a.label || a.text || "");
      return !!hinted;
    }, [action]);
    if (found) return true;
    await sleep(220);
  }
  return false;
}

async function runAutofillStep(job) {
  const action = job.actions[job.index];
  if (!action) return { done: true };
  const actionType = String(action.type || "").toLowerCase();

  if (actionType === "waitfor" || actionType === "wait" || actionType === "wait_for") {
    const ok = await waitForTarget(job.tabId, action, Number(action.waitMs || 12000));
    return ok
      ? { ok: true, mode: "waitFor", field: action.field || action.selector || "" }
      : { ok: false, mode: "waitFor", field: action.field || action.selector || "", reason: "wait_target_not_found" };
  }

  const result = await executeInTab(job.tabId, (a) => {
    const normalize = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const toBool = (v) => {
      if (typeof v === "boolean") return v;
      return ["1", "true", "yes", "y", "on", "checked"].includes(normalize(v));
    };
    const setNativeValue = (el, value) => {
      const str = String(value ?? "");
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor?.set) descriptor.set.call(el, str);
      else el.value = str;
    };
    const trigger = (el) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    };
    const robustClick = (el) => {
      try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}
      try { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); } catch (e) {}
      try {
        el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      } catch (e) {}
      try { el.click(); } catch (e) {}
    };
    const findByHint = (hint, includeClickables = false) => {
      const key = normalize(hint);
      if (!key) return null;
      const selector = includeClickables
        ? "input,textarea,select,button,[role='button'],input[type='submit'],a,[contenteditable='true'],[role='combobox'],span,div"
        : "input,textarea,select,[contenteditable='true'],[role='combobox']";
      const nodes = [...document.querySelectorAll(selector)];
      let best = null;
      let bestScore = -1;
      for (const el of nodes) {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
        const hay = normalize([
          el.innerText || "",
          el.labels?.[0]?.innerText || "",
          el.closest("label")?.innerText || "",
          el.getAttribute("aria-label") || "",
          el.getAttribute("title") || "",
          el.name || "",
          el.id || "",
          el.placeholder || "",
          el.className || ""
        ].join(" "));
        let score = 0;
        if (hay.includes(key)) score += 5;
        score += key.split(" ").filter((t) => t.length > 2 && hay.includes(t)).length;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
      return bestScore > 0 ? best : null;
    };
    const selectOption = (selectEl, valueText) => {
      const target = normalize(valueText);
      let option = [...selectEl.options].find((opt) => normalize(opt.value) === target || normalize(opt.text) === target);
      if (!option) option = [...selectEl.options].find((opt) => normalize(opt.text).includes(target));
      if (!option) return false;
      selectEl.value = option.value;
      trigger(selectEl);
      return true;
    };
    const selectComboboxOption = (valueText) => {
      const target = normalize(valueText);
      const options = [...document.querySelectorAll("[role='option'], li[role='option'], li, .option, [data-value]")];
      const match = options.find((opt) => normalize(opt.innerText || opt.getAttribute("data-value") || "").includes(target));
      if (!match) return false;
      robustClick(match);
      return true;
    };

    const sel = String(a.selector || "").trim();
    const isClick = String(a.type || "").toLowerCase() === "click";
    let el = sel ? document.querySelector(sel) : null;
    if (!el) el = findByHint(a.field || a.label || a.value || a.text || "", isClick);
    if (!el) return { ok: false, reason: "selector_not_found", field: a.field || "", selector: sel };

    const tag = (el.tagName || "").toLowerCase();
    const type = String(a.type || el.type || tag).toLowerCase();
    const value = a.value;
    const choiceText = String(a.choiceText || value || "").trim();
    el.focus();

    if (isClick) {
      robustClick(el);
      return { ok: true, mode: "click", field: a.field || "", selector: sel };
    }
    if (tag === "select" || type === "select") {
      const ok = selectOption(el, choiceText);
      return { ok, mode: "select", field: a.field || "", selector: sel, reason: ok ? "" : "option_not_found" };
    }
    if (type === "checkbox" || el.type === "checkbox") {
      el.checked = toBool(value);
      trigger(el);
      return { ok: true, mode: "checkbox", field: a.field || "", selector: sel };
    }
    if (type === "radio" || el.type === "radio") {
      const name = el.name;
      let chosen = null;
      if (name) {
        const escaped = name.replace(/"/g, '\\"');
        const radios = [...document.querySelectorAll(`input[type="radio"][name="${escaped}"]`)];
        chosen = radios.find((r) => normalize(r.value) === normalize(choiceText));
        if (!chosen) chosen = radios.find((r) => normalize(r.closest("label")?.innerText || "").includes(normalize(choiceText)));
        if (!chosen) chosen = radios[0];
      }
      if (!chosen) return { ok: false, mode: "radio", field: a.field || "", selector: sel, reason: "radio_option_not_found" };
      chosen.checked = true;
      trigger(chosen);
      return { ok: true, mode: "radio", field: a.field || "", selector: sel };
    }
    if (el.isContentEditable || type === "combobox" || el.getAttribute("role") === "combobox") {
      robustClick(el);
      if ("value" in el) {
        setNativeValue(el, value ?? "");
        trigger(el);
      } else {
        el.textContent = String(value ?? "");
        trigger(el);
      }
      const picked = choiceText ? selectComboboxOption(choiceText) : true;
      return { ok: !!picked, mode: "combobox", field: a.field || "", selector: sel, reason: picked ? "" : "combobox_option_not_found" };
    }
    if ("value" in el) {
      setNativeValue(el, value ?? "");
      trigger(el);
      return { ok: true, mode: "value", field: a.field || "", selector: sel };
    }
    return { ok: false, reason: "unsupported_field", field: a.field || "", selector: sel };
  }, [action]);
  return result || { ok: false, reason: "step_execution_failed", field: action.field || "" };
}

async function runAutofillJob(jobId) {
  const job = autofillJobs.get(jobId);
  if (!job || job.status !== "running") return;
  while (job.status === "running" && job.index < job.actions.length) {
    const step = job.actions[job.index];
    const stepResult = await runAutofillStep(job).catch((e) => ({
      ok: false,
      reason: e?.message || "step_failed",
      field: step?.field || ""
    }));
    job.results.push(stepResult);
    job.index += 1;
    job.updatedAt = Date.now();
    await chrome.storage.local.set({ lastAutofillJob: job });

    const type = String(step?.type || "").toLowerCase();
    if (type === "click") {
      await waitForTabComplete(job.tabId, 10000);
      const waitMs = Math.max(0, Math.min(6000, Number(step?.waitMs || step?.afterClickWaitMs || 900)));
      if (waitMs) await sleep(waitMs);
    }
  }
  if (job.status === "running") {
    job.status = "done";
    job.updatedAt = Date.now();
    await chrome.storage.local.set({ lastAutofillJob: job });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.runtime.setUninstallURL('https://atomai.featurebase.app/?source=uninstall');
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!isTrustedSender(sender)) {
    sendResponse({ error: 'Untrusted sender.' });
    return false;
  }

  if (request.type === 'AI_CHAT') {
    (async () => {
      try {
        const text = await ai.chat(request.prompt, request.maxTokens);
        sendResponse({ text });
      } catch (err) {
        await appendDebugLog({
          scope: 'AI_CHAT',
          level: 'error',
          message: err.message || 'AI call failed',
          detail: { promptLength: String(request.prompt || '').length, maxTokens: request.maxTokens || null }
        });
        sendResponse({ error: err.message || 'AI call failed' });
      }
    })();
    return true;
  }

  if (request.type === 'SET_API_KEY') {
    (async () => {
      try {
        sessionApiKey = String(request.apiKey || '').trim();
        await chrome.storage.session.set({ sessionApiKey });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ error: e.message || 'Failed to store API key in session.' });
      }
    })();
    return true;
  }

  if (request.type === 'GET_API_KEY') {
    sendResponse({ apiKey: sessionApiKey || '' });
    return true;
  }

  if (request.type === 'WORKFLOW_GET_STATE') {
    chrome.storage.local.get(['workflowState'], (data) => {
      sendResponse({ state: data.workflowState || { ...DEFAULT_WORKFLOW_STATE } });
    });
    return true;
  }

  if (request.type === 'WORKFLOW_SET_RECORDING') {
    chrome.storage.local.set({
      workflowState: {
        recording: request.recording,
        recordedSteps: [],
        status: request.status,
        tabId: request.tabId ?? null
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  if (request.type === 'WORKFLOW_SAVE_STEPS') {
    chrome.storage.local.get(['workflowState'], (data) => {
      const state = data.workflowState || { ...DEFAULT_WORKFLOW_STATE };
      const steps = Array.isArray(request.steps) ? request.steps : [];
      const next = {
        ...state,
        recording: false,
        tabId: null,
        recordedSteps: steps,
        status: steps.length ? `Recorded ${steps.length} steps.` : 'No steps captured.'
      };
      chrome.storage.local.set({ workflowState: next });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (request.type === 'WORKFLOW_SYNC_STEPS') {
    chrome.storage.local.get(['workflowState'], (data) => {
      const state = data.workflowState || { ...DEFAULT_WORKFLOW_STATE };
      const next = {
        ...state,
        recording: true,
        tabId: request.tabId ?? state.tabId ?? null,
        recordedSteps: Array.isArray(request.steps) ? request.steps : state.recordedSteps,
        status: request.status || state.status || 'Recording...'
      };
      chrome.storage.local.set({ workflowState: next });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (request.type === 'WORKFLOW_CLEAR') {
    chrome.storage.local.set({ workflowState: { ...DEFAULT_WORKFLOW_STATE } });
    sendResponse({ ok: true });
    return true;
  }

  if (request.type === 'AUTOFILL_START') {
    (async () => {
      try {
        const tabId = Number(request.tabId);
        const actions = Array.isArray(request.actions) ? request.actions : [];
        if (!tabId || !actions.length) {
          sendResponse({ error: 'Invalid autofill job payload.' });
          return;
        }
        const jobId = request.jobId || `af_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const job = {
          jobId,
          tabId,
          actions,
          index: 0,
          status: 'running',
          results: [],
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        autofillJobs.set(jobId, job);
        await chrome.storage.local.set({ lastAutofillJob: job });
        runAutofillJob(jobId).catch(async (e) => {
          const failed = autofillJobs.get(jobId);
          if (!failed) return;
          failed.status = 'error';
          failed.error = e?.message || 'Autofill job failed.';
          failed.updatedAt = Date.now();
          await chrome.storage.local.set({ lastAutofillJob: failed });
        });
        sendResponse({ ok: true, jobId });
      } catch (e) {
        sendResponse({ error: e?.message || 'Failed to start autofill job.' });
      }
    })();
    return true;
  }

  if (request.type === 'AUTOFILL_STATUS') {
    (async () => {
      const jobId = String(request.jobId || '');
      if (!jobId) {
        sendResponse({ error: 'jobId is required.' });
        return;
      }
      const memoryJob = autofillJobs.get(jobId);
      if (memoryJob) {
        sendResponse({ job: memoryJob });
        return;
      }
      const data = await chrome.storage.local.get(['lastAutofillJob']);
      const stored = data.lastAutofillJob;
      if (stored?.jobId === jobId) {
        sendResponse({ job: stored });
        return;
      }
      sendResponse({ error: 'Autofill job not found.' });
    })();
    return true;
  }

  if (request.type === 'START_MONITOR_ALARM') {
    chrome.alarms.create('monitor_' + request.monitorId, {
      delayInMinutes: request.intervalMinutes || 60,
      periodInMinutes: request.intervalMinutes || 60
    });
    sendResponse({ ok: true });
    return true;
  }

  if (request.type === 'STOP_MONITOR_ALARM') {
    chrome.alarms.clear('monitor_' + request.monitorId);
    sendResponse({ ok: true });
    return true;
  }

  if (request.type === 'SAVE_REPORT') {
    chrome.storage.local.get(['researchHistory'], (data) => {
      const history = data.researchHistory || [];
      history.unshift({
        id: Date.now(),
        topic: request.payload.topic,
        report: request.payload.report,
        type: request.payload.type || 'company',
        savedAt: request.payload.savedAt || new Date().toLocaleString(),
        url: request.payload.url || '',
        preview: (request.payload.report || '').replace(/[=\n]/g, ' ').substring(0, 120),
        date: Date.now()
      });
      if (history.length > 100) history.pop();
      chrome.storage.local.set({ researchHistory: history });
    });
    sendResponse({ ok: true });
    return true;
  }

  if (request.type === 'GET_USER_SETTINGS') {
    sendResponse({ settings: { ...userSettings, isPro: isProActive() } });
    return true;
  }

  if (request.type === 'SAVE_USER_SETTINGS') {
    userSettings = sanitizeUserSettings(request.settings);
    persistUserSettings().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (request.type === 'VERIFY_LICENSE') {
    (async () => {
      const licenseKey = String(request.licenseKey || '').trim();
      if (!licenseKey) {
        sendResponse({ ok: false, reason: 'License key is required.' });
        return;
      }
      try {
        const res = await fetch('https://atomai.pro/api/license/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ licenseKey, extensionId: chrome.runtime.id })
        });
        const data = await res.json().catch(() => ({}));
        const active = !!data?.active;
        userSettings.licenseKey = licenseKey;
        userSettings.licenseStatus = active ? 'active' : 'inactive';
        userSettings.licenseExpiresAt = Number(data?.expiresAt || 0) || 0;
        userSettings.isPro = active;
        await persistUserSettings();
        sendResponse({ ok: active, reason: active ? '' : (data?.reason || 'License is not active.') });
      } catch (e) {
        await appendDebugLog({
          scope: 'license',
          level: 'error',
          message: e.message || 'License verification failed'
        });
        sendResponse({ ok: false, reason: e.message || 'License verification failed.' });
      }
    })();
    return true;
  }

  if (request.type === 'INCREMENT_CALL_COUNT') {
    enforceQuotaAndIncrement()
      .then((result) => {
        if (!result.allowed) {
          sendResponse({ error: result.reason, count: quotaState.count });
          return;
        }
        sendResponse({ count: quotaState.count });
      })
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (request.type === 'LOG_DEBUG') {
    appendDebugLog({
      scope: request.scope || 'ui',
      level: request.level || 'error',
      message: request.message || '',
      detail: request.detail || null
    }).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (request.type === 'GET_DEBUG_LOG') {
    chrome.storage.local.get(['debugLog'], (data) => {
      sendResponse({ logs: Array.isArray(data.debugLog) ? data.debugLog : [] });
    });
    return true;
  }

  if (request.type === 'CLEAR_DEBUG_LOG') {
    chrome.storage.local.remove(['debugLog']).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  return false;
});
hydrateState().catch(() => {});
