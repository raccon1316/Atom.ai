// history.js
export class History {
  constructor(ai) {
    this.ai = ai;
    this.currentFilter = "all";
    this.currentItem = null;
    this.initEventListeners();
  }

  async loadHistory(filter = "all", search = "") {
    const data = await chrome.storage.local.get(["researchHistory"]);
    let history = data.researchHistory || [];
    if (filter !== "all") history = history.filter(h => h.type === filter);
    if (search) history = history.filter(h => (h.topic || "").toLowerCase().includes(search) || (h.report || "").toLowerCase().includes(search));

    const list = document.getElementById("historyList");
    const empty = document.getElementById("historyEmpty");
    if (!list) return;
    list.querySelectorAll(".history-card").forEach(el => el.remove());
    empty.style.display = history.length ? "none" : "block";

    for (const item of history) {
      const card = document.createElement("div");
      card.className = "history-card";
      const icon = this.getIcon(item.type);
      const typeLabel = this.getTypeLabel(item.type);
      card.innerHTML = `
        <div class="history-card-top">
          <span class="history-card-icon">${icon}</span>
          <span class="history-card-topic">${item.topic || "Untitled"}</span>
        </div>
        <div class="history-card-preview">${(item.preview || "").substring(0, 120)}</div>
        <div class="history-card-meta">
          <span class="history-card-date">${item.savedAt || ""}</span>
          <span class="history-card-type type-${item.type}">${typeLabel}</span>
          <button class="history-card-del" data-id="${item.id}">🗑</button>
        </div>
      `;
      card.addEventListener("click", (e) => {
        if (e.target.classList.contains("history-card-del")) return;
        this.openViewer(item);
      });
      const delBtn = card.querySelector(".history-card-del");
      if (delBtn) {
        delBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const d = await chrome.storage.local.get(["researchHistory"]);
          const updated = d.researchHistory.filter(h => h.id !== item.id);
          await chrome.storage.local.set({ researchHistory: updated });
          this.loadHistory(this.currentFilter, document.getElementById("historySearch")?.value || "");
        });
      }
      list.appendChild(card);
    }
  }

  openViewer(item) {
    this.currentItem = item;
    document.getElementById("historyList").style.display = "none";
    document.getElementById("historyEmpty").style.display = "none";
    document.getElementById("historyFilters").style.display = "none";
    document.getElementById("historySearch").style.display = "none";
    document.getElementById("historyViewer").style.display = "block";
    document.getElementById("historyViewerTitle").innerText = item.topic || "Report";
    document.getElementById("historyViewerBody").innerText = item.report || "";
  }

  closeViewer() {
    document.getElementById("historyViewer").style.display = "none";
    document.getElementById("historyList").style.display = "flex";
    document.getElementById("historyFilters").style.display = "flex";
    document.getElementById("historySearch").style.display = "block";
    this.loadHistory(this.currentFilter, document.getElementById("historySearch")?.value || "");
  }

  initEventListeners() {
    const backBtn = document.getElementById("historyBack");
    if (backBtn) backBtn.addEventListener("click", () => this.closeViewer());

    const copyBtn = document.getElementById("historyViewCopy");
    if (copyBtn) copyBtn.addEventListener("click", async () => {
      if (this.currentItem) {
        await navigator.clipboard.writeText(this.currentItem.report);
        copyBtn.innerText = "✅ Copied!";
        setTimeout(() => copyBtn.innerText = "📋 Copy", 1200);
      }
    });

    const pdfBtn = document.getElementById("historyViewPDF");
    if (pdfBtn) pdfBtn.addEventListener("click", () => {
      if (this.currentItem) this.exportPDF(this.currentItem);
    });

    const txtBtn = document.getElementById("historyViewTxt");
    if (txtBtn) txtBtn.addEventListener("click", () => {
      if (this.currentItem) this.exportTXT(this.currentItem);
    });

    const clearAllBtn = document.getElementById("historyClearAll");
    if (clearAllBtn) clearAllBtn.addEventListener("click", async () => {
      if (confirm("Delete ALL research history? This cannot be undone.")) {
        await chrome.storage.local.set({ researchHistory: [] });
        this.loadHistory();
      }
    });

    const searchInput = document.getElementById("historySearch");
    if (searchInput) searchInput.addEventListener("input", (e) => this.loadHistory(this.currentFilter, e.target.value));

    document.querySelectorAll(".hfilter").forEach(f => {
      f.addEventListener("click", () => {
        document.querySelectorAll(".hfilter").forEach(x => x.classList.remove("active"));
        f.classList.add("active");
        this.currentFilter = f.dataset.filter;
        this.loadHistory(this.currentFilter, document.getElementById("historySearch")?.value || "");
      });
    });
  }

  getIcon(type) {
    const icons = { deep: "🔬", company: "🏢", person: "👤", market: "📊", page: "🔍", compare: "⚖️" };
    return icons[type] || "📋";
  }

  getTypeLabel(type) {
    const labels = { deep: "Deep Research", company: "Company", person: "Person", market: "Market", page: "Page Analysis", compare: "Compare" };
    return labels[type] || "Research";
  }

  exportPDF(item) {
    const html = `<!DOCTYPE html>
<html>
<head><title>Atom.AI — ${item.topic}</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: Arial, sans-serif; padding: 48px; color: #1a1a2e; max-width: 800px; margin: 0 auto; }
.header { border-bottom: 3px solid #6c63ff; padding-bottom: 20px; margin-bottom: 28px; }
.logo { font-size: 11px; font-weight: 800; letter-spacing: 3px; color: #6c63ff; text-transform: uppercase; margin-bottom: 8px; }
h1 { font-size: 22px; color: #1a1a2e; margin-bottom: 6px; }
.date { font-size: 12px; color: #888; }
pre { white-space: pre-wrap; word-break: break-word; font-family: Arial, sans-serif; font-size: 13px; line-height: 1.8; color: #2a2a3e; }
@media print { body { padding: 24px; } button { display: none; } }
</style>
</head>
<body>
<div class="header">
<div class="logo">ATOM.AI RESEARCH REPORT</div>
<h1>${item.topic}</h1>
<div class="date">Generated: ${item.savedAt || new Date().toLocaleString()}</div>
</div>
<pre>${(item.report || "").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>
<button onclick="window.print()" style="margin-top:24px;padding:12px 24px;background:#6c63ff;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;">Print / Save as PDF</button>
</body>
</html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, "_blank");
    if (win) setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  exportTXT(item) {
    const blob = new Blob([item.report], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "atom_" + (item.topic || "report").replace(/\s+/g, "_").toLowerCase() + ".txt";
    a.click();
  }
}
