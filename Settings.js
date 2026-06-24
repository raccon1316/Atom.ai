import { Utils } from './utils.js';

// settings.js
export class Settings {
  constructor(userSettings, ai) {
    this.userSettings = userSettings;
    this.ai = ai;
    this.initEventListeners();
  }

  async load() {
    const data = await chrome.storage.local.get(["userSettings"]);
    if (data.userSettings) Object.assign(this.userSettings, data.userSettings);

    const webhookIn = document.getElementById("settingsWebhook");
    const proStatus = document.getElementById("proStatus");
    const usageBar  = document.getElementById("usageBar");
    const usageText = document.getElementById("usageText");

    if (webhookIn) webhookIn.value = this.userSettings.webhookUrl || "";

    const limit = this.userSettings.isPro ? 999 : 50;
    const used  = this.userSettings.dailyCallsUsed || 0;
    const pct   = Math.min(100, (used / limit) * 100);

    if (usageBar)  usageBar.style.width = pct + "%";
    if (usageText) usageText.innerText = this.userSettings.isPro
      ? "Pro — unlimited calls"
      : `${used} / ${limit} free calls today`;

    if (proStatus) proStatus.innerHTML = this.userSettings.isPro
      ? '<span class="pro-badge">✦ PRO</span>'
      : 'Free Plan';

    await this.refreshDebugLog();
  }

  async save() {
    const webhook = document.getElementById("settingsWebhook")?.value.trim();
    this.userSettings.webhookUrl = webhook ?? "";
    await chrome.runtime.sendMessage({ type: "SAVE_USER_SETTINGS", settings: this.userSettings });

    const btn = document.getElementById("saveSettingsBtn");
    if (btn) {
      const orig = btn.innerText;
      btn.innerText = "✅ Saved!";
      setTimeout(() => btn.innerText = orig, 1500);
    }
  }

  showProModal() {
    const modal = document.getElementById("proModal");
    if (modal) modal.style.display = "flex";
    chrome.storage.local.get(["proNotifyEmail"]).then((data) => {
      const emailInput = document.getElementById("proEmailInput");
      if (emailInput && data?.proNotifyEmail) emailInput.value = data.proNotifyEmail;
    }).catch(() => {});
  }

  initEventListeners() {
    document.getElementById("saveSettingsBtn")?.addEventListener("click", () => this.save());
    document.getElementById("upgradeBtn")?.addEventListener("click", () => this.showProModal());
    document.getElementById("resetExtensionBtn")?.addEventListener("click", () => this.resetExtension());
    document.getElementById("refreshDebugLogBtn")?.addEventListener("click", () => this.refreshDebugLog());
    document.getElementById("clearDebugLogBtn")?.addEventListener("click", () => this.clearDebugLog());
    document.getElementById("proModalClose")?.addEventListener("click", () => {
      const m = document.getElementById("proModal");
      if (m) m.style.display = "none";
    });
    document.getElementById("proNotifyBtn")?.addEventListener("click", () => this.handleProNotify());

    // Wire settings screen navigation
    document.getElementById("goSettings")?.addEventListener("click", () => this.load());
  }

  async resetExtension() {
    if (!confirm("This will erase all settings, notes, history, and data. Continue?")) return;
    await chrome.storage.local.clear();
    await chrome.storage.session.clear().catch(() => {});
    window.location.reload();
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

  async handleProNotify() {
    const emailInput = document.getElementById("proEmailInput");
    const email = emailInput?.value.trim();
    if (!email || !email.includes("@")) {
      window.showToast?.("Please enter a valid email address.", "error");
      return;
    }
    await chrome.storage.local.set({ proNotifyEmail: email });
    const btn = document.getElementById("proNotifyBtn");
    if (btn) {
      btn.innerText = "Notified!";
      btn.disabled = true;
      setTimeout(() => {
        btn.innerText = "Notify Me";
        btn.disabled = false;
      }, 2000);
    }
    const modal = document.getElementById("proModal");
    if (modal) modal.style.display = "none";
    window.showToast?.("Thanks! We’ll notify you when Pro launches.", "info");
  }
}
