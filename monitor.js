// monitor.js
import { Utils } from './utils.js';

export class Monitor {
  constructor(ai, userSettings) {
    this.ai = ai;
    this.userSettings = userSettings;
    this.monitors = [];
    this.initEventListeners();
    this.load();
  }

  async load() {
    const data = await chrome.storage.local.get(["monitors"]);
    this.monitors = data.monitors || [];
    this.render();
    this.loadDailyBrief();
  }

  render() {
    const list = document.getElementById("monitorList");
    if (!list) return;
    list.querySelectorAll(".monitor-item").forEach(el => el.remove());
    const empty = document.getElementById("monitorEmpty");
    empty.style.display = this.monitors.length ? "none" : "block";
    this.monitors.forEach((m, i) => {
      const item = document.createElement("div");
      item.className = "monitor-item";
      const statusText = m.lastChecked ? "✅ " + new Date(m.lastChecked).toLocaleDateString() : "⏳ Not checked";
      item.innerHTML = `
        <div>
          <div class="monitor-name">${m.name}</div>
          <div class="monitor-url">${(m.url || "").substring(0, 35)}${m.url?.length > 35 ? "..." : ""}</div>
          <div style="font-size:10px;margin-top:2px;color:var(--green);">${statusText}</div>
        </div>
        <div class="monitor-actions">
          <button class="icon-btn" data-index="${i}" data-action="check">🔄</button>
          <button class="icon-btn danger" data-index="${i}" data-action="remove">✕</button>
        </div>
      `;
      list.appendChild(item);
    });
    // Attach event listeners
    list.querySelectorAll("[data-action='check']").forEach(btn => {
      btn.addEventListener("click", (e) => this.checkMonitor(parseInt(btn.dataset.index)));
    });
    list.querySelectorAll("[data-action='remove']").forEach(btn => {
      btn.addEventListener("click", (e) => this.removeMonitor(parseInt(btn.dataset.index)));
    });
  }

  async checkMonitor(idx) {
    const m = this.monitors[idx];
    const resultEl = document.getElementById("monitorResult");
    if (resultEl) {
      resultEl.style.display = "block";
      resultEl.innerText = `🔄 Checking ${m.name}...`;
    }
    try {
      const combined = await Utils.googleResearch(m.name + " news updates 2025");
      const report = await this.ai.chat(`What's new with "${m.name}" recently?\n\nData:\n${combined.substring(0, 6000)}\n\nProvide:\n📰 Latest News\n🔄 Recent Changes\n⚠️ Key Developments\n💡 What to Watch`);
      if (resultEl) resultEl.innerText = `📊 ${m.name} — ${new Date().toLocaleDateString()}\n\n${report}`;
      m.lastChecked = Date.now();
      m.lastReport = report;
      await chrome.storage.local.set({ monitors: this.monitors });
      this.render();
    } catch (e) {
      if (resultEl) resultEl.innerText = "Failed to check. Try again.";
    }
  }

  async removeMonitor(idx) {
    this.monitors.splice(idx, 1);
    await chrome.storage.local.set({ monitors: this.monitors });
    this.render();
  }

  async addMonitor() {
    const name = document.getElementById("monitorName").value.trim();
    let url = document.getElementById("monitorUrl").value.trim();
    if (!name) return alert("Enter a competitor name");
    if (!url) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      url = tab.url;
    }
    this.monitors.push({ name, url, addedAt: Date.now(), lastChecked: null });
    await chrome.storage.local.set({ monitors: this.monitors });
    this.render();
    document.getElementById("monitorName").value = "";
    document.getElementById("monitorUrl").value = "";
  }

  async checkAll() {
    const btn = document.getElementById("monitorCheckAll");
    if (btn) btn.disabled = true;
    const resultEl = document.getElementById("monitorResult");
    if (resultEl) {
      resultEl.style.display = "block";
      resultEl.innerText = "🔄 Checking all competitors...";
    }
    let fullReport = `📊 Competitor Intel — ${new Date().toDateString()}\n${"═".repeat(40)}\n\n`;
    for (const m of this.monitors) {
      if (resultEl) resultEl.innerText = `🔄 Checking ${m.name}...`;
      const combined = await Utils.googleResearch(m.name + " news 2025");
      const report = await this.ai.chat(`Summarize in 3 lines what's new with "${m.name}" recently:\n${combined.substring(0, 3000)}`);
      fullReport += `🏢 ${m.name}\n${report}\n\n`;
      m.lastChecked = Date.now();
    }
    await chrome.storage.local.set({ monitors: this.monitors, dailyBrief: fullReport });
    document.getElementById("briefContent").innerText = fullReport;
    if (resultEl) resultEl.innerText = fullReport;
    this.render();
    if (btn) btn.disabled = false;
  }

  async loadDailyBrief() {
    const data = await chrome.storage.local.get(["dailyBrief"]);
    const dateEl = document.getElementById("briefDate");
    const contentEl = document.getElementById("briefContent");
    if (dateEl) dateEl.innerText = "📅 " + new Date().toDateString();
    if (contentEl) contentEl.innerText = data.dailyBrief || "Add competitors below to get your daily intelligence brief.";
  }

  initEventListeners() {
    const addBtn = document.getElementById("monitorAdd");
    if (addBtn) addBtn.addEventListener("click", () => this.addMonitor());
    const checkAllBtn = document.getElementById("monitorCheckAll");
    if (checkAllBtn) checkAllBtn.addEventListener("click", () => this.checkAll());
    const refreshBtn = document.getElementById("refreshBrief");
    if (refreshBtn) refreshBtn.addEventListener("click", () => this.checkAll());
  }
}