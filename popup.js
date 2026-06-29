import { AI } from './ai.js';
import { Research } from './research.js';
import { Automate } from './automate.js';
import { History } from './history.js';
import { Monitor } from './monitor.js';
import { Settings } from './Settings.js';
import { Notes } from './notes.js';
import { Utils } from './utils.js';

let userSettings = {
  isPro: false,
  model: 'meta/llama-3.1-8b-instruct',
  dailyCallsUsed: 0,
  lastResetDate: '',
  webhookUrl: ''
};

function normalizeModelName(model) {
  const value = String(model || '').trim();
  if (!value) return 'meta/llama-3.1-8b-instruct';
  if (value === 'llama3-1-8b-instant' || value === 'llama-3.1-8b-instant') {
    return 'meta/llama-3.1-8b-instruct';
  }
  return value;
}

async function loadUserSettings() {
  const data = await chrome.storage.local.get(['userSettings']);
  if (data.userSettings) Object.assign(userSettings, data.userSettings);
  userSettings.model = normalizeModelName(userSettings.model);
}

async function ensureInstallId() {
  const data = await chrome.storage.local.get(['installId']).catch(() => ({}));
  if (data?.installId) {
    window.atomInstallId = data.installId;
    return data.installId;
  }
  const next = (crypto?.randomUUID?.() || `atom-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  await chrome.storage.local.set({ installId: next });
  window.atomInstallId = next;
  return next;
}

function currentProvider() {
  return 'proxy';
}

const ai = new AI({
  getApiKey: () => '',
  getModel: () => userSettings.model,
  onCall: async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'INCREMENT_CALL_COUNT' });
      if (res?.error) return { allowed: false, reason: res.error };
      if (typeof res?.count === 'number') userSettings.dailyCallsUsed = res.count;
      updateStatus();
      return true;
    } catch (e) {
      return true;
    }
  }
});

const research = new Research(ai, userSettings);
const automate = new Automate(ai, userSettings);
const history = new History(ai);
const monitor = new Monitor(ai, userSettings);
const settings = new Settings(userSettings, ai);
const notes = new Notes();

let obSelectedProvider = 'nvidia';
let chatPageContext = '';
let chatHistory = [];
window.cancelCurrentTask = false;

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = 'atom-toast';
  toast.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:16px',
    'transform:translateX(-50%)',
    'z-index:99999',
    'padding:9px 14px',
    'border-radius:999px',
    'font-size:12px',
    'font-weight:600',
    'box-shadow:0 8px 24px rgba(0,0,0,0.28)',
    'max-width:340px',
    'text-align:center',
    type === 'error'
      ? 'background:#ff6e8e;color:#fff;'
      : 'background:#4fefd4;color:#04201c;'
  ].join(';');
  toast.innerText = String(message || '');
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

window.showToast = showToast;

function setBusyButton(btn, text = 'Working...') {
  if (!btn) return null;
  if (!btn.dataset.origText) btn.dataset.origText = btn.innerText;
  btn.dataset.busy = '1';
  btn.disabled = true;
  if (text) btn.innerText = text;
  return btn;
}

function clearBusyButton(btn) {
  if (!btn) return;
  if (btn.dataset.origText) btn.innerText = btn.dataset.origText;
  btn.disabled = false;
  delete btn.dataset.busy;
}

window.setBusyButton = setBusyButton;
window.clearBusyButton = clearBusyButton;

function setDotState(dot, state) {
  if (!dot) return;
  dot.className = 'dot';
  if (state === 'ready') dot.classList.add('ok');
  if (state === 'offline') dot.classList.add('err');
}

function updateStatus() {
  const state = 'ready';
  const statusLabel = 'ready';
  const callsUsed = Number(userSettings.dailyCallsUsed || 0);
  const usageText = userSettings.isPro ? 'Unlimited' : `${callsUsed} / 50 free calls today`;

  setDotState(document.getElementById('statusDot'), state);
  setDotState(document.getElementById('statusDot2'), state);
  setDotState(document.getElementById('statusDot3'), state);

  const statusText = document.getElementById('statusText');
  if (statusText) statusText.innerText = statusLabel;
  const callCounter = document.getElementById('callCounter');
  if (callCounter) {
    callCounter.innerText = ` (${userSettings.isPro ? 'Unlimited' : `${callsUsed}/50`})`;
  }
  const providerBadge = document.getElementById('providerBadge');
  if (providerBadge) providerBadge.innerText = `Provider: proxy`;

  const usageBadge = document.getElementById('usageBadge');
  const usageBadgeText = document.getElementById('usageBadgeText');
  if (usageBadge && usageBadgeText) {
    usageBadge.style.display = 'flex';
    usageBadgeText.innerText = usageText;
  }

  const usageBadge2 = document.getElementById('usageBadge2');
  const usageBadgeText2 = document.getElementById('usageBadgeText2');
  if (usageBadge2 && usageBadgeText2) {
    usageBadge2.style.display = 'flex';
    usageBadgeText2.innerText = usageText;
  }

  const providerHint = document.getElementById('settingsProviderHint');
  if (providerHint) {
    providerHint.innerHTML = `Current provider: <strong>proxy</strong>. No API key needed.`;
  }
  toggleAIDependentUI(true);
}

function toggleAIDependentUI(hasKey) {
  const gatedIds = [
    'companyResearch', 'personResearch', 'intelResearch', 'intelMultiTab', 'intelCompare',
    'marketSize', 'marketTrends', 'marketPlayers', 'ask', 'autotask', 'summarize',
    'extracttable', 'chatSend', 'autoFillBtn', 'workflowRecord', 'workflowStop',
    'workflowReplay', 'monitorAdd', 'monitorCheckAll', 'refreshBrief', 'generateBattleCard',
    'compareOpenTabs', 'addCompetitorBtn'
  ];
  gatedIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = !hasKey;
  });

  const banner = document.getElementById('onboardBanner');
  if (banner) {
    if (!hasKey) {
      banner.style.display = 'block';
      const titleEl = banner.querySelector('div');
      const descEl = banner.querySelectorAll('div')[1];
      if (titleEl) titleEl.innerText = 'Setup required';
      if (descEl) descEl.innerText = 'No API key needed — proxy is ready.';
    }
  }
}

async function showScreen(id, options = {}) {
  const persist = options.persist !== false;
  if (id === 'home' || id === 'research' || id === 'automate') id = 'intelligence';
  document.querySelectorAll('.screen').forEach((screen) => screen.classList.remove('active'));
  let target = document.getElementById('screen-' + id);
  if (!target && id !== 'intelligence') {
    target = document.getElementById('screen-intelligence');
  }
  if (target) target.classList.add('active');

  if (persist && id !== 'onboarding') {
    await chrome.storage.local.set({ lastPopupScreen: id });
  }

  if (id === 'chat') {
    await initChat();
  }
  if (id === 'history') {
    await history.loadHistory();
  }
  if (id === 'notes') {
    await notes.load();
  }
  if (id === 'monitor') {
    await monitor.load();
  }
  if (id === 'settings') {
    await settings.load();
    updateStatus();
  }
  if (id === 'intelligence') {
    const advancedTools = document.querySelector('details.advanced-tools');
    if (advancedTools && !options.keepAdvancedOpen) advancedTools.open = false;
  }
}

async function openAutomateSection(sectionId = '', runButtonId = '') {
  await showScreen('intelligence', { keepAdvancedOpen: true });
  const advancedTools = document.querySelector('details.advanced-tools');
  if (advancedTools) advancedTools.open = true;
  if (sectionId) document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (runButtonId) setTimeout(() => document.getElementById(runButtonId)?.click(), 50);
}

function updateOnboardingDots(step) {
  const dot1 = document.getElementById('ob-step1-dot');
  const dot2 = document.getElementById('ob-step2-dot');
  if (dot1) dot1.style.background = step === 1 ? 'var(--p)' : 'var(--b2)';
  if (dot2) dot2.style.background = step === 2 ? 'var(--p)' : 'var(--b2)';
}

function obSelectProvider(provider) {
  obSelectedProvider = provider;
  const nv = document.getElementById('ob-choose-nvidia');
  const gr = document.getElementById('ob-choose-groq');
  if (nv) nv.style.borderColor = provider === 'nvidia' ? 'var(--p)' : 'var(--b2)';
  if (gr) gr.style.borderColor = provider === 'groq' ? 'var(--p)' : 'var(--b2)';
}

function setOnboardingStep(step) {
  const step1 = document.getElementById('ob-step1');
  const step2 = document.getElementById('ob-step2');
  const label = document.getElementById('ob-provider-label');
  const link = document.getElementById('ob-get-key-link');
  const input = document.getElementById('ob-api-key');

  if (step1) step1.style.display = step === 1 ? 'block' : 'none';
  if (step2) step2.style.display = step === 2 ? 'block' : 'none';
  updateOnboardingDots(step);

  if (step === 2) {
    if (obSelectedProvider === 'groq') {
      if (label) label.innerText = 'Paste your Groq API key';
      if (link) {
        link.href = 'https://console.groq.com/keys';
        link.innerText = '? Get free Groq key';
      }
      if (input) input.placeholder = 'gsk_...';
    } else {
      if (label) label.innerText = 'Paste your NVIDIA API key';
      if (link) {
        link.href = 'https://build.nvidia.com/explore/discover';
        link.innerText = '? Get free NVIDIA key';
      }
      if (input) input.placeholder = 'nvapi-...';
    }
  }
}

async function openOnboarding() {
  obSelectProvider(currentProvider());
  setOnboardingStep(1);
  await showScreen('onboarding', { persist: false });
}

async function obVerify() {
  // Backend-proxy mode: no user API key needed
  // Just verify the backend is reachable and mark onboarding done
  const btn = document.getElementById('ob-verify-btn');
  const verifying = document.getElementById('ob-verifying');
  const err = document.getElementById('ob-key-error');

  if (verifying) verifying.style.display = 'block';
  if (btn) btn.disabled = true;

  try {
    // Quick backend health check
    const endpoints = [
      'https://atom-ai-eight.vercel.app/api/chat',
      'https://atom-ai.vercel.app/api/chat'
    ];

    let backendOk = false;
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Extension-Id': chrome.runtime.id
          },
          body: JSON.stringify({
            model: 'meta/llama-3.1-8b-instruct',
            max_tokens: 5,
            messages: [{ role: 'user', content: 'hi' }]
          })
        });
        if (res.ok || res.status === 401) { // 401 means backend received it but key issue
          backendOk = true;
          break;
        }
      } catch (e) {
        // Try next endpoint
      }
    }

    await chrome.storage.local.set({
      onboardingDone: true,
      lastPopupScreen: 'intelligence'
    });
    updateStatus();
    await showScreen('intelligence');

  } catch (error) {
    if (err) {
      err.style.display = 'block';
      err.innerText = 'Unable to connect to backend. Please try again later.';
    }
  } finally {
    if (verifying) verifying.style.display = 'none';
    if (btn) btn.disabled = false;
  }
}

async function obSkip() {
  await chrome.storage.local.set({ onboardingDone: true, lastPopupScreen: 'intelligence' });
  updateStatus();
  await showScreen('intelligence');
}

async function initChat() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chatPageContext = tab ? await Utils.getPageText(tab.id) : '';
  } catch {
    chatPageContext = '';
  }
}

function renderChatHistory() {
  const box = document.getElementById('chatBox');
  if (!box) return;

  box.innerHTML = '';
  if (!chatHistory.length) {
    const empty = document.createElement('div');
    empty.className = 'cmsg ai';
    empty.innerText = 'I have read this page. Ask me anything about the content.';
    box.appendChild(empty);
    return;
  }

  chatHistory.forEach((message) => {
    const node = document.createElement('div');
    node.className = 'cmsg ' + (message.role === 'user' ? 'user' : 'ai');
    node.innerText = message.content;
    box.appendChild(node);
  });
  box.scrollTop = box.scrollHeight;
}

async function addChatMsg(role, text) {
  const mappedRole = role === 'user' ? 'user' : 'assistant';
  chatHistory.push({ role: mappedRole, content: text });
  await chrome.storage.local.set({ chatHistory: chatHistory.slice(-20) });
  if (chatHistory.length > 20) {
    chatHistory = chatHistory.slice(-20);
  }
  renderChatHistory();
}

async function sendChat() {
  const input = document.getElementById('chatInput');
  const btn = document.getElementById('chatSend');
  const q = input?.value.trim();
  if (!q) return;

  input.value = '';
  if (!chatPageContext) await initChat();
  await addChatMsg('user', q);

  setBusyButton(btn, 'Working...');

  try {
    const messages = [
      {
        role: 'system',
        content: `Answer questions about this webpage concisely and professionally:\n\n${(chatPageContext || '').substring(0, 4000)}`
      },
      ...chatHistory.slice(-6)
    ];
    const reply = await ai.chatWithMessages(messages);
    await addChatMsg('ai', reply);
  } catch (error) {
    await addChatMsg('ai', `Error: ${error.message || 'Chat failed.'}`);
  } finally {
    clearBusyButton(btn);
  }
}

async function clearChat() {
  chatHistory = [];
  await chrome.storage.local.remove('chatHistory');
  await initChat();
  renderChatHistory();
}

function saveBattleUrls() {
  const urls = Array.from(document.querySelectorAll('.battle-url')).map(i => i.value.trim());
  chrome.storage.local.set({ battleUrls: urls });
}

async function runBattleCardAndSave() {
  window.cancelCurrentTask = false;
  const busyButtons = [
    document.getElementById('generateBattleCard'),
    document.getElementById('compareOpenTabs')
  ];
  busyButtons.forEach((btn) => setBusyButton(btn, 'Working...'));

  try {
    await research.runBattleCard({ installId: window.atomInstallId });
  } catch (error) {
    showToast(error?.message || 'Battle card failed.', 'error');
  } finally {
    busyButtons.forEach((btn) => clearBusyButton(btn));
  }
}

function bindNavigation() {
  document.getElementById('goIntelligence')?.addEventListener('click', () => { void showScreen('intelligence'); });
  document.getElementById('goChat')?.addEventListener('click', () => { void showScreen('chat'); });
  document.getElementById('goHistory')?.addEventListener('click', () => { void showScreen('history'); });
  document.getElementById('goNotes')?.addEventListener('click', () => { void showScreen('notes'); });
  document.getElementById('goMonitor')?.addEventListener('click', () => { void showScreen('monitor'); });
  document.getElementById('goSettings')?.addEventListener('click', () => { void showScreen('settings'); });
  document.getElementById('upgradeBtn')?.addEventListener('click', () => { void openProModal(); });
  document.getElementById('upgradeBtnSettings')?.addEventListener('click', () => { void openProModal(); });
  document.getElementById('cancelTask')?.addEventListener('click', () => {
    window.cancelCurrentTask = true;
    resetUIAfterCancel();
  });

  document.getElementById('battleInputs')?.addEventListener('input', () => {
    saveBattleUrls();
  });

  document.getElementById('compareOpenTabs')?.addEventListener('click', () => { void compareOpenTabs(); });
  document.getElementById('addCompetitorBtn')?.addEventListener('click', () => { addCompetitorInput(); });
  document.getElementById('generateBattleCard')?.addEventListener('click', async () => {
      await runBattleCardAndSave();
  });
  document.getElementById('battleInputs')?.addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-dir]');
    if (!btn) return;
    const row = btn.closest('.battle-input-row');
    if (!row) return;
    moveBattleRow(row, btn.dataset.dir);
  });

  document.getElementById('backFromIntelligence')?.addEventListener('click', () => { void showScreen('intelligence'); });
  document.getElementById('backFromChat')?.addEventListener('click', () => { void showScreen('intelligence'); });
  document.getElementById('backFromHistory')?.addEventListener('click', () => { void showScreen('intelligence'); });
  document.getElementById('backFromNotes')?.addEventListener('click', () => { void showScreen('intelligence'); });
  document.getElementById('backFromMonitor')?.addEventListener('click', () => { void showScreen('intelligence'); });
  document.getElementById('backFromSettings')?.addEventListener('click', () => { void showScreen('intelligence'); });

  document.getElementById('onboardClose')?.addEventListener('click', async () => {
    const banner = document.getElementById('onboardBanner');
    if (banner) banner.style.display = 'none';
    await chrome.storage.local.set({ onboardDismissed: true });
  });

  document.getElementById('ob-choose-nvidia')?.addEventListener('click', () => obSelectProvider('nvidia'));
  document.getElementById('ob-choose-groq')?.addEventListener('click', () => obSelectProvider('groq'));
  document.getElementById('ob-next-btn')?.addEventListener('click', () => setOnboardingStep(2));
  document.getElementById('ob-back-btn')?.addEventListener('click', () => setOnboardingStep(1));
  document.getElementById('ob-verify-btn')?.addEventListener('click', () => { void obVerify(); });
  document.getElementById('ob-skip-btn')?.addEventListener('click', () => { void obSkip(); });
  document.getElementById('changeApiSetupBtn')?.addEventListener('click', () => { void openOnboarding(); });
  document.getElementById('ob-api-key')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void obVerify();
    }
  });

  document.getElementById('chatSend')?.addEventListener('click', () => { void sendChat(); });
  document.getElementById('chatClear')?.addEventListener('click', () => { void clearChat(); });
  document.getElementById('chatInput')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendChat();
    }
  });

  document.getElementById('exportAllDataBtn')?.addEventListener('click', () => {
    void exportAllData();
  });
  document.getElementById('importAllDataBtn')?.addEventListener('click', () => {
    document.getElementById('importAllDataFile')?.click();
  });
  document.getElementById('importAllDataFile')?.addEventListener('change', (event) => {
    void importAllData(event);
  });
  document.getElementById('copyDebugLogBtn')?.addEventListener('click', async () => {
    const text = document.getElementById('debugLogBox')?.innerText || '';
    if (!text.trim()) return;
    await navigator.clipboard.writeText(text);
  });
  document.getElementById('clearResult')?.addEventListener('click', () => {
    const resultEl = document.getElementById('globalResult') || document.getElementById('result');
    if (resultEl) {
      resultEl.style.display = 'none';
      resultEl.innerText = '';
    }
    const actionBar = document.querySelector('.report-action-bar');
    if (actionBar) actionBar.remove();
    chrome.storage.local.remove(['lastBattleResult', 'lastBattleTime', 'lastBattleUrls']).catch(() => {});
  });
  document.getElementById('proModalClose')?.addEventListener('click', () => {
    const modal = document.getElementById('proModal');
    if (modal) modal.style.display = 'none';
  });
}

async function openProModal() {
  const modal = document.getElementById('proModal');
  if (modal) modal.style.display = 'flex';
  const saved = await chrome.storage.local.get(['proNotifyEmail']).catch(() => ({}));
  const emailInput = document.getElementById('proEmailInput');
  if (emailInput && saved?.proNotifyEmail) emailInput.value = saved.proNotifyEmail;
}

function resetUIAfterCancel() {
  document.querySelectorAll('[data-busy="1"]').forEach((btn) => clearBusyButton(btn));
  [
    'companyResearch', 'personResearch', 'intelResearch', 'intelMultiTab', 'intelCompare',
    'marketSize', 'marketTrends', 'marketPlayers', 'generateBattleCard', 'compareOpenTabs',
    'ask', 'autotask', 'summarize', 'chatSend', 'extracttable', 'autoFillBtn',
    'workflowRecord', 'workflowReplay', 'monitorAdd', 'monitorCheckAll', 'refreshBrief'
  ].forEach((id) => clearBusyButton(document.getElementById(id)));

  const progressPanel = document.getElementById('researchProgress');
  if (progressPanel) progressPanel.style.display = 'none';
  
  const loader = document.getElementById('loader');
  if (loader) loader.style.display = 'none';
  
  const cancelBtn = document.getElementById('cancelTask');
  if (cancelBtn) cancelBtn.style.display = 'none';
  
  window.cancelCurrentTask = false;
  showToast('Task canceled.', 'info');
}

function renumberBattleRows() {
  const rows = Array.from(document.querySelectorAll('#battleInputs .battle-input-row'));
  rows.forEach((row, index) => {
    row.dataset.battleIndex = String(index);
    const input = row.querySelector('input');
    if (input) {
      input.id = `battleUrl${index + 1}`;
      input.placeholder = `Competitor ${index + 1} URL`;
    }
    const up = row.querySelector('.battle-up');
    const down = row.querySelector('.battle-down');
    if (up) up.disabled = index === 0;
    if (down) down.disabled = index === rows.length - 1;
  });
}

function createBattleRow(index, value = '') {
  const row = document.createElement('div');
  row.className = 'battle-input-row';
  row.dataset.battleIndex = String(index);
  row.style.cssText = 'display:flex;gap:6px;align-items:center;';
  row.innerHTML = `
    <input class="battle-url" placeholder="Competitor ${index + 1} URL" value="${String(value).replace(/"/g, '&quot;')}">
    <div class="battle-move" style="display:flex;gap:4px;">
      <button class="btn bsm battle-up" title="Move competitor up" data-dir="up">↑</button>
      <button class="btn bsm battle-down" title="Move competitor down" data-dir="down">↓</button>
    </div>
  `;
  return row;
}

function addCompetitorInput(value = '') {
  const stack = document.getElementById('battleInputs');
  if (!stack) return;
  const rows = stack.querySelectorAll('.battle-input-row');
  if (rows.length >= 5) return;
  const row = createBattleRow(rows.length, value);
  stack.appendChild(row);
  renumberBattleRows();
  saveBattleUrls();
}

function moveBattleRow(row, dir) {
  const stack = document.getElementById('battleInputs');
  if (!stack || !row) return;
  const rows = Array.from(stack.querySelectorAll('.battle-input-row'));
  const index = rows.indexOf(row);
  if (index === -1) return;
  if (dir === 'up' && index > 0) {
    stack.insertBefore(row, rows[index - 1]);
  } else if (dir === 'down' && index < rows.length - 1) {
    stack.insertBefore(rows[index + 1], row);
  }
  renumberBattleRows();
  saveBattleUrls();
}

async function compareOpenTabs() {
  const tabs = await Utils.getReadableTabs({ currentWindow: true, maxTabs: 5 });
  const urls = tabs.map((tab) => tab.url).filter((url) => /^https?:\/\//i.test(url || ''));
  if (urls.length < 2) {
    showToast('Open at least 2 normal websites (not Chrome internal pages) to compare.', 'error');
    return;
  }

  const stack = document.getElementById('battleInputs');
  if (stack) {
    while (stack.querySelectorAll('.battle-input-row').length < Math.min(urls.length, 5)) {
      addCompetitorInput();
    }
  }
  const inputs = Array.from(document.querySelectorAll('.battle-url'));
  inputs.forEach((input, index) => {
    input.value = urls[index] || '';
  });
  saveBattleUrls();
  await runBattleCardAndSave();
}

async function exportAllData() {
  const [localData, sessionData] = await Promise.all([
    chrome.storage.local.get(null),
    chrome.storage.session.get(null).catch(() => ({}))
  ]);
  const allData = {
    ...localData,
    sessionStorage: sessionData || {}
  };
  const blob = new Blob([JSON.stringify(allData, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `atom-ai-backup-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importAllData(event) {
  const file = event.target?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object') throw new Error('Invalid backup file.');
    await chrome.storage.local.set(data);
    await loadUserSettings();
    updateStatus();
    await restoreInitialState();
  } catch (e) {
    showToast('Import failed: ' + e.message, 'error');
  } finally {
    event.target.value = '';
  }
}

