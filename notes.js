// notes.js
export class Notes {
  constructor() {
    this.initEventListeners();
    this.load();
  }

  async load(filter = "") {
    const data = await chrome.storage.local.get(["notes"]);
    let notes = data.notes || [];
    if (filter) notes = notes.filter(n => (n.text || "").toLowerCase().includes(filter.toLowerCase()));
    const list = document.getElementById("notesList");
    const empty = document.getElementById("notesEmpty");
    if (!list) return;
    list.querySelectorAll(".note-card").forEach(el => el.remove());
    empty.style.display = notes.length ? "none" : "block";
    notes.reverse().forEach((note, idx) => {
      const card = document.createElement("div");
      card.className = "note-card";
      const shortUrl = (note.url || "").replace(/https?:\/\//, "").split("/")[0];
      card.innerHTML = `
        <div class="note-card-text" id="note-text-${idx}">${(note.text || note).substring(0, 500)}</div>
        <div class="note-card-meta">
          <span class="note-card-date">${note.savedAt || ""}</span>
          ${shortUrl ? `<a class="note-card-url" href="${note.url}" target="_blank" title="${note.url}">${shortUrl}</a>` : ""}
          <div class="note-card-actions">
            <button class="note-card-btn" data-action="more" data-idx="${idx}">More</button>
            <button class="note-card-btn" data-action="copy" data-idx="${idx}">Copy</button>
            <button class="note-card-btn del" data-action="delete" data-idx="${idx}">✕</button>
          </div>
        </div>
      `;
      list.appendChild(card);
    });

    // Attach event listeners dynamically
    list.querySelectorAll("[data-action='more']").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const idx = parseInt(btn.dataset.idx);
        const el = document.getElementById(`note-text-${idx}`);
        if (el) {
          el.classList.toggle("expanded");
          btn.innerText = el.classList.contains("expanded") ? "Less" : "More";
        }
      });
    });
    list.querySelectorAll("[data-action='copy']").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const idx = parseInt(btn.dataset.idx);
        const data = await chrome.storage.local.get(["notes"]);
        const notes = data.notes || [];
        const note = notes.reverse()[idx];
        await navigator.clipboard.writeText(note.text || note);
        btn.innerText = "✅";
        setTimeout(() => btn.innerText = "Copy", 1000);
      });
    });
    list.querySelectorAll("[data-action='delete']").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const idx = parseInt(btn.dataset.idx);
        const data = await chrome.storage.local.get(["notes"]);
        let notes = data.notes || [];
        notes.reverse().splice(idx, 1);
        await chrome.storage.local.set({ notes: notes.reverse() });
        this.load(document.getElementById("notesSearch")?.value);
      });
    });
  }

  async export() {
    const data = await chrome.storage.local.get(["notes"]);
    const notes = data.notes || [];
    if (!notes.length) return alert("No notes to export.");
    const text = notes.map((n, i) => `NOTE ${i+1} — ${n.savedAt || ""}\nSource: ${n.url || "unknown"}\n\n${n.text || n}`).join("\n\n" + "=".repeat(40) + "\n\n");
    const blob = new Blob([text], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "atom_notes.txt";
    a.click();
  }

  async clearAll() {
    if (confirm("Delete ALL saved notes? This cannot be undone.")) {
      await chrome.storage.local.set({ notes: [] });
      this.load();
    }
  }

  initEventListeners() {
    const search = document.getElementById("notesSearch");
    if (search) search.addEventListener("input", (e) => this.load(e.target.value));
    const exportBtn = document.getElementById("notesExport");
    if (exportBtn) exportBtn.addEventListener("click", () => this.export());
    const clearBtn = document.getElementById("notesClearAll");
    if (clearBtn) clearBtn.addEventListener("click", () => this.clearAll());
  }
}