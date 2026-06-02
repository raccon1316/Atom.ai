import { Utils } from './utils.js';

// settings.js
export class Settings {
  constructor(userSettings, ai) {
    this.userSettings = userSettings;
    this.ai = ai;
    this.initEventListeners();
  }

  async load() {
    const [data, sessionRes] = await Promise.all([
      chrome.storage.local.get(["userSettings"]),
      chrome.runtime.sendMessage({ type: "GET_API_KEY" }).catch(() => ({ apiKey: "" }))
    ]);
    if (data.userSettings) Object.assign(this.userSettings, data.userSettings);
    this.userSettings.apiKey = sessionRes?.apiKey || "";

    const keyInput   = document.getElementById("settingsApiKey");
    const modelSel   = document.getElementById("settingsModel");
    const webhookIn  = document.getElementById("settingsWebhook");
    const proStatus  = document.getElementById("proStatus");
    const usageBar   = document.getElementById("usageBar");
    const usageText  = document.getElementById("usageText");

    if (keyInput)  keyInput.value  = this.userSettings.apiKey || "";
    if (modelSel)  modelSel.value  = this.userSettings.model  || "meta/llama-3.1-8b-instruct";
    if (webhookIn) webhookIn.value = this.userSettings.webhookUrl || "";

    const limit = this.userSettings.isPro ? 999 : 20;
    const used  = this.userSettings.dailyCallsUsed || 0;
    const pct   = Math.min(100, (used / limit) * 100);

    if (usageBar)  usageBar.style.width = pct + "%";
    if (usageText) usageText.innerText  = this.userSettings.isPro
      ? "Pro — unlimited calls"
      : `${used} / ${limit} free calls today`;

    if (proStatus) proStatus.innerHTML = this.userSettings.isPro
      ? '<span class="pro-badge">✦ PRO</span>'
      : 'Free Plan';
    await this.refreshDebugLog();
  }

  async save() {
    const key     = document.getElementById("settingsApiKey")?.value.trim();
    const model   = document.getElementById("settingsModel")?.value;
    const webhook = document.getElementById("settingsWebhook")?.value.trim();

    this.userSettings.apiKey = key ?? "";
    this.userSettings.model = model || "meta/llama-3.1-8b-instruct";
    this.userSettings.webhookUrl = webhook ?? "";

    await chrome.runtime.sendMessage({ type: "SET_API_KEY", apiKey: this.userSettings.apiKey });
    await chrome.runtime.sendMessage({ type: "SAVE_USER_SETTINGS", settings: this.userSettings });

    const btn = document.getElementById("saveSettingsBtn");
    if (btn) {
      const orig = btn.innerText;
      btn.innerText = "✅ Saved!";
      setTimeout(() => btn.innerText = orig, 1500);
    }
  }

  showProModal() {
    window.open("https://forms.gle/6Z9xQfV5WfSxw7AA6", "_blank");
  }

  initEventListeners() {
    document.getElementById("saveSettingsBtn")?.addEventListener("click", () => this.save());
    document.getElementById("upgradeBtn")?.addEventListener("click", () => this.showProModal());
    document.getElementById("refreshDebugLogBtn")?.addEventListener("click", () => this.refreshDebugLog());
    document.getElementById("clearDebugLogBtn")?.addEventListener("click", () => this.clearDebugLog());
    document.getElementById("proModalClose")?.addEventListener("click", () => {
      const m = document.getElementById("proModal");
      if (m) m.style.display = "none";
    });

    // Wire settings screen navigation
    document.getElementById("goSettings")?.addEventListener("click", () => this.load());
  }

  async refreshDebugLog() {
    const box = document.getElementById("debugLogBox");
    if (!box) return;
    const res = await chrome.storage.local.get(["debugLogs"]);
    const logs = Array.isArray(res?.debugLogs) ? res.debugLogs : [];
    if (!logs.length) {
      box.innerText = "No debug logs yet.";
      return;
    }
    box.innerText = logs.slice(0, 60).map((item) => {
      const ts = item.ts || "";
      const scope = item.scope || "general";
      const level = item.level || "error";
      const msg = item.message || "";
      return `[${ts}] [${scope}] [${level}] ${msg}`;
    }).join("\n");
  }

  async clearDebugLog() {
    await chrome.storage.local.set({ debugLogs: [] });
    const box = document.getElementById("debugLogBox");
    if (box) box.innerText = "Debug log cleared.";
    await Utils.writeDebugLog("Debug log cleared", "info");
  }
}
