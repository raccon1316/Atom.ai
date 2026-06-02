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
  apiKey: '',
  model: 'meta/llama-3.1-8b-instruct',
  dailyCallsUsed: 0,
  lastResetDate: '',
  webhookUrl: ''
};

async function loadUserSettings() {
  const [data, sessionRes] = await Promise.all([
    chrome.storage.local.get(['userSettings']),
    chrome.runtime.sendMessage({ type: 'GET_API_KEY' }).catch(() => ({ apiKey: '' }))
  ]);
  if (data.userSettings) Object.assign(userSettings, data.userSettings);
  userSettings.apiKey = sessionRes?.apiKey || '';
}

function currentProvider() {
  if ((userSettings.apiKey || '').startsWith('gsk_') || (userSettings.model || '').startsWith('llama3-')) {
    return 'groq';
  }
  return 'nvidia';
}

const ai = new AI({
  getApiKey: () => userSettings.apiKey,
  getModel: () => userSettings.model,
  onCall: async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'INCREMENT_CALL_COUNT' });
      if (res?.error) return false;
      if (typeof res?.count === 'number') userSettings.dailyCallsUsed = res.count;
      return true;
    } catch (e) {
      return false;
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

function setDotState(dot, state) {
  if (!dot) return;
  dot.className = 'dot';
  if (state === 'ready') dot.classList.add('ok');
  if (state === 'offline') dot.classList.add('err');
}

function updateStatus() {
  const hasKey = Boolean((userSettings.apiKey || '').trim());
  const state = hasKey ? 'ready' : 'offline';
  const text = hasKey ? 'ready' : 'setup';
  const provider = currentProvider() === 'groq' ? 'Groq' : 'NVIDIA';

  setDotState(document.getElementById('statusDot'), state);
  setDotState(document.getElementById('statusDot2'), state);
  setDotState(document.getElementById('statusDot3'), state);

  const statusText = document.getElementById('statusText');
  if (statusText) statusText.innerText = text;
  const callCounter = document.getElementById('callCounter');
  if (callCounter) {
    const limitLabel = userSettings.isPro ? 'unlimited' : '20';
    callCounter.innerText = ` (${userSettings.dailyCallsUsed || 0}/${limitLabel})`;
  }
  const providerBadge = document.getElementById('providerBadge');
  if (providerBadge) providerBadge.innerText = `Provider: ${provider}`;

  const providerHint = document.getElementById('settingsProviderHint');
  if (providerHint) {
    const keyLink = currentProvider() === 'groq'
      ? '<a href="https://console.groq.com/keys" target="_blank" style="color:var(--p);">Get free key ?</a>'
      : '<a href="https://build.nvidia.com/explore/discover" target="_blank" style="color:var(--p);">Get free key ?</a>';
    providerHint.innerHTML = hasKey
      ? `Current provider: <strong>${provider}</strong>. ${keyLink}`
      : `No API key saved yet. ${keyLink}`;
  }
  toggleAIDependentUI(hasKey);
}

function toggleAIDependentUI(hasKey) {
  const gatedIds = [
    'companyResearch', 'personResearch', 'intelResearch', 'intelMultiTab', 'intelCompare',
    'marketSize', 'marketTrends', 'marketPlayers', 'ask', 'autotask', 'summarize',
    'extracttable', 'readAllTabsBtn', 'chatSend'
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
      if (descEl) descEl.innerText = 'Add your API key in Settings to enable Research, Automate, and Chat.';
    }
  }
}

async function showScreen(id, options = {}) {
  const persist = options.persist !== false;
  document.querySelectorAll('.screen').forEach((screen) => screen.classList.remove('active'));
  const target = document.getElementById('screen-' + id);
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
  const key = document.getElementById('ob-api-key')?.value.trim() || '';
  const err = document.getElementById('ob-key-error');
  const verifying = document.getElementById('ob-verifying');
  const btn = document.getElementById('ob-verify-btn');

  if (!key) {
    if (err) {
      err.style.display = 'block';
      err.innerText = 'Please paste your API key first.';
    }
    return;
  }

  const isNvidia = key.startsWith('nvapi-');
  const isGroq = key.startsWith('gsk_');
  if (!isNvidia && !isGroq) {
    if (err) {
      err.style.display = 'block';
      err.innerText = 'Invalid key. NVIDIA keys start with nvapi-, Groq keys start with gsk_';
    }
    return;
  }

  if (err) err.style.display = 'none';
  if (verifying) verifying.style.display = 'block';
  if (btn) btn.disabled = true;

  const endpoint = isGroq
    ? 'https://api.groq.com/openai/v1/chat/completions'
    : 'https://integrate.api.nvidia.com/v1/chat/completions';
  const model = isGroq ? 'llama3-8b-8192' : 'meta/llama-3.1-8b-instruct';

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }]
      })
    });

    const data = await res.json().catch(() => ({}));
    const message = data?.choices?.[0]?.message?.content;
    const errorText = data?.error?.message || `Request failed (${res.status})`;

    if (!res.ok || !message) {
      throw new Error(errorText);
    }

    userSettings.apiKey = key;
    userSettings.model = model;
    await chrome.runtime.sendMessage({ type: 'SET_API_KEY', apiKey: key });
    await chrome.runtime.sendMessage({ type: 'SAVE_USER_SETTINGS', settings: userSettings });
    await chrome.storage.local.set({ onboardingDone: true, lastPopupScreen: 'home' });
    updateStatus();
    await showScreen('home');
  } catch (error) {
    if (err) {
      err.style.display = 'block';
      err.innerText = error.message || 'Unable to verify this API key.';
    }
  } finally {
    if (verifying) verifying.style.display = 'none';
    if (btn) btn.disabled = false;
  }
}

async function obSkip() {
  await chrome.storage.local.set({ onboardingDone: true, lastPopupScreen: 'home' });
  updateStatus();
  await showScreen('home');
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
  if (!userSettings.apiKey) {
    await addChatMsg('ai', 'Add your API key in Settings before using chat.');
    return;
  }
  const input = document.getElementById('chatInput');
  const q = input?.value.trim();
  if (!q) return;

  input.value = '';
  if (!chatPageContext) await initChat();
  await addChatMsg('user', q);

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
  }
}

async function clearChat() {
  chatHistory = [];
  await chrome.storage.local.remove('chatHistory');
  await initChat();
  renderChatHistory();
}

function bindNavigation() {
  document.getElementById('goResearch')?.addEventListener('click', () => { void showScreen('research'); });
  document.getElementById('goAutomate')?.addEventListener('click', () => { void showScreen('automate'); });
  document.getElementById('goChat')?.addEventListener('click', () => { void showScreen('chat'); });
  document.getElementById('goHistory')?.addEventListener('click', () => { void showScreen('history'); });
  document.getElementById('goNotes')?.addEventListener('click', () => { void showScreen('notes'); });
  document.getElementById('goMonitor')?.addEventListener('click', () => { void showScreen('monitor'); });
  document.getElementById('goSettings')?.addEventListener('click', () => { void showScreen('settings'); });
  document.getElementById('moreBtn')?.addEventListener('click', () => {
    const moreMenu = document.getElementById('moreMenu');
    if (moreMenu) moreMenu.style.display = moreMenu.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('moreChatBtn')?.addEventListener('click', () => { void showScreen('chat'); });
  document.getElementById('moreNotesBtn')?.addEventListener('click', () => { void showScreen('notes'); });
  document.getElementById('moreMonitorBtn')?.addEventListener('click', () => { void showScreen('monitor'); });

  document.getElementById('backFromResearch')?.addEventListener('click', () => { void showScreen('home'); });
  document.getElementById('backFromAutomate')?.addEventListener('click', () => { void showScreen('home'); });
  document.getElementById('backFromChat')?.addEventListener('click', () => { void showScreen('home'); });
  document.getElementById('backFromHistory')?.addEventListener('click', () => { void showScreen('home'); });
  document.getElementById('backFromNotes')?.addEventListener('click', () => { void showScreen('home'); });
  document.getElementById('backFromMonitor')?.addEventListener('click', () => { void showScreen('home'); });
  document.getElementById('backFromSettings')?.addEventListener('click', () => { void showScreen('home'); });

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
}

async function exportAllData() {
  const allData = await chrome.storage.local.get(null);
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
    alert('Import failed: ' + e.message);
  } finally {
    event.target.value = '';
  }
}

async function restoreInitialState() {
  const data = await chrome.storage.local.get(['chatHistory', 'onboardDismissed', 'onboardingDone', 'lastPopupScreen']);
  chatHistory = Array.isArray(data.chatHistory) ? data.chatHistory : [];
  renderChatHistory();

  if (data.onboardDismissed) {
    const banner = document.getElementById('onboardBanner');
    if (banner) banner.style.display = 'none';
  }

  updateStatus();

  if (!data.onboardingDone) {
    await openOnboarding();
    return;
  }

  const screen = data.lastPopupScreen && data.lastPopupScreen !== 'onboarding'
    ? data.lastPopupScreen
    : 'home';
  await showScreen(screen);
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

await loadUserSettings();
bindNavigation();
await restoreInitialState();