async function restoreBattleUrls(savedUrls) {
  if (!Array.isArray(savedUrls) || !savedUrls.length) return;
  const nonEmpty = savedUrls.filter(u => u && u.trim());
  if (!nonEmpty.length) return;
  await new Promise(resolve => setTimeout(resolve, 100));
  const stack = document.getElementById('battleInputs');
  if (!stack) return;
  while (stack.querySelectorAll('.battle-input-row').length < Math.min(nonEmpty.length, 5)) {
    addCompetitorInput();
  }
  renumberBattleRows();
  const inputs = Array.from(stack.querySelectorAll('.battle-url'));
  nonEmpty.forEach((url, i) => {
    if (inputs[i]) inputs[i].value = url;
  });
}

async function restoreInitialState() {
  const data = await chrome.storage.local.get([
    'chatHistory',
    'onboardDismissed',
    'lastPopupScreen',
    'battleUrls',
    'lastBattleResult',
    'lastBattleTime',
    'researchThisUrl',
    'researchThisTitle'
  ]);
  chatHistory = Array.isArray(data.chatHistory) ? data.chatHistory : [];
  renderChatHistory();

  if (data.onboardDismissed) {
    const banner = document.getElementById('onboardBanner');
    if (banner) banner.style.display = 'none';
  }

  updateStatus();

  await showScreen('intelligence');
  renumberBattleRows();
  await restoreBattleUrls(data.battleUrls);

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && Utils.isInjectableTab(activeTab) && Utils.isReadableHttpUrl(activeTab.url)) {
      const firstInput = document.querySelector('.battle-url');
      if (firstInput && !firstInput.value.trim()) {
        firstInput.value = activeTab.url;
        saveBattleUrls();
      }
    }
  } catch (e) {}

  const age = Date.now() - Number(data.lastBattleTime || 0);
  if (data.lastBattleResult && age < 86400000) {
    const resultPanel = document.getElementById('globalResult');
    if (resultPanel) {
      resultPanel.style.display = 'block';
      resultPanel.innerText = data.lastBattleResult;
      research.attachBattleActions(data.lastBattleResult);
    }
  } else if (data.lastBattleResult) {
    chrome.storage.local.remove(['lastBattleResult', 'lastBattleTime', 'lastBattleUrls']).catch(() => {});
  }

  if (data.researchThisUrl) {
    const queuedUrl = data.researchThisUrl;
    await chrome.storage.local.remove(['researchThisUrl', 'researchThisTitle']).catch(() => {});
    const companyInput = document.getElementById('companyName');
    if (companyInput && !companyInput.value.trim()) companyInput.value = queuedUrl;
    const battleInput = document.querySelector('.battle-url');
    if (battleInput && !battleInput.value.trim()) battleInput.value = queuedUrl;
    saveBattleUrls();
    setTimeout(() => document.getElementById('companyResearch')?.click(), 150);
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes.userSettings?.newValue) {
    Object.assign(userSettings, changes.userSettings.newValue);
    updateStatus();
  }
  if (changes.chatHistory) {
    chatHistory = Array.isArray(changes.chatHistory.newValue) ? changes.chatHistory.newValue : [];
    renderChatHistory();
  }
});

window.addEventListener('error', (event) => {
  console.error(event.error || event.message || event);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error(event.reason || event);
});

async function bootstrap() {
  try {
    await loadUserSettings();
  } catch (error) {
    console.error('loadUserSettings failed', error);
  }

  try {
    await ensureInstallId();
  } catch (error) {
    console.error('ensureInstallId failed', error);
    window.atomInstallId = window.atomInstallId || `atom-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  research.installId = window.atomInstallId;
  automate.installId = window.atomInstallId;
  bindNavigation();

  try {
    await restoreInitialState();
  } catch (error) {
    console.error('restoreInitialState failed', error);
    await showScreen('intelligence', { persist: false });
  }
}

void bootstrap();
