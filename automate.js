// automate.js
import { Utils } from './utils.js';

export class Automate {
  constructor(ai, userSettings) {
    this.ai = ai;
    this.userSettings = userSettings;
    this.agentStopped = false;
    this.resultHistory = [];
    this.resultIndex = -1;
    this.initEventListeners();
    this.loadResultHistory();
    this.updateWorkflowUI().catch(() => {});
  }

  async loadResultHistory() {
    const data = await chrome.storage.local.get(["resultHistory", "resultIndex"]);
    if (data.resultHistory) this.resultHistory = data.resultHistory;
    if (data.resultIndex !== undefined) this.resultIndex = data.resultIndex;
    this.updateResultNav();
  }

  initEventListeners() {
    document.getElementById("ask")?.addEventListener("click", () => this.ask());
    document.getElementById("autotask")?.addEventListener("click", () => this.runAgent());
    document.getElementById("summarize")?.addEventListener("click", () => this.summarizePage());
    document.getElementById("extracttable")?.addEventListener("click", () => this.extractTable());
    document.getElementById("autoFillBtn")?.addEventListener("click", () => this.autoFill());
    document.getElementById("workflowRecord")?.addEventListener("click", () => this.startRecording());
    document.getElementById("workflowStop")?.addEventListener("click", () => this.stopRecording());
    document.getElementById("workflowReplay")?.addEventListener("click", () => this.replayWorkflow());
    document.getElementById("workflowClear")?.addEventListener("click", () => this.clearWorkflow());
    document.getElementById("readAllTabsBtn")?.addEventListener("click", () => this.multiTabResearch());
    document.querySelectorAll(".auto-chip").forEach(chip => chip.addEventListener("click", () => this.quickAction(chip.dataset.action)));
    document.querySelectorAll(".task-template").forEach(t => t.addEventListener("click", () => this.taskTemplate(t.dataset.task)));
    document.getElementById("resultPrev")?.addEventListener("click", () => this.prevResult());
    document.getElementById("resultNext")?.addEventListener("click", () => this.nextResult());
    document.getElementById("copy")?.addEventListener("click", () => this.copyResult());
    document.getElementById("copyMarkdownTable")?.addEventListener("click", () => this.copyAsMarkdownTable());
    document.getElementById("toSheetsResult")?.addEventListener("click", () => this.exportResultToSheets());
    document.getElementById("save")?.addEventListener("click", () => this.saveResult());
    document.getElementById("exportResult")?.addEventListener("click", () => this.exportResult());
    document.getElementById("clearNotes")?.addEventListener("click", () => this.clearNotes());
  }


  getAutomationResultEl() {
    return document.getElementById("autoResultAutomate") || document.getElementById("autoResult") || document.getElementById("result");
  }

  setAutomationStatus(message) {
    const resultEl = this.getAutomationResultEl();
    if (!resultEl) return;
    resultEl.style.display = "block";
    resultEl.innerText = message;
  }

  async getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("No active tab found.");
    return tab;
  }

  async getActiveInjectableTab() {
    const tab = await this.getActiveTab();
    if (!Utils.isInjectableTab(tab)) {
      throw new Error("Open a normal website first. Chrome pages and extension pages cannot be analyzed.");
    }
    return tab;
  }

  async getActivePageContext(maxLength = 4500) {
    const tab = await this.getActiveInjectableTab();
    const text = await Utils.getPageText(tab.id, maxLength);
    if (!text || text.length < 80) {
      throw new Error("Could not read enough content from the current page.");
    }
    return {
      tab,
      text,
      title: tab.title || Utils.safeTabLabel(tab),
      url: tab.url || ""
    };
  }

  parseAgentDecision(decision) {
    let cleaned = String(decision || "").replace(/```json|```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) cleaned = match[0];
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object" || !parsed.action) {
      throw new Error("Invalid agent decision.");
    }
    parsed.params = parsed.params && typeof parsed.params === "object" ? parsed.params : {};
    return parsed;
  }

  buildAutomationFailure(goal, stepLog) {
    const recent = stepLog.slice(-5).map((step, index) =>
      `${index + 1}. ${step.action} -> ${String(step.result || "").substring(0, 160)}`
    ).join("\n");
    return `I could not complete this auto task reliably.\n\nGoal: ${goal}\n\nRecent steps:\n${recent || "No useful steps recorded."}\n\nTry a more specific instruction, or start from the page you want me to work on before running the task.`;
  }

  buildSourceAppendix(sources, skipped = []) {
    const lines = [];
    if (sources?.length) {
      lines.push("SOURCES USED");
      lines.push(...sources.map((source, index) => `${index + 1}. ${source.domain} - ${source.title}`));
    }
    if (skipped?.length) {
      lines.push("");
      lines.push("SKIPPED TABS");
      lines.push(...skipped.map((item, index) => `${index + 1}. ${item.title || item.url || "Unknown"} - ${item.reason}`));
    }
    return lines.join("\n").trim();
  }

  async logDebug(scope, message, detail = null, level = "error") {
    try {
      await chrome.runtime.sendMessage({
        type: "LOG_DEBUG",
        scope,
        level,
        message: String(message || ""),
        detail
      });
    } catch (e) {}
  }

  async runWithTimeout(fn, timeoutMs, timeoutMessage = "Operation timed out.") {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs))
    ]);
  }

  isDurationExceeded(startMs, maxMs) {
    return Date.now() - startMs > maxMs;
  }

  inferExtractionPlan(goal) {
    const text = String(goal || "");
    const urlMatch = text.match(/https?:\/\/[^\s,]+/i);
    const countMatch = text.match(/first\s+(\d+)/i);
    const parenFields = text.match(/\(([^)]+)\)/);
    let fields = [];
    if (parenFields?.[1]) {
      fields = parenFields[1].split(",").map((f) => f.trim()).filter(Boolean);
    }
    if (!fields.length) {
      const extractMatch = text.match(/extract\s+(?:first\s+\d+\s+)?(.+?)(?:then|and then|, then|$)/i);
      if (extractMatch?.[1]) {
        fields = extractMatch[1]
          .split(/,| and /i)
          .map((f) => f.replace(/\bpost titles?\b/i, "title").trim())
          .filter((f) => f.length > 1 && f.length < 40);
      }
    }
    if (!fields.length) {
      fields = ["title", "link"];
    }
    return {
      url: urlMatch ? urlMatch[0] : "",
      count: countMatch ? Math.max(1, Math.min(100, Number(countMatch[1]))) : 20,
      fields,
      wantsSheets: /google\s*sheets?/i.test(text)
    };
  }

  toTSV(rows, fields) {
    const header = fields.join("\t");
    const lines = rows.map((row) => fields.map((field) => String(row[field] || "").replace(/\t|\n/g, " ").trim()).join("\t"));
    return [header, ...lines].join("\n");
  }

  toCSV(rows, fields) {
    const escape = (value) => {
      const v = String(value || "").replace(/\r?\n/g, " ").trim();
      return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    };
    const header = fields.map(escape).join(",");
    const lines = rows.map((row) => fields.map((field) => escape(row[field])).join(","));
    return [header, ...lines].join("\n");
  }

  normalizeOutputFormat(format) {
    const f = String(format || "tsv").toLowerCase().trim();
    return ["tsv", "csv", "json"].includes(f) ? f : "tsv";
  }

  formatRows(rows, fields, outputFormat = "tsv") {
    const normalizedFields = fields?.length
      ? fields
      : Array.from(new Set((rows || []).flatMap((row) => Object.keys(row || {}))));
    const cleanRows = (rows || []).map((row) => {
      const mapped = {};
      normalizedFields.forEach((field) => { mapped[field] = String(row?.[field] ?? ""); });
      return mapped;
    });
    const format = this.normalizeOutputFormat(outputFormat);
    if (format === "json") return JSON.stringify(cleanRows, null, 2);
    if (format === "csv") return this.toCSV(cleanRows, normalizedFields);
    return this.toTSV(cleanRows, normalizedFields);
  }

  safeParseJsonArray(value) {
    const text = String(value || "").replace(/```json|```/gi, "").trim();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : null;
    } catch (e) {}

    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch?.[0]) {
      try {
        const parsed = JSON.parse(arrayMatch[0]);
        return Array.isArray(parsed) ? parsed : null;
      } catch (e) {}
    }
    return null;
  }

  safeParseJsonObject(value) {
    const text = String(value || "").replace(/```json|```/gi, "").trim();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch (e) {}

    const objMatch = text.match(/\{[\s\S]*\}/);
    if (objMatch?.[0]) {
      try {
        const parsed = JSON.parse(objMatch[0]);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch (e) {}
    }
    return null;
  }

  mapRowsHeuristically(rows, fields, count) {
    const wanted = Math.max(1, Math.min(100, Number(count) || 20));
    const normalizedFields = fields.map((f) => String(f || "").trim()).filter(Boolean);
    return rows.slice(0, wanted).map((row) => {
      const text = String(row?.text || "");
      const chunks = text.split("|").map((p) => p.trim()).filter(Boolean);
      const obj = {};
      normalizedFields.forEach((field, idx) => {
        const key = field.toLowerCase();
        if (key === "link" || key === "url") {
          obj[field] = String(row?.link || "");
        } else if ((key === "title" || key === "name") && chunks.length) {
          obj[field] = chunks[0];
        } else if ((key === "rank" || key === "position") && chunks.length) {
          obj[field] = (chunks[0].match(/\d+/)?.[0] || "");
        } else if (key === "year") {
          obj[field] = (text.match(/\b(19|20)\d{2}\b/)?.[0] || "");
        } else if (key === "rating" || key === "score") {
          obj[field] = (text.match(/\b\d+(?:\.\d+)?(?:\/10)?\b/)?.[0] || "");
        } else if (key === "upvotes" || key === "votes") {
          obj[field] = (text.match(/\b\d+(?:\.\d+)?\s*(?:k|m)?\b/i)?.[0] || "");
        } else {
          obj[field] = chunks[idx] || "";
        }
      });
      return obj;
    });
  }

  async collectStructuredPageData(tabId, limit = 80) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: (maxItems) => {
        const pickText = (el) => (el?.innerText || "").replace(/\s+/g, " ").trim();
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          return style && style.display !== "none" && style.visibility !== "hidden";
        };
        const hostname = location.hostname.toLowerCase();

        const rows = [];
        const pushRow = (type, text, link = "") => {
          const t = String(text || "").replace(/\s+/g, " ").trim();
          if (!t || t.length < 6) return;
          rows.push({ type, text: t, link: String(link || "") });
        };

        if (hostname.includes("imdb.com")) {
          const imdbRows = document.querySelectorAll("li.ipc-metadata-list-summary-item");
          imdbRows.forEach((li, index) => {
            const titleEl = li.querySelector("h3");
            const meta = [...li.querySelectorAll(".cli-title-metadata span")].map((x) => pickText(x)).filter(Boolean);
            const rating = pickText(li.querySelector("[data-testid='ratingGroup--imdb-rating']"));
            const titleText = pickText(titleEl).replace(/^\d+\.\s*/, "");
            const rank = String(index + 1);
            const text = [rank, titleText, ...meta, rating].filter(Boolean).join(" | ");
            const link = li.querySelector("a[href]")?.href || "";
            pushRow("imdb", text, link);
          });
        }

        if (hostname.includes("reddit.com")) {
          const redditRows = document.querySelectorAll("shreddit-post, article, div[data-testid='post-container']");
          redditRows.forEach((post) => {
            const title = pickText(
              post.querySelector("a[slot='title'], h3, [data-testid='post-title-text'], a[data-click-id='body']")
            );
            const upvotes = pickText(
              post.querySelector("[id*='vote-arrows'] + div, [data-testid='vote-arrows'] + div, faceplate-number")
            );
            const link = post.querySelector("a[href*='/r/'], a[data-click-id='body']")?.href || "";
            const text = [title, upvotes].filter(Boolean).join(" | ");
            if (title) pushRow("reddit", text, link);
          });
        }

        if (hostname.includes("goodreads.com")) {
          const goodreadsRows = document.querySelectorAll("tr[itemtype*='Book'], .bookalike.review, .elementList");
          goodreadsRows.forEach((row) => {
            const title = pickText(
              row.querySelector("a.bookTitle, a[data-testid='bookTitle'], [itemprop='name']")
            );
            const author = pickText(
              row.querySelector("a.authorName, [itemprop='author'], [data-testid='name']")
            ).replace(/^by\s+/i, "");
            const rating = pickText(
              row.querySelector(".minirating, [aria-label*='rating'], [itemprop='ratingValue']")
            );
            const link = row.querySelector("a.bookTitle, a[data-testid='bookTitle'], a[href*='/book/show/']")?.href || "";
            const text = [title, author, rating].filter(Boolean).join(" | ");
            if (title) pushRow("goodreads", text, link);
          });
        }

        if (hostname.includes("linkedin.com")) {
          const linkedInRows = document.querySelectorAll(
            ".reusable-search__result-container, .entity-result, .search-result__info, .artdeco-entity-lockup"
          );
          linkedInRows.forEach((row) => {
            const name = pickText(
              row.querySelector(
                ".entity-result__title-text a, .app-aware-link span[aria-hidden='true'], .search-result__result-link"
              )
            );
            const headline = pickText(
              row.querySelector(".entity-result__primary-subtitle, .subline-level-1, .search-result__snippets")
            );
            const company = pickText(
              row.querySelector(".entity-result__secondary-subtitle, .subline-level-2")
            );
            const link = row.querySelector("a[href*='/in/'], a[href*='/company/'], a.app-aware-link")?.href || "";
            const text = [name, headline, company].filter(Boolean).join(" | ");
            if (name || headline) pushRow("linkedin", text, link);
          });
        }

        if (hostname.includes("amazon.")) {
          const amazonRows = document.querySelectorAll(
            "[data-component-type='s-search-result'], .s-result-item, .sg-col-inner"
          );
          amazonRows.forEach((row) => {
            const title = pickText(
              row.querySelector("h2 a span, h2 span, .a-size-base-plus")
            );
            const price = pickText(
              row.querySelector(".a-price .a-offscreen, .a-price-whole, .a-color-price")
            );
            const rating = pickText(
              row.querySelector("[aria-label*='out of 5 stars'], .a-icon-alt")
            );
            const reviews = pickText(
              row.querySelector("a[href*='customerReviews'] span, .s-link-style .a-size-base")
            );
            const link = row.querySelector("h2 a[href], a.a-link-normal[href*='/dp/']")?.href || "";
            const text = [title, price, rating, reviews].filter(Boolean).join(" | ");
            if (title) pushRow("amazon", text, link);
          });
        }

        const tableRows = [...document.querySelectorAll("table tr")];
        tableRows.forEach((tr) => {
          const cells = [...tr.querySelectorAll("th,td")].map((c) => pickText(c)).filter(Boolean);
          if (cells.length >= 2) {
            pushRow("table", cells.join(" | "), tr.querySelector("a[href]")?.href || "");
          }
        });

        const listRows = [...document.querySelectorAll("ol li, ul li")];
        listRows.forEach((li) => {
          if (!isVisible(li)) return;
          const t = pickText(li);
          if (t.length >= 15) pushRow("list", t, li.querySelector("a[href]")?.href || "");
        });

        const cardRows = [...document.querySelectorAll("article, .card, [class*='item'], [class*='post'], [class*='row']")];
        cardRows.forEach((el) => {
          if (!isVisible(el)) return;
          const t = pickText(el);
          if (t.length >= 20 && t.length <= 600) {
            pushRow("card", t, el.querySelector("a[href]")?.href || "");
          }
        });

        if (rows.length < 8) {
          const headingRows = [...document.querySelectorAll("h1, h2, h3")];
          headingRows.forEach((h) => {
            if (!isVisible(h)) return;
            const title = pickText(h);
            if (!title) return;
            const nearby = h.closest("a, article, li, div");
            const link = nearby?.querySelector?.("a[href]")?.href || h.querySelector("a[href]")?.href || "";
            pushRow("heading", title, link);
          });
        }

        const dedup = [];
        const seen = new Set();
        for (const row of rows) {
          const key = `${row.text}::${row.link}`.slice(0, 500);
          if (!seen.has(key)) {
            seen.add(key);
            dedup.push(row);
          }
          if (dedup.length >= maxItems) break;
        }
        return dedup;
        },
        args: [Math.max(20, Math.min(300, limit))]
      });
      return res?.[0]?.result || [];
    } catch (e) {
      await this.logDebug("collectStructuredPageData", e.message || "collectStructuredPageData failed", {
        tabId,
        limit
      });
      return [];
    }
  }

  sanitizeCacheKeyPart(value) {
    return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
  }

  async analyzePageLocally(tabId) {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const visible = (el) => {
          const style = window.getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden";
        };
        const count = (selector) => document.querySelectorAll(selector).length;
        const tableCount = count("table");
        const formCount = count("form");
        const listCount = count("ol li, ul li");
        const cardCount = count("article, .card, [class*='card'], [class*='item'], [class*='post'], [role='article']");
        const headingCount = count("h1, h2, h3");
        const linkCount = count("a[href]");
        const mainTextLength = (document.body?.innerText || "").replace(/\s+/g, " ").trim().length;
        const repeatedBlocks = Math.max(listCount, cardCount, count("table tr"));

        const visibleTables = [...document.querySelectorAll("table")].filter(visible);
        const largestTableRows = visibleTables.reduce((max, table) => Math.max(max, table.querySelectorAll("tr").length), 0);
        const largestTableCols = visibleTables.reduce((max, table) => {
          return Math.max(max, table.querySelector("tr")?.querySelectorAll("th,td")?.length || 0);
        }, 0);

        let pageType = "mixed";
        let confidence = 0.45;
        if (tableCount > 0 && largestTableRows >= 4 && largestTableCols >= 2) {
          pageType = "table";
          confidence = Math.min(0.95, 0.55 + Math.min(0.4, largestTableRows / 50));
        } else if (cardCount >= 8 || listCount >= 10) {
          pageType = "cards";
          confidence = Math.min(0.92, 0.5 + Math.min(0.35, Math.max(cardCount, listCount) / 60));
        } else if (formCount > 0 && formCount >= tableCount && formCount >= 1) {
          pageType = "form";
          confidence = 0.8;
        } else if (headingCount >= 8 && mainTextLength > 2000) {
          pageType = "article";
          confidence = 0.7;
        } else if (linkCount > 100 && repeatedBlocks > 20) {
          pageType = "search";
          confidence = 0.62;
        }

        const fingerprint = [
          location.hostname,
          tableCount,
          formCount,
          listCount,
          cardCount,
          headingCount,
          largestTableRows,
          largestTableCols,
          Math.round(mainTextLength / 100)
        ].join(":");

        return {
          url: location.href,
          title: document.title || "",
          pageType,
          confidence,
          counts: { tableCount, formCount, listCount, cardCount, headingCount, linkCount, repeatedBlocks, mainTextLength },
          largestTable: { rows: largestTableRows, cols: largestTableCols },
          fingerprint
        };
      }
    });
    return res?.[0]?.result || null;
  }

  async getCachedPageAnalysis(url, fingerprint) {
    const key = `pageAnalysis:${this.sanitizeCacheKeyPart(url)}:${this.sanitizeCacheKeyPart(fingerprint)}`;
    const data = await chrome.storage.local.get([key]);
    const cached = data[key];
    if (!cached?.analysis || !cached?.savedAt) return null;
    const ageMs = Date.now() - Number(cached.savedAt || 0);
    if (ageMs > 10 * 60 * 1000) return null;
    return cached.analysis;
  }

  async saveCachedPageAnalysis(url, fingerprint, analysis) {
    const key = `pageAnalysis:${this.sanitizeCacheKeyPart(url)}:${this.sanitizeCacheKeyPart(fingerprint)}`;
    await chrome.storage.local.set({ [key]: { analysis, savedAt: Date.now() } });
  }

  validateRows(rows, fields) {
    if (!Array.isArray(rows) || !rows.length) return false;
    const keys = new Set(rows.flatMap((row) => Object.keys(row || {}).map((k) => String(k).toLowerCase())));
    const expected = (fields || []).map((f) => String(f).toLowerCase()).filter(Boolean);
    if (!expected.length) return true;
    const missing = expected.filter((field) => !keys.has(field));
    return missing.length <= Math.max(1, Math.floor(expected.length / 3));
  }

  async trackAutomationMetrics(patch = {}) {
    const data = await chrome.storage.local.get(["automationMetrics"]);
    const base = data.automationMetrics || {
      runs: 0,
      localSuccessCount: 0,
      aiFallbackCount: 0,
      totalDurationMs: 0,
      avgTaskMs: 0
    };
    const next = {
      runs: Number(base.runs || 0) + 1,
      localSuccessCount: Number(base.localSuccessCount || 0) + (patch.localSuccess ? 1 : 0),
      aiFallbackCount: Number(base.aiFallbackCount || 0) + (patch.aiFallback ? 1 : 0),
      totalDurationMs: Number(base.totalDurationMs || 0) + Math.max(0, Number(patch.durationMs || 0))
    };
    next.avgTaskMs = next.runs ? Math.round(next.totalDurationMs / next.runs) : 0;
    await chrome.storage.local.set({ automationMetrics: next });
  }

  async runLocalFirstExtraction(goal) {
    const plan = this.inferExtractionPlan(goal);
    if (!/extract|collect|scrape|pull/i.test(goal)) return null;
    let tab = await this.getActiveTab();
    if (plan.url) {
      await chrome.tabs.update(tab.id, { url: plan.url });
      await Utils.waitForTab(tab.id, 15000);
      await Utils.wait(1000);
      tab = await this.getActiveTab();
    }
    if (!Utils.isInjectableTab(tab)) return null;

    const liveAnalysis = await this.analyzePageLocally(tab.id);
    if (!liveAnalysis) return null;
    const cached = await this.getCachedPageAnalysis(liveAnalysis.url, liveAnalysis.fingerprint);
    const analysis = cached || liveAnalysis;
    if (!cached) await this.saveCachedPageAnalysis(liveAnalysis.url, liveAnalysis.fingerprint, liveAnalysis);

    const confidencePct = Math.round((Number(analysis.confidence || 0) || 0) * 100);
    this.setAutomationStatus(`Detected: ${analysis.pageType} page (${confidencePct}% confidence). Running local extraction first...`);

    const maxRows = Math.max(1, Math.min(120, Number(plan.count || 20)));
    let rows = [];
    let sourceMode = "";
    if (analysis.pageType === "table" && analysis.confidence >= 0.55) {
      const extracted = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (limit) => {
          const pick = (el) => (el?.innerText || "").replace(/\s+/g, " ").trim();
          const tables = [...document.querySelectorAll("table")];
          if (!tables.length) return [];
          const ranked = tables
            .map((table) => ({
              table,
              score: table.querySelectorAll("tr").length * Math.max(1, table.querySelector("tr")?.querySelectorAll("th,td")?.length || 0)
            }))
            .sort((a, b) => b.score - a.score);
          const table = ranked[0].table;
          const headers = [...table.querySelectorAll("thead th")].map(pick).filter(Boolean);
          const dataRows = (table.querySelectorAll("tbody tr").length ? [...table.querySelectorAll("tbody tr")] : [...table.querySelectorAll("tr")]);
          return dataRows.slice(0, limit).map((tr) => {
            const cells = [...tr.querySelectorAll("th,td")].map(pick).filter(Boolean);
            const row = {};
            cells.forEach((cell, i) => {
              row[headers[i] || `col${i + 1}`] = cell;
            });
            const link = tr.querySelector("a[href]")?.href || "";
            if (link) row.link = link;
            return row;
          }).filter((row) => Object.keys(row).length >= 2);
        },
        args: [maxRows]
      });
      const rawRows = extracted?.[0]?.result || [];
      const fields = plan.fields.length ? plan.fields : Object.keys(rawRows[0] || {});
      rows = rawRows.map((row) => {
        const out = {};
        fields.forEach((field, idx) => {
          const exact = Object.keys(row).find((k) => k.toLowerCase() === field.toLowerCase());
          out[field] = String(row?.[exact || field] ?? row?.[`col${idx + 1}`] ?? "");
        });
        if (fields.every((f) => f.toLowerCase() !== "link") && row.link) out.link = row.link;
        return out;
      });
      sourceMode = "local-table";
    } else if ((analysis.pageType === "cards" || analysis.pageType === "search" || analysis.pageType === "mixed") && analysis.confidence >= 0.5) {
      const structured = await this.collectStructuredPageData(tab.id, maxRows * 3);
      rows = this.mapRowsHeuristically(structured, plan.fields, maxRows);
      sourceMode = "local-cards";
    }

    if (!this.validateRows(rows, plan.fields)) {
      return { handled: false, analysis, reason: "low_local_confidence_or_missing_fields" };
    }

    const limited = rows.slice(0, maxRows).map((row) => {
      const out = {};
      plan.fields.forEach((field) => { out[field] = String(row?.[field] ?? ""); });
      return out;
    });
    const tsv = this.toTSV(limited, plan.fields);
    let sheetsStatus = "";
    if (plan.wantsSheets) {
      const write = await this.tryWriteToGoogleSheets(tsv);
      sheetsStatus = write.ok
        ? "Wrote data into the active Google Sheets editor."
        : `Could not auto-write to Google Sheets (${write.reason}). Data copied below; paste manually into Sheets.`;
    }
    return {
      handled: true,
      localOnly: true,
      analysis,
      result: [
        `Local extraction completed (${sourceMode}): ${limited.length} row(s).`,
        `Detected page type: ${analysis.pageType} (${Math.round((analysis.confidence || 0) * 100)}%).`,
        sheetsStatus,
        "",
        "TSV OUTPUT:",
        tsv
      ].filter(Boolean).join("\n")
    };
  }

  async tryWriteToGoogleSheets(tsv) {
    return await Utils.tryWriteToGoogleSheets(tsv);
  }

  async runStructuredExtractionTask(goal) {
    const plan = this.inferExtractionPlan(goal);
    if (!plan.url) return null;
    if (!/extract|collect|scrape|pull/i.test(goal)) return null;

    this.showLoader(true, "Running structured extraction...");
    const tab = await this.getActiveTab();
    await chrome.tabs.update(tab.id, { url: plan.url });
    await Utils.waitForTab(tab.id, 15000);
    await Utils.wait(1200);

    const rows = await this.collectStructuredPageData(tab.id, plan.count * 4);
    if (!rows.length) {
      return "Could not find extractable rows on that page.";
    }

    const raw = rows.map((row, i) => `${i + 1}. ${row.text}${row.link ? ` | LINK: ${row.link}` : ""}`).join("\n");
    const jsonText = await this.ai.chat(
      `Goal: ${goal}

Fields required: ${plan.fields.join(", ")}
Row count target: ${plan.count}

Convert the raw page snippets below into STRICT JSON array only (no markdown), max ${plan.count} rows.
Each object must only include these keys: ${plan.fields.join(", ")}.
If a field is missing, use empty string.

RAW SNIPPETS:
${raw.substring(0, 14000)}`,
      1800
    );

    let parsed = this.safeParseJsonArray(jsonText);
    if (!parsed) {
      const repairText = await this.ai.chat(
        `Return ONLY valid JSON array.
Use exactly these keys in each row: ${plan.fields.join(", ")}.
No comments. No markdown.

Input:
${String(jsonText).substring(0, 7000)}`,
        900
      );
      parsed = this.safeParseJsonArray(repairText);
    }

    if (!parsed) {
      const fallback = this.mapRowsHeuristically(rows, plan.fields, plan.count);
      if (!fallback.length) {
        return "Extraction parsing failed. Try a smaller count or simpler schema.";
      }
      parsed = fallback;
    }

    const limited = parsed.slice(0, plan.count).map((row) => {
      const obj = {};
      plan.fields.forEach((field) => {
        obj[field] = String(row?.[field] ?? "");
      });
      return obj;
    });

    const tsv = this.toTSV(limited, plan.fields);
    let sheetsStatus = "";
    if (plan.wantsSheets) {
      const write = await this.tryWriteToGoogleSheets(tsv);
      sheetsStatus = write.ok
        ? "Wrote data into the active Google Sheets editor."
        : `Could not auto-write to Google Sheets (${write.reason}). Data copied below; paste manually into Sheets.`;
    }

    return [
      `Structured extraction completed: ${limited.length} row(s).`,
      sheetsStatus,
      "",
      "TSV OUTPUT:",
      tsv
    ].filter(Boolean).join("\n");
  }
  async ask() {
    const prompt = document.getElementById("prompt").value.trim();
    if (!prompt) return;
    this.showLoader(true, "Working...");
    try {
      const { title, url, text } = await this.getActivePageContext(4500);
      const result = await this.ai.chat(
        `${prompt}\n\nCurrent page title: ${title}\nCurrent page URL: ${url}\n\nPage content:\n${text}`
      );
      this.setResult(result);
    } catch (e) {
      this.setResult("Error: " + e.message);
    } finally {
      this.showLoader(false);
    }
  }
  async summarizePage() {
    this.showLoader(true, "Summarizing...");
    try {
      const { title, url, text } = await this.getActivePageContext(5000);
      const result = await this.ai.chat(
        `Summarize this page in clear bullet points with key takeaways for a business professional.\n\nTitle: ${title}\nURL: ${url}\n\n${text}`
      );
      this.setResult(result);
    } catch (e) {
      this.setResult("Error: " + e.message);
    } finally {
      this.showLoader(false);
    }
  }
  async extractTable() {
    this.showLoader(true, "Extracting data...");
    try {
      const { title, url, text } = await this.getActivePageContext(5000);
      const result = await this.ai.chat(
        `Extract all structured data - tables, lists, prices, rankings, contacts, and stats. Format clearly with labels.\n\nTitle: ${title}\nURL: ${url}\n\n${text}`
      );
      this.setResult(result);
    } catch (e) {
      this.setResult("Error: " + e.message);
    } finally {
      this.showLoader(false);
    }
  }
  async autoFill() {
    return await this.autoFillEnhanced();
    const instructions = document.getElementById("autofillInstructions").value.trim();
    if (!instructions) return alert("Describe what to fill");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Utils.isInjectableTab(tab)) return alert("Navigate to a page with a form first.");
    const resultEl = document.getElementById("autoResult");
    resultEl.style.display = "block";
    resultEl.innerText = "🔄 Reading form fields...";
    const snap = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => [...document.querySelectorAll("input,textarea,select")].map(el => ({
        tag: el.tagName, type: el.type || "", id: el.id || "",
        name: el.name || "", placeholder: el.placeholder || "",
        label: el.labels?.[0]?.innerText || ""
      }))
    });
    const fields = snap?.[0]?.result || [];
    if (!fields.length) {
      resultEl.innerText = "No form fields found on this page.";
      return;
    }
    const plan = await this.ai.chat(`Form fields:\n${JSON.stringify(fields)}\n\nUser instructions: "${instructions}"\n\nReply ONLY with JSON array (no markdown):\n[{"selector":"input[name='x']","value":"val"}]`, 800);
    let actions;
    try {
      actions = JSON.parse(plan.replace(/```json|```/g, "").trim());
    } catch {
      resultEl.innerText = "Could not parse fill plan. Try again.";
      return;
    }
    let filled = 0;
    for (const a of actions) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (s, v) => {
            const el = document.querySelector(s);
            if (el) {
              el.focus();
              el.value = v;
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            }
          },
          args: [a.selector, a.value]
        });
        filled++;
        await Utils.wait(350);
      } catch (e) {}
    }
    resultEl.innerText = `✅ Filled ${filled} of ${actions.length} fields!`;
  }

  async autoFillEnhanced() {
    const instructions = document.getElementById("autofillInstructions").value.trim();
    if (!instructions) return alert("Describe what to fill");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Utils.isInjectableTab(tab)) return alert("Navigate to a page with a form first.");

    const resultEl = document.getElementById("autoResult");
    resultEl.style.display = "block";
    resultEl.innerText = "Reading form fields...";

    const snap = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const pick = (s) => (s || "").replace(/\s+/g, " ").trim();
        const esc = (v) => {
          if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(v);
          return String(v).replace(/"/g, '\\"');
        };
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        };
        const inferLabel = (el) => {
          const direct = el.labels?.[0]?.innerText;
          if (direct) return pick(direct);
          const byFor = el.id ? document.querySelector(`label[for="${esc(el.id)}"]`)?.innerText : "";
          if (byFor) return pick(byFor);
          const parentLabel = el.closest("label")?.innerText;
          if (parentLabel) return pick(parentLabel);
          const aria = el.getAttribute("aria-label");
          if (aria) return pick(aria);
          return "";
        };
        const buildSelector = (el) => {
          if (el.id) return `#${esc(el.id)}`;
          if (el.name) return `${el.tagName.toLowerCase()}[name="${esc(el.name)}"]`;
          if (el.getAttribute("data-testid")) return `[data-testid="${esc(el.getAttribute("data-testid"))}"]`;
          if (el.getAttribute("aria-label")) return `${el.tagName.toLowerCase()}[aria-label="${esc(el.getAttribute("aria-label"))}"]`;
          if (el.placeholder) return `${el.tagName.toLowerCase()}[placeholder="${esc(el.placeholder)}"]`;
          return el.tagName.toLowerCase();
        };
        return [...document.querySelectorAll("input,textarea,select,[contenteditable='true'],[role='combobox']")]
          .filter((el) => !el.disabled && isVisible(el))
          .slice(0, 220)
          .map((el) => {
            const tag = el.tagName.toLowerCase();
            return {
              selector: buildSelector(el),
              tag,
              type: String(el.type || "").toLowerCase(),
              id: el.id || "",
              name: el.name || "",
              placeholder: el.placeholder || "",
              label: inferLabel(el),
              role: el.getAttribute("role") || "",
              options: tag === "select"
                ? [...el.options].slice(0, 25).map((o) => ({ text: pick(o.text), value: String(o.value || "") }))
                : []
            };
          });
      }
    });

    const fields = snap?.[0]?.result || [];
    const hasClickOrWaitIntent = /(^|[;\n\r])\s*(click|tap|press|wait\s+for|wait\s+\d+)/i.test(instructions);
    if (!fields.length && !hasClickOrWaitIntent) {
      resultEl.innerText = "No form fields found on this page.";
      return;
    }
    if (!fields.length && hasClickOrWaitIntent) {
      resultEl.innerText = "No form fields detected. Running click/wait flow...";
    }

    const buildFallbackActions = () => {
      const normalize = (text) => String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
      const lines = String(instructions)
        .split(/\r?\n|;/)
        .map((line) => line.trim());

      const pairActions = [];
      const flowActions = [];
      for (const line of lines) {
        if (!line) continue;
        const kv = line.match(/^([^:=\-]{2,50})\s*[:=]\s*(.+)$/);
        if (kv) {
          pairActions.push({ key: kv[1].trim(), value: kv[2].trim() });
          continue;
        }
        const clickMatch = line.match(/^(?:click|tap|press)\s+(.+)$/i);
        if (clickMatch) {
          flowActions.push({ type: "click", field: clickMatch[1].trim(), value: clickMatch[1].trim() });
          continue;
        }
        const waitForMatch = line.match(/^wait\s+for\s+(.+)$/i);
        if (waitForMatch) {
          flowActions.push({ type: "waitFor", field: waitForMatch[1].trim(), waitMs: 12000 });
          continue;
        }
        const waitMsMatch = line.match(/^wait\s+(\d+)\s*(?:ms|milliseconds|sec|seconds)?$/i);
        if (waitMsMatch) {
          const raw = Number(waitMsMatch[1] || 0);
          const waitMs = /sec/i.test(line) ? raw * 1000 : raw;
          flowActions.push({ type: "waitFor", waitMs: Math.max(300, Math.min(30000, waitMs || 1200)) });
        }
      }

      const mapped = pairActions.map((pair) => {
        const target = normalize(pair.key);
        let best = null;
        let bestScore = -1;
        for (const field of fields) {
          const hay = normalize([field.label, field.name, field.placeholder, field.id].join(" "));
          let score = 0;
          if (hay.includes(target)) score += 5;
          score += target.split(" ").filter((t) => t.length > 2 && hay.includes(t)).length;
          if (score > bestScore) {
            best = field;
            bestScore = score;
          }
        }
        if (!best || bestScore < 1) return null;
        return { selector: best.selector, value: pair.value, field: pair.key, type: best.type || best.tag };
      }).filter(Boolean);

      return [...mapped, ...flowActions];
    };

    let actions = [];
    let planError = "";
    try {
      const plan = await this.ai.chat(
        `Create a strict form fill plan from user instructions.
Instructions:
${instructions}

Detected fields:
${JSON.stringify(fields).substring(0, 14000)}

Return ONLY JSON array with objects like:
{"selector":"...","value":"...","field":"...","type":"text|textarea|select|checkbox|radio|combobox|click|waitFor","choiceText":"optional","waitMs":1200}

Rules:
- Use selectors from detected fields for input/select steps.
- For select/combobox fields prefer "choiceText".
- For checkbox/radio set value as true/false or option text.
- Include click steps when user instructions say "click next/continue/login".
- For click/wait steps you may omit selector and use "field" text (for button/link label).
- Keep order exactly as required by the user flow.`,
        1000
      );
      actions = this.safeParseJsonArray(plan) || [];
    } catch (e) {
      planError = e?.message || "AI planning failed.";
    }

    if (!actions.length) actions = buildFallbackActions();
    if (!actions.length) {
      resultEl.innerText = planError
        ? `Could not build autofill plan (${planError}). Use lines like "Email: x", "Click Next", "Password: y".`
        : "Could not build autofill plan. Use lines like \"Email: x\", \"Click Next\", \"Password: y\".";
      return;
    }

    const jobId = `af_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    resultEl.innerText = "Applying autofill plan in passive mode...";
    const startRes = await chrome.runtime.sendMessage({
      type: "AUTOFILL_START",
      jobId,
      tabId: tab.id,
      actions
    });
    if (!startRes?.ok) {
      resultEl.innerText = `Could not start autofill: ${startRes?.error || "Unknown error"}`;
      return;
    }

    resultEl.innerText = "Autofill started in background mode. It will continue even if popup closes.";

    let finalStatus = null;
    for (let i = 0; i < 20; i++) {
      await Utils.wait(700);
      const probe = await chrome.runtime.sendMessage({ type: "AUTOFILL_STATUS", jobId });
      const status = probe?.job || null;
      if (!status) continue;
      if (status.status === "done" || status.status === "error") {
        finalStatus = status;
        break;
      }
    }

    if (!finalStatus) {
      resultEl.innerText = "Autofill is still running in passive mode. You can close popup and reopen to continue.";
      return;
    }

    const outcomes = finalStatus.results || [];
    const successCount = outcomes.filter((o) => o.ok).length;
    const failList = outcomes.filter((o) => !o.ok);
    const details = failList.slice(0, 5).map((o) => `- ${o.field || o.selector || "field"}: ${o.reason || "not filled"}`).join("\n");
    resultEl.innerText = [
      finalStatus.status === "error" ? `Run failed: ${finalStatus.error || "unknown error"}` : `Executed ${successCount} of ${actions.length} step(s).`,
      failList.length ? `Failed: ${failList.length}` : "No failures.",
      details
    ].filter(Boolean).join("\n");
  }

  async quickAction(action) {
    const resultEl = document.getElementById("autoResultAutomate") || document.getElementById("autoResult");
    if (!resultEl) return;
    resultEl.style.display = "block";
    resultEl.innerText = "Working on: " + action + "...";
    let tab = null;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch (e) {
      resultEl.innerText = "Error reading current tab: " + e.message;
      return;
    }
    if (!Utils.isInjectableTab(tab)) {
      resultEl.innerText = "Open a normal website first.";
      return;
    }
    try {
      switch (action) {
        case "extractleads": {
          const text = await Utils.getPageText(tab.id);
          const result = await this.ai.chat(`Extract all business leads from this page. For each lead provide: Company/Person Name, Email, Phone, Website/LinkedIn, Role/Title. Format as clean numbered list. Page:\n${text.substring(0, 4000)}`);
          resultEl.innerText = result || "No leads found.";
          break;
        }
        case "extractcsv": {
          const text = await Utils.getPageText(tab.id);
          const csv = await this.ai.chat(`Extract ALL structured/tabular data from this page and format as CSV with headers. Label each section if multiple tables exist.\n\nPage:\n${text.substring(0, 4000)}`);
          if (!csv) { resultEl.innerText = "No tabular data found."; break; }
          resultEl.innerText = csv;
          const blob = new Blob([csv], { type: "text/csv" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "atom_export.csv";
          a.click();
          break;
        }
        case "emails": {
          const res = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const text = document.body.innerText + document.body.innerHTML;
              return [...new Set((text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []))].slice(0, 30);
            }
          });
          const emails = res?.[0]?.result || [];
          resultEl.innerText = emails.length ? `📧 Found ${emails.length} email(s):\n\n` + emails.join("\n") : "No emails found.";
          break;
        }
        case "phones": {
          const res = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const text = document.body.innerText;
              return [...new Set((text.match(/(\+?[\d\s\-().]{8,18})/g) || []).filter(p => p.replace(/\D/g, "").length >= 7))].slice(0, 20);
            }
          });
          const phones = res?.[0]?.result || [];
          resultEl.innerText = phones.length ? `📞 Found ${phones.length} phone(s):\n\n` + phones.join("\n") : "No phone numbers found.";
          break;
        }
        case "prices": {
          const text = await Utils.getPageText(tab.id);
          const result = await this.ai.chat(`Extract ALL prices from this page. Format as a clean list with item and price. Include discounts and original prices.\n\nPage:\n${text.substring(0, 3000)}`);
          resultEl.innerText = result || "No prices found.";
          break;
        }
        case "techstack": {
          const res = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const scripts = [...document.querySelectorAll("script[src]")].map(s => s.src);
              const metas = [...document.querySelectorAll("meta")].map(m => m.name + ":" + m.content);
              const html = document.documentElement.outerHTML.substring(0, 8000);
              return { scripts, metas, html };
            }
          });
          const data = res?.[0]?.result || {};
          const result = await this.ai.chat(`Identify the tech stack of this website based on:\nScripts: ${JSON.stringify(data.scripts?.slice(0, 20))}\nMeta tags: ${JSON.stringify(data.metas?.slice(0, 10))}\nHTML snippet: ${(data.html || "").substring(0, 2000)}\n\nList: Frontend framework, Backend signals, Analytics tools, Ad tools, CMS, CDN, Payment systems, Chat tools, Marketing stack.`);
          resultEl.innerText = result;
          break;
        }
        case "links": {
          const res = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const seen = new Set(); const links = [];
              document.querySelectorAll("a[href]").forEach(a => {
                if (!seen.has(a.href) && a.href.startsWith("http")) {
                  seen.add(a.href);
                  links.push({ text: (a.innerText || "").trim().substring(0, 60), url: a.href });
                }
              });
              return links.slice(0, 50);
            }
          });
          const links = res?.[0]?.result || [];
          resultEl.innerText = `🔗 Found ${links.length} links:\n\n` + links.map((l, i) => `${i + 1}. ${l.text || "(no text)"}\n   ${l.url}`).join("\n\n");
          break;
        }
        case "readmode": {
          const text = await Utils.getPageText(tab.id);
          const result = await this.ai.chat(`Extract and reformat this article in clean reading mode — remove ads/navigation/clutter. Present just the core content clearly structured:\n\n${text.substring(0, 4000)}`);
          resultEl.innerText = result || "Could not reformat this page.";
          break;
        }
        default:
          resultEl.innerText = "⚠️ Unknown action: " + action;
      }
    } catch (e) {
      resultEl.innerText = "⚠️ Error: " + e.message;
    }
  }

  async runAgent() {
    const goal = document.getElementById("prompt").value.trim();
    if (!goal) return alert("Enter a task goal.");
    this.showLoader(true, "Agent running...");
    this.agentStopped = false;
    const runStartedAt = Date.now();
    const stopBtn = document.getElementById("agentStop");
    if (stopBtn) stopBtn.style.display = "inline-block";
    try {
      const localFirst = await this.runLocalFirstExtraction(goal);
      if (localFirst?.analysis) {
        const pct = Math.round((localFirst.analysis.confidence || 0) * 100);
        this.setAutomationStatus(`Detected: ${localFirst.analysis.pageType} (${pct}% confidence).`);
      }
      if (localFirst?.handled) {
        this.setResult(localFirst.result);
        await this.trackAutomationMetrics({
          localSuccess: true,
          aiFallback: false,
          durationMs: Date.now() - runStartedAt
        });
        return;
      }

      const structured = await this.runStructuredExtractionTask(goal);
      if (structured) {
        this.setResult(structured);
        await this.trackAutomationMetrics({
          localSuccess: false,
          aiFallback: true,
          durationMs: Date.now() - runStartedAt
        });
        return;
      }
      const result = await this.runWithTimeout(
        () => this.agentLoop(goal),
        5 * 60 * 1000,
        "Auto task timed out after 5 minutes."
      );
      this.setResult(result);
      await this.trackAutomationMetrics({
        localSuccess: false,
        aiFallback: true,
        durationMs: Date.now() - runStartedAt
      });
    } catch (e) {
      this.setResult("Auto task failed: " + e.message);
      await this.trackAutomationMetrics({
        localSuccess: false,
        aiFallback: false,
        durationMs: Date.now() - runStartedAt
      });
    } finally {
      this.showLoader(false);
      if (stopBtn) stopBtn.style.display = "none";
    }
  }
  async agentLoop(goal) {
    let stepLog = [];
    const maxSteps = 25;
    const startTime = Date.now();
    const maxDurationMs = 5 * 60 * 1000;
    const repeatedActions = new Map();
    const memory = { goal, createdAt: new Date().toISOString() };
    let currentPlan = "";
    let planVersion = 0;

    const getLastGoodResult = () => {
      return stepLog.slice().reverse().find((s) => typeof s.result === "string" && !String(s.result).startsWith("ERROR:"))?.result || "";
    };

    const evaluateCondition = (condition, local = {}) => {
      if (typeof condition === "boolean") return condition;
      const lastResult = String(local.lastResult || getLastGoodResult() || "");
      if (!condition) return false;
      if (typeof condition === "object") {
        const op = String(condition.op || "").toLowerCase();
        const key = String(condition.key || "");
        if (op === "memory_exists") return memory[key] !== undefined;
        if (op === "memory_not_empty") return String(memory[key] || "").trim().length > 0;
        if (op === "result_contains") return lastResult.toLowerCase().includes(String(condition.value || "").toLowerCase());
        if (op === "plan_exists") return String(currentPlan || "").trim().length > 0;
        if (op === "step_gte") return stepLog.length >= Number(condition.value || 0);
        return false;
      }

      const text = String(condition).trim();
      const lc = text.toLowerCase();
      if (lc === "plan_exists") return String(currentPlan || "").trim().length > 0;

      let m = text.match(/^memory\.([a-zA-Z0-9_.-]+)\s+exists$/i);
      if (m) return memory[m[1]] !== undefined;

      m = text.match(/^memory\.([a-zA-Z0-9_.-]+)\s+not_empty$/i);
      if (m) return String(memory[m[1]] || "").trim().length > 0;

      m = text.match(/^result\s+contains\s+(.+)$/i);
      if (m) return lastResult.toLowerCase().includes(String(m[1] || "").trim().toLowerCase());

      m = text.match(/^step\s*>=\s*(\d+)$/i);
      if (m) return stepLog.length >= Number(m[1] || 0);

      return false;
    };

    const tools = {
      navigate: async (params) => {
        const tab = await this.getActiveTab();
        let url = String(params.url || "").trim();
        if (!url) return "ERROR: Missing url.";
        const aliases = { youtube: "https://www.youtube.com", google: "https://www.google.com", reddit: "https://www.reddit.com", linkedin: "https://www.linkedin.com", twitter: "https://www.twitter.com", x: "https://www.x.com", github: "https://www.github.com", amazon: "https://www.amazon.com", producthunt: "https://www.producthunt.com", crunchbase: "https://www.crunchbase.com" };
        const key = url.toLowerCase().replace(/https?:\/\//, "").replace("www.", "").split(".")[0];
        if (aliases[key]) url = aliases[key];
        if (!url.startsWith("http")) url = "https://" + url;
        await chrome.tabs.update(tab.id, { url });
        await Utils.waitForTab(tab.id, 12000);
        await Utils.wait(2000);
        return "OK: Navigated to " + url;
      },
      getPageStructure: async () => {
        const tab = await this.getActiveInjectableTab();
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const pick = (el) => (el?.innerText || "").replace(/\s+/g, " ").trim();
            const sections = [...document.querySelectorAll("section, main, article, aside, nav")].slice(0, 40).map((el) => ({
              tag: el.tagName.toLowerCase(),
              id: el.id || "",
              className: String(el.className || "").split(/\s+/).filter(Boolean).slice(0, 6).join("."),
              childCount: el.children?.length || 0,
              textHint: pick(el).slice(0, 120)
            }));
            const headings = [...document.querySelectorAll("h1,h2,h3")].slice(0, 50).map((h) => ({
              tag: h.tagName.toLowerCase(),
              text: pick(h).slice(0, 120)
            }));
            const tables = [...document.querySelectorAll("table")].slice(0, 10).map((table, idx) => ({
              index: idx + 1,
              id: table.id || "",
              className: String(table.className || "").slice(0, 80),
              rows: table.querySelectorAll("tr").length,
              cols: table.querySelector("tr")?.querySelectorAll("th,td")?.length || 0,
              headers: [...table.querySelectorAll("th")].slice(0, 10).map((h) => pick(h))
            }));
            const forms = [...document.querySelectorAll("form")].slice(0, 10).map((f, idx) => ({
              index: idx + 1,
              id: f.id || "",
              className: String(f.className || "").slice(0, 80),
              inputs: f.querySelectorAll("input,textarea,select").length
            }));
            return {
              title: document.title || "",
              url: location.href,
              headings,
              tables,
              forms,
              sections
            };
          }
        });
        const out = res?.[0]?.result;
        if (!out) return "ERROR: Could not inspect page structure.";
        memory.pageStructure = out;
        return JSON.stringify(out, null, 2).slice(0, 12000);
      },
      getElementDetails: async (params) => {
        const tab = await this.getActiveInjectableTab();
        const selector = String(params.selector || "").trim();
        if (!selector) return "ERROR: Missing selector.";
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel) => {
            const el = document.querySelector(sel);
            if (!el) return { ok: false, reason: "not_found" };
            const style = window.getComputedStyle(el);
            const attrs = {};
            for (const attr of [...el.attributes].slice(0, 40)) attrs[attr.name] = attr.value;
            const rect = el.getBoundingClientRect();
            return {
              ok: true,
              selector: sel,
              tag: el.tagName.toLowerCase(),
              id: el.id || "",
              className: String(el.className || ""),
              text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300),
              htmlSnippet: (el.outerHTML || "").slice(0, 600),
              childCount: el.children?.length || 0,
              visible: style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0",
              rect: {
                x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height)
              },
              attributes: attrs
            };
          },
          args: [selector]
        });
        const out = res?.[0]?.result;
        if (!out?.ok) return `ERROR: Element not found for selector ${selector}`;
        memory[`element:${selector}`] = out;
        return JSON.stringify(out, null, 2);
      },
      createPlan: async (params) => {
        const activeTab = await this.getActiveTab().catch(() => null);
        const requestedGoal = String(params.goal || goal).trim();
        const prompt = `Create a concise execution plan for this browser automation task.
Goal: ${requestedGoal}
Current URL: ${activeTab?.url || "Unknown"}
Current title: ${activeTab?.title || "Unknown"}

Output plain text numbered steps (max 8), focused on tool usage and reliability.`;
        const planText = await this.ai.chat(prompt, 450);
        currentPlan = String(planText || "").trim();
        memory.plan = currentPlan;
        planVersion += 1;
        memory.planVersion = planVersion;
        return currentPlan || "ERROR: Could not create a plan.";
      },
      updatePlan: async (params) => {
        const notes = String(params.notes || params.reason || "").trim() || "Update plan based on recent results.";
        const scratch = stepLog.slice(-6).map((s, i) => `${i + 1}. ${s.action} -> ${String(s.result || "").slice(0, 140)}`).join("\n");
        const nextPlan = await this.ai.chat(
          `Revise this automation plan.
Current plan:
${currentPlan || "No plan yet."}

Notes:
${notes}

Recent execution:
${scratch || "No steps."}

Return a numbered plan (max 8 steps).`,
          500
        );
        currentPlan = String(nextPlan || "").trim();
        memory.plan = currentPlan;
        planVersion += 1;
        memory.planVersion = planVersion;
        return currentPlan || "ERROR: Could not update plan.";
      },
      selfReflect: async (params = {}) => {
        const scratch = stepLog.slice(-8).map((s, i) => `${i + 1}. ${s.action} -> ${String(s.result || "").slice(0, 180)}`).join("\n");
        const reflection = await this.ai.chat(
          `Reflect on task progress and suggest corrective action.
Goal: ${goal}
Current plan:
${currentPlan || "No plan"}

Recent steps:
${scratch || "No steps yet."}

Return:
1) what's working
2) what's failing
3) best next action`,
          420
        );
        memory.lastReflection = String(reflection || "").trim();
        if (params.auto) return `AUTO_REFLECTION:\n${memory.lastReflection}`;
        return memory.lastReflection || "No reflection generated.";
      },
      typeAndSearch: async (params) => {
        const tab = await this.getActiveInjectableTab();
        const value = String(params.value || "").trim();
        if (!value) return "ERROR: Missing search text.";
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel, val) => {
            const el = document.querySelector(sel);
            if (!el) return { ok: false, reason: "selector_not_found" };
            el.focus();
            el.value = val;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            el.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", bubbles: true }));
            el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
            const f = el.closest("form");
            if (f) f.submit();
            return { ok: true, selector: sel };
          },
          args: [params.selector || "input[name='search_query'],textarea[name='q'],input[name='q'],input[type='search']", value]
        });
        const outcome = res?.[0]?.result;
        if (!outcome?.ok) return "ERROR: Could not find a search field on the page.";
        await Utils.waitForTab(tab.id, 10000);
        await Utils.wait(1200);
        return "OK: Searched for " + value;
      },
      clickText: async (params) => {
        const tab = await this.getActiveInjectableTab();
        const text = String(params.text || params.value || "").trim();
        if (!text) return "ERROR: Missing click target.";
        const result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (t) => {
            const normalize = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
            const target = normalize(t);
            if (document.querySelector("ytd-app")) {
              const ytTitles = document.querySelectorAll("ytd-video-renderer a#video-title, ytd-rich-item-renderer a#video-title, h3.ytd-video-renderer a");
              let best = null;
              for (const el of ytTitles) {
                const title = normalize(el.getAttribute("title") || el.innerText);
                if (title.includes(target) || target.split(" ").filter((w) => w.length > 3).some((w) => title.includes(w))) {
                  best = el;
                  break;
                }
              }
              if (!best && ytTitles.length) best = ytTitles[0];
              if (best) {
                best.scrollIntoView({ block: "center" });
                best.click();
                return "Clicked YT: " + normalize(best.getAttribute("title") || best.innerText).substring(0, 60);
              }
            }
            for (const el of document.querySelectorAll("a[href], button, [role='button'], h3")) {
              const txt = normalize(el.innerText + " " + (el.getAttribute("title") || "") + " " + (el.getAttribute("aria-label") || ""));
              if (txt.includes(target) && el.offsetParent !== null) {
                el.scrollIntoView({ block: "center" });
                el.click();
                return "Clicked: " + normalize(el.innerText).substring(0, 60);
              }
            }
            return "NOT_FOUND: " + t;
          },
          args: [text]
        });
        await Utils.wait(3000);
        return result?.[0]?.result || "ERROR: clickText failed";
      },
      readPage: async (params = {}) => {
        const tab = await this.getActiveInjectableTab();
        const mode = String(params.mode || "full").toLowerCase();
        if (mode !== "structured") {
          const { title, url, text } = await this.getActivePageContext(9000);
          return `PAGE TITLE: ${title}\nPAGE URL: ${url}\n\n${text}`;
        }
        const snapshot = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 8000);
            const tableSummaries = [...document.querySelectorAll("table")].slice(0, 5).map((table, index) => {
              const headers = [...table.querySelectorAll("th")].map((h) => (h.innerText || "").trim()).filter(Boolean);
              const rows = table.querySelectorAll("tr").length;
              const cols = table.querySelector("tr")?.querySelectorAll("th,td")?.length || 0;
              return { index: index + 1, rows, cols, headers: headers.slice(0, 10) };
            });
            return {
              title: document.title || "",
              url: location.href,
              tableCount: document.querySelectorAll("table").length,
              headingCount: document.querySelectorAll("h1,h2,h3").length,
              tableSummaries,
              text
            };
          }
        });
        const data = snapshot?.[0]?.result;
        if (!data) return "ERROR: Could not read structured page snapshot.";
        return [
          `PAGE TITLE: ${data.title}`,
          `PAGE URL: ${data.url}`,
          `TABLE COUNT: ${data.tableCount}`,
          `HEADING COUNT: ${data.headingCount}`,
          "",
          `TABLE SUMMARIES: ${JSON.stringify(data.tableSummaries || []).slice(0, 1600)}`,
          "",
          data.text || ""
        ].join("\n");
      },
      readAllTabs: async () => {
        return await this.crossTabIntelligence();
      },
      switchTabByTitleOrUrl: async (params) => {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const needle = String(params.match || params.title || params.url || "").toLowerCase().trim();
        if (!needle) return "ERROR: Missing title/url match text.";
        const matched = tabs.find((t) =>
          String(t.title || "").toLowerCase().includes(needle) ||
          String(t.url || "").toLowerCase().includes(needle)
        );
        if (!matched?.id) return `ERROR: No tab matched "${needle}".`;
        await chrome.tabs.update(matched.id, { active: true });
        memory.activeTab = { title: matched.title || "", url: matched.url || "" };
        return `OK: Switched to tab "${matched.title || matched.url || matched.id}"`;
      },
      extractData: async (params) => {
        const inferred = this.inferExtractionPlan(goal).fields.join(", ");
        const target = String(params.target || inferred || "").trim();
        if (!target) return "ERROR: Missing extract target.";
        const { title, url, text } = await this.getActivePageContext(9000);
        return await this.ai.chat(
          `Extract specifically: ${target}\n\nIf the information is missing, say NOT_FOUND and explain briefly.\n\nPage title: ${title}\nPage URL: ${url}\n\n${text}`
        );
      },
      extractTable: async (params) => {
        const tab = await this.getActiveInjectableTab();
        const selector = String(params.selector || "").trim();
        const maxRows = Math.max(1, Math.min(200, Number(params.maxRows || 50)));
        const outputFormat = this.normalizeOutputFormat(params.outputFormat || "tsv");
        const columns = Array.isArray(params.columns)
          ? params.columns.map((c) => String(c).trim()).filter(Boolean)
          : String(params.columns || "").split(",").map((c) => c.trim()).filter(Boolean);

        const snap = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel, rowLimit) => {
            const pick = (el) => (el?.innerText || "").replace(/\s+/g, " ").trim();
            const visible = (el) => {
              const style = window.getComputedStyle(el);
              return style.display !== "none" && style.visibility !== "hidden";
            };
            const scoreTable = (table) => {
              const rowCount = table.querySelectorAll("tr").length;
              const colCount = table.querySelector("tr")?.querySelectorAll("th,td")?.length || 0;
              return rowCount * Math.max(1, colCount);
            };

            let table = null;
            if (sel) {
              table = document.querySelector(sel);
            }
            if (!table) {
              const candidates = [...document.querySelectorAll("table")].filter(visible);
              if (candidates.length) {
                candidates.sort((a, b) => scoreTable(b) - scoreTable(a));
                table = candidates[0];
              }
            }
            if (!table) return { ok: false, reason: "No table found." };

            const headers = [...table.querySelectorAll("thead th")].map(pick).filter(Boolean);
            const bodyRows = [...table.querySelectorAll("tbody tr")];
            const rows = (bodyRows.length ? bodyRows : [...table.querySelectorAll("tr")])
              .slice(0, rowLimit + 3)
              .map((tr) => {
                const cells = [...tr.querySelectorAll("th,td")].map(pick).filter(Boolean);
                if (!cells.length) return null;
                const row = {};
                cells.forEach((value, index) => {
                  const key = headers[index] || `col${index + 1}`;
                  row[key] = value;
                });
                const link = tr.querySelector("a[href]")?.href || "";
                if (link) row.link = link;
                return row;
              })
              .filter(Boolean);

            return { ok: true, headers, rows: rows.slice(0, rowLimit) };
          },
          args: [selector, maxRows]
        });

        const data = snap?.[0]?.result;
        if (!data?.ok || !Array.isArray(data.rows) || !data.rows.length) {
          return `ERROR: ${data?.reason || "No tabular rows found."}`;
        }

        const availableKeys = Array.from(new Set(data.rows.flatMap((r) => Object.keys(r || {}))));
        const resolvedColumns = columns.length
          ? columns
          : (data.headers?.length ? data.headers : availableKeys).slice(0, 10);
        const normalized = data.rows.map((row) => {
          const out = {};
          resolvedColumns.forEach((col, idx) => {
            const exact = Object.keys(row).find((k) => k.toLowerCase() === col.toLowerCase());
            out[col] = row?.[exact || col] ?? row?.[`col${idx + 1}`] ?? "";
          });
          if (resolvedColumns.every((c) => c.toLowerCase() !== "link")) {
            const linkKey = Object.keys(row).find((k) => k.toLowerCase() === "link");
            if (linkKey) out.link = row[linkKey];
          }
          return out;
        });

        return this.formatRows(normalized, Object.keys(normalized[0] || {}), outputFormat);
      },
      scrapeFields: async (params) => {
        const tab = await this.getActiveInjectableTab();
        const containerSelector = String(params.containerSelector || "").trim();
        const maxRows = Math.max(1, Math.min(200, Number(params.maxRows || 40)));
        const outputFormat = this.normalizeOutputFormat(params.outputFormat || "tsv");
        const fields = Array.isArray(params.fields)
          ? params.fields.map((f) => String(f).trim()).filter(Boolean)
          : String(params.fields || "").split(",").map((f) => f.trim()).filter(Boolean);
        if (!fields.length) return "ERROR: Missing fields for scrapeFields.";

        const snap = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (selector, rowLimit) => {
            const pick = (el) => (el?.innerText || "").replace(/\s+/g, " ").trim();
            const visible = (el) => {
              const style = window.getComputedStyle(el);
              return style.display !== "none" && style.visibility !== "hidden";
            };
            let nodes = [];
            if (selector) nodes = [...document.querySelectorAll(selector)];
            if (!nodes.length) {
              nodes = [...document.querySelectorAll("article, li, tr, .card, [class*='item'], [class*='post'], [role='article']")];
            }
            const samples = nodes
              .filter(visible)
              .slice(0, rowLimit * 3)
              .map((node) => {
                const title = pick(node.querySelector("h1,h2,h3,h4,a[title]"));
                const link = node.querySelector("a[href]")?.href || "";
                const text = pick(node).slice(0, 500);
                if (!text || text.length < 10) return null;
                return { title, link, text };
              })
              .filter(Boolean);
            return { ok: true, samples: samples.slice(0, rowLimit * 2) };
          },
          args: [containerSelector, maxRows]
        });

        const data = snap?.[0]?.result;
        if (!data?.ok || !Array.isArray(data.samples) || !data.samples.length) {
          return "ERROR: No extractable containers found.";
        }

        const raw = data.samples.map((row, i) => `${i + 1}. ${row.title || ""} | ${row.text}${row.link ? ` | LINK: ${row.link}` : ""}`).join("\n");
        const mappedText = await this.ai.chat(
          `Map these page snippets into STRICT JSON array only (no markdown).
Required fields: ${fields.join(", ")}.
Max rows: ${maxRows}.
Use empty string for missing fields.

SNIPPETS:
${raw.substring(0, 14000)}`,
          1400
        );
        let mapped = this.safeParseJsonArray(mappedText);
        if (!mapped) {
          const fallbackRows = data.samples.map((s) => ({ text: `${s.title} | ${s.text}`, link: s.link || "" }));
          mapped = this.mapRowsHeuristically(fallbackRows, fields, maxRows);
        }
        if (!mapped?.length) return "ERROR: scrapeFields could not map rows.";
        const limited = mapped.slice(0, maxRows).map((row) => {
          const out = {};
          fields.forEach((f) => { out[f] = String(row?.[f] ?? ""); });
          return out;
        });
        return this.formatRows(limited, fields, outputFormat);
      },
      parseWithInstructions: async (params) => {
        const outputFormat = this.normalizeOutputFormat(params.outputFormat || "tsv");
        const columns = Array.isArray(params.columns)
          ? params.columns.map((c) => String(c).trim()).filter(Boolean)
          : String(params.columns || "").split(",").map((c) => c.trim()).filter(Boolean);
        const instructions = String(params.instructions || "").trim() || "Reformat the input cleanly.";
        const input = String(
          params.input ||
          stepLog.slice().reverse().find((s) => typeof s.result === "string" && !String(s.result).startsWith("ERROR:"))?.result ||
          ""
        ).trim();
        if (!input) return "ERROR: No prior result available to parse.";

        const prompt = `You are a strict data transformer.
Instructions: ${instructions}
Requested columns: ${columns.length ? columns.join(", ") : "infer from input"}
Return format: ${outputFormat}

Rules:
- If output format is json, return ONLY JSON array.
- If output format is tsv/csv, return ONLY delimited text with one header row.
- Keep rows factual; do not invent missing values.

INPUT:
${input.substring(0, 15000)}`;
        const transformed = await this.ai.chat(prompt, 1300);
        if (outputFormat === "json" && !this.safeParseJsonArray(transformed)) {
          return "ERROR: parseWithInstructions produced invalid JSON.";
        }
        return String(transformed || "").replace(/```(?:json|csv|tsv)?|```/gi, "").trim();
      },
      parseAndFormat: async (params) => {
        const requestedFormat = this.normalizeOutputFormat(params.requestedFormat || params.outputFormat || "tsv");
        const columns = Array.isArray(params.columns || params.expectedColumns)
          ? (params.columns || params.expectedColumns).map((c) => String(c).trim()).filter(Boolean)
          : String(params.columns || params.expectedColumns || "").split(",").map((c) => c.trim()).filter(Boolean);
        const rawInput = String(params.data || params.input || getLastGoodResult() || "").trim();
        if (!rawInput) return "ERROR: No data available to parse.";

        let rows = this.safeParseJsonArray(rawInput);
        if (!rows) {
          const cleaned = rawInput.replace(/```(?:json|csv|tsv)?|```/gi, "").trim();
          const lines = cleaned.split(/\r?\n/).filter(Boolean);
          if (lines.length >= 2) {
            const delim = lines[0].includes("\t") ? "\t" : (lines[0].includes(",") ? "," : "");
            if (delim) {
              const headers = lines[0].split(delim).map((h) => h.trim());
              rows = lines.slice(1).map((line) => {
                const cells = line.split(delim);
                const row = {};
                headers.forEach((h, idx) => { row[h] = String(cells[idx] || "").trim(); });
                return row;
              });
            }
          }
        }
        if (!rows) {
          const repair = await this.ai.chat(
            `Convert the input into STRICT JSON array only (no markdown, no commentary). Preserve factual values.
Input:
${rawInput.substring(0, 12000)}`,
            900
          );
          rows = this.safeParseJsonArray(repair);
        }
        if (!rows?.length) return "ERROR: Could not parse data into rows.";

        const wantedColumns = columns.length ? columns : Array.from(new Set(rows.flatMap((r) => Object.keys(r || {}))));
        const normalized = rows.map((row) => {
          const out = {};
          wantedColumns.forEach((c) => { out[c] = String(row?.[c] ?? ""); });
          return out;
        });
        return this.formatRows(normalized, wantedColumns, requestedFormat);
      },
      validateOutput: async (params) => {
        const expected = Array.isArray(params.expectedColumns)
          ? params.expectedColumns.map((c) => String(c).trim()).filter(Boolean)
          : String(params.expectedColumns || this.inferExtractionPlan(goal).fields.join(","))
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean);
        const rawInput = String(params.input || getLastGoodResult() || "").trim();
        if (!rawInput) return "ERROR: No output available to validate.";

        let rows = this.safeParseJsonArray(rawInput);
        if (!rows) {
          const cleaned = rawInput.replace(/```(?:json|csv|tsv)?|```/gi, "").trim();
          const lines = cleaned.split(/\r?\n/).filter(Boolean);
          if (lines.length >= 2) {
            const delim = lines[0].includes("\t") ? "\t" : (lines[0].includes(",") ? "," : "");
            if (delim) {
              const headers = lines[0].split(delim).map((h) => h.trim());
              rows = lines.slice(1).map((line) => {
                const vals = line.split(delim);
                const row = {};
                headers.forEach((h, idx) => { row[h] = vals[idx] || ""; });
                return row;
              });
            }
          }
        }
        if (!rows?.length) return "ERROR: Output is empty or unparsable.";

        const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r || {})).map((k) => String(k).trim())));
        const missing = expected.filter((c) => !keys.some((k) => k.toLowerCase() === c.toLowerCase()));
        if (missing.length) return `ERROR: Missing expected columns -> ${missing.join(", ")}`;
        memory.validatedOutput = { rows: rows.length, columns: keys };
        return `OK: Output valid (${rows.length} row(s), columns: ${keys.join(", ")})`;
      },
      storeInMemory: async (params) => {
        const key = String(params.key || "").trim();
        if (!key) return "ERROR: Missing memory key.";
        memory[key] = params.value;
        return `OK: Stored key "${key}"`;
      },
      recallFromMemory: async (params) => {
        const key = String(params.key || "").trim();
        if (!key) return "ERROR: Missing memory key.";
        if (memory[key] === undefined) return `ERROR: Memory key "${key}" not found.`;
        if (typeof memory[key] === "string") return memory[key];
        return JSON.stringify(memory[key], null, 2).slice(0, 12000);
      },
      conditionalAction: async (params) => {
        const condition = params.condition;
        const pass = evaluateCondition(condition);
        const action = pass ? params.thenTool : params.elseTool;
        const actionParams = pass ? (params.thenParams || {}) : (params.elseParams || {});
        if (!action) return "ERROR: conditionalAction missing thenTool/elseTool.";
        if (action === "conditionalAction") return "ERROR: Nested conditionalAction not allowed.";
        const result = await executeTool(action, actionParams);
        return `Condition=${pass ? "TRUE" : "FALSE"} | ${action} -> ${String(result).slice(0, 3000)}`;
      },
      loopUntil: async (params) => {
        const action = String(params.action || "").trim();
        if (!action) return "ERROR: loopUntil missing action.";
        const actionParams = params.actionParams || {};
        const maxIterations = Math.max(1, Math.min(12, Number(params.maxIterations || 5)));
        const waitMs = Math.max(0, Math.min(5000, Number(params.waitMs || 500)));
        let lastResult = "";
        for (let i = 0; i < maxIterations; i++) {
          lastResult = await executeTool(action, actionParams);
          if (evaluateCondition(params.condition, { lastResult })) {
            return `OK: loopUntil condition satisfied after ${i + 1} iteration(s).\n${String(lastResult).slice(0, 3000)}`;
          }
          if (waitMs) await Utils.wait(waitMs);
        }
        return `ERROR: loopUntil condition not met after ${maxIterations} iteration(s). Last result: ${String(lastResult).slice(0, 800)}`;
      },
      scroll: async (params) => {
        const tab = await this.getActiveInjectableTab();
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (px) => window.scrollBy(0, px),
          args: [params.pixels || 600]
        });
        await Utils.wait(800);
        return "OK: Scrolled";
      },
      waitForElement: async (params) => {
        const tab = await this.getActiveInjectableTab();
        const selector = String(params.selector || "").trim();
        const timeoutMs = Math.max(500, Math.min(60000, Number(params.timeoutMs || 10000)));
        if (!selector) return "ERROR: Missing selector.";
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (sel, timeout) => {
            const start = Date.now();
            while (Date.now() - start < timeout) {
              const el = document.querySelector(sel);
              if (el) return { ok: true };
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
            return { ok: false, reason: "timeout" };
          },
          args: [selector, timeoutMs]
        });
        const out = res?.[0]?.result;
        if (!out?.ok) return `ERROR: Element not found (${selector}) within ${timeoutMs}ms.`;
        return `OK: Element found (${selector})`;
      },
      downloadFile: async (params) => {
        const content = String(params.content || getLastGoodResult() || "").trim();
        if (!content) return "ERROR: Nothing to download.";
        const format = this.normalizeOutputFormat(params.format || params.outputFormat || "tsv");
        let filename = String(params.filename || "").trim();
        if (!filename) filename = `atom_export_${Date.now()}.${format === "json" ? "json" : format}`;
        const mime = format === "json" ? "application/json" : "text/plain";
        const blob = new Blob([content], { type: mime });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        return `OK: Download started (${filename})`;
      },
      askUserForHelp: async (params) => {
        const message = String(params.message || "Need clarification to continue this task.").trim();
        return `NEED_USER_INPUT: ${message}`;
      },
      crossTabExtract: async (params) => {
        const fields = Array.isArray(params.fields)
          ? params.fields.map((f) => String(f).trim()).filter(Boolean)
          : this.inferExtractionPlan(goal).fields;
        const outputFormat = this.normalizeOutputFormat(params.outputFormat || "tsv");
        const maxTabs = Math.max(1, Math.min(8, Number(params.maxTabs || 4)));
        const maxRows = Math.max(1, Math.min(120, Number(params.maxRows || 40)));
        const tabs = await Utils.getReadableTabs({ currentWindow: true, maxTabs });
        const combined = [];
        for (const tab of tabs) {
          if (!tab?.id || !Utils.isInjectableTab(tab)) continue;
          const rows = await this.collectStructuredPageData(tab.id, Math.max(30, maxRows * 2)).catch(() => []);
          if (!rows?.length) continue;
          const mapped = this.mapRowsHeuristically(rows, fields, maxRows).map((row) => ({
            ...row,
            source_tab: tab.title || "",
            source_url: tab.url || ""
          }));
          combined.push(...mapped);
        }
        if (!combined.length) return "ERROR: crossTabExtract could not collect rows.";
        const finalFields = Array.from(new Set([...(fields || []), "source_tab", "source_url"]));
        return this.formatRows(combined.slice(0, maxRows), finalFields, outputFormat);
      },
      waitForLoad: async (params) => {
        await Utils.wait(params.ms || 2000);
        return `OK: Waited ${params.ms || 2000}ms`;
      }
    };

    const executeTool = async (action, params) => {
      if (!tools[action]) return "ERROR: Unknown action.";
      try {
        return await tools[action](params);
      } catch (e) {
        return "ERROR: " + e.message;
      }
    };

    const executeToolWithRetry = async (action, params, maxRetries = 2) => {
      let workingParams = { ...(params || {}) };
      let result = "";
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        result = await this.runWithTimeout(
          () => executeTool(action, workingParams),
          30000,
          `Step timeout: ${action}`
        );
        if (!String(result).startsWith("ERROR:")) return { result, params: workingParams, attempts: attempt + 1 };
        if (attempt === maxRetries) break;
        if (action === "waitForElement") {
          workingParams.timeoutMs = Math.min(60000, Number(workingParams.timeoutMs || 10000) + 6000);
        }
        if (action === "extractTable" && workingParams.selector) {
          workingParams.selector = "";
        }
        if (action === "scrapeFields" && workingParams.containerSelector) {
          workingParams.containerSelector = "";
        }
        if (action === "readPage" && String(workingParams.mode || "").toLowerCase() !== "structured") {
          workingParams.mode = "structured";
        }
        await Utils.wait(400);
      }
      return { result, params: workingParams, attempts: maxRetries + 1 };
    };

    const runState = {
      status: "running",
      startedAt: Date.now(),
      goal,
      maxSteps,
      step: 0
    };
    this.agentRunState = runState;

    for (let step = 0; step < maxSteps; step++) {
      const remaining = Math.max(0, maxSteps - (step + 1));
      this.showLoader(true, `Agent running... ~${remaining * 5} seconds left`);
      runState.step = step + 1;
      if (this.agentStopped) return "Task stopped by user.";
      if (this.isDurationExceeded(startTime, maxDurationMs)) {
        return "Auto task timed out after 5 minutes.";
      }

      if (!currentPlan) {
        const planResult = await executeTool("createPlan", { goal });
        if (!String(planResult).startsWith("ERROR:")) {
          stepLog.push({ action: "createPlan", params: { goal }, result: planResult });
        }
      }

      const activeTab = await this.getActiveTab().catch(() => null);
      const scratchpad = stepLog.length === 0
        ? "Nothing done yet."
        : stepLog.map((s, i) => `[${i + 1}] ${s.action}(${JSON.stringify(s.params || {}).substring(0, 80)}) -> ${String(s.result || "").substring(0, 180)}`).join("\n");

      if (step > 0 && step % 4 === 0) {
        const autoReflection = await executeTool("selfReflect", { auto: true });
        stepLog.push({ action: "selfReflect", params: { auto: true }, result: autoReflection });
      }

      const decision = await this.ai.chat(`You are an expert browser automation agent. Output ONLY one JSON object and no surrounding text.

GOAL: ${goal}
STEP: ${step + 1} of ${maxSteps}
CURRENT TAB: ${activeTab?.title || "Unknown"}
CURRENT URL: ${activeTab?.url || "Unknown"}
PLAN VERSION: ${planVersion}
CURRENT PLAN:
${currentPlan || "No plan yet"}

MEMORY SNAPSHOT:
${JSON.stringify(memory).slice(0, 2400)}

SCRATCHPAD:
${scratchpad}

AVAILABLE ACTIONS: createPlan, updatePlan, selfReflect, storeInMemory, recallFromMemory, getPageStructure, getElementDetails, navigate, switchTabByTitleOrUrl, typeAndSearch, clickText, readPage, readAllTabs, crossTabExtract, extractData, extractTable, scrapeFields, parseWithInstructions, parseAndFormat, validateOutput, waitForElement, conditionalAction, loopUntil, scroll, waitForLoad, downloadFile, askUserForHelp, DONE

Rules:
- First meaningful action should usually be createPlan if no plan exists.
- Prefer readPage with {"mode":"structured"} before extraction on unknown pages.
- Use getPageStructure before selector-heavy operations.
- Use getElementDetails when a selector fails.
- Use extractTable for table-like pages (rankings, stats, grids).
- Use scrapeFields for card/list pages with repeated blocks.
- Use parseAndFormat or parseWithInstructions after extraction to enforce strict columns/format.
- Use validateOutput before DONE for structured extraction goals.
- Use waitForElement after navigation/click when content may load dynamically.
- Use storeInMemory to keep important outputs and recallFromMemory when needed.
- Use updatePlan if progress stalls or errors repeat.
- Use readAllTabs if the goal mentions multiple tabs, comparing open tabs, or several open companies.
- If a prior step returned ERROR or NOT_FOUND, do not repeat the same action with the same params.
- Use clickText only for visible labels or link text.
- Use navigate only when the user clearly wants a different site/page.
- When enough information is collected, use DONE with a concise final answer grounded in the scratchpad.
- If blocked by ambiguity, use askUserForHelp with one clear question.

For DONE, output {"action":"DONE","params":{"result":"final answer with useful evidence"}}

OUTPUT EXACTLY JSON:`, 320);

      let parsed;
      try {
        parsed = this.parseAgentDecision(decision);
      } catch {
        await this.logDebug("agentLoop.parseAgentDecision", "Failed to parse decision", {
          step: step + 1,
          decision: String(decision || "").slice(0, 400)
        }, "warn");
        continue;
      }

      const actionKey = `${parsed.action}:${JSON.stringify(parsed.params || {})}`;
      const seen = repeatedActions.get(actionKey) || 0;
      if (seen >= 2 && parsed.action !== "DONE") {
        if (parsed.action === "readPage") {
          const fallbackTarget = this.inferExtractionPlan(goal).fields.join(", ");
          const fallbackResult = await executeTool("extractData", { target: fallbackTarget });
          stepLog.push({ action: "extractData", params: { target: fallbackTarget }, result: fallbackResult });
          if (!String(fallbackResult).startsWith("ERROR:")) return fallbackResult;
        }
        stepLog.push({ action: parsed.action, params: parsed.params, result: "ERROR: Repeated action blocked to avoid loops." });
        continue;
      }
      repeatedActions.set(actionKey, seen + 1);

      if (parsed.action === "DONE") return parsed.params?.result || "Task completed.";
      const toolExec = await executeToolWithRetry(parsed.action, parsed.params || {}, 2);
      const result = toolExec.result;
      stepLog.push({ action: parsed.action, params: toolExec.params, result });

      memory.lastAction = parsed.action;
      memory.lastResult = String(result).slice(0, 2500);
      if (!String(result).startsWith("ERROR:")) {
        memory.lastSuccessAt = new Date().toISOString();
      }

      if (String(result).startsWith("ERROR:")) {
        await this.logDebug("agentLoop.tool", String(result), {
          action: parsed.action,
          params: toolExec.params
        }, "warn");
        const recentErrors = stepLog.slice(-3).filter((entry) => String(entry.result).startsWith("ERROR:"));
        if (recentErrors.length >= 3) {
          return this.buildAutomationFailure(goal, stepLog);
        }
        continue;
      }

      if (String(result).startsWith("NEED_USER_INPUT:")) {
        return String(result).replace(/^NEED_USER_INPUT:\s*/i, "Need your input: ");
      }

      if (parsed.action === "extractData" && result.length > 100 && !result.includes("NOT_FOUND")) return result;
      if ((parsed.action === "extractTable" || parsed.action === "scrapeFields" || parsed.action === "parseWithInstructions" || parsed.action === "parseAndFormat") && result.length > 60) return result;
      if (parsed.action === "readAllTabs" && result.length > 150) return result;
      if (parsed.action === "crossTabExtract" && result.length > 120) return result;
      if (parsed.action === "clickText" && result.includes("Clicked YT")) return "Video playing";
    }
    runState.status = "stopped_max_steps";
    return this.buildAutomationFailure(goal, stepLog);
  }
  async crossTabIntelligence() {
    const tabs = await Utils.getReadableTabs({ currentWindow: true, maxTabs: 5 });
    const { sources, skipped } = await Utils.collectTabSources(tabs, { maxLength: 1600, waitMs: 7000 });
    if (!sources.length) return "No readable tabs found.";

    const combined = sources.map((source, index) =>
      `[SOURCE ${index + 1}] ${source.title}\nDomain: ${source.domain}\nURL: ${source.url}\n${source.text}`
    ).join("\n\n---\n\n");

    const synthesis = await this.ai.chat(`You are a market intelligence analyst. Analyze these ${sources.length} open tabs together.

Requirements:
- Cite each important claim with [Source: domain]
- Flag contradictions explicitly
- Mention when evidence is thin
- Keep the answer practical and specific

Produce:
1. KEY FACTS
2. CONTRADICTIONS OR GAPS
3. UNIQUE INSIGHTS
4. UNIFIED SUMMARY
5. BEST NEXT ACTION

Sources:
${combined}`, 1600);

    const appendix = this.buildSourceAppendix(sources, skipped);
    return appendix ? `${synthesis}\n\n${appendix}` : synthesis;
  }
  async multiTabResearch() {
    const btn = document.getElementById("readAllTabsBtn");
    if (btn) { btn.disabled = true; btn.innerText = "Reading..."; }
    this.showLoader(true, "Reading open tabs...");
    try {
      const tabs = await Utils.getReadableTabs({ currentWindow: true, maxTabs: 4 });
      const { sources, skipped } = await Utils.collectTabSources(tabs, { maxLength: 1700, waitMs: 7000 });
      if (!sources.length) {
        this.setResult("Could not read any open website tabs. Open 2 to 4 normal websites first.");
        return;
      }
      const combined = sources.map((s, i) => `[TAB ${i + 1}] ${s.title}\nDomain: ${s.domain}\nURL: ${s.url}\n\n${s.text}`).join("\n\n----------------------------------------\n\n");
      const report = await this.ai.chat(`You are a market intelligence analyst. Analyze these ${sources.length} open tabs and produce a structured report.

${combined.substring(0, 7000)}

Write this report:
============================
MULTI-TAB INTELLIGENCE
Tabs: ${sources.map((s) => s.domain).join(" | ")}
============================

1. EACH SOURCE
${sources.map((s, i) => `${i + 1}. ${s.domain} - what this page is, in one sentence`).join("\n")}

2. KEY FACTS
- Every major fact must cite [Source: domain]

3. CONTRADICTIONS OR GAPS
- Flag conflicting claims
- Say "No clear contradiction found" if everything aligns

4. UNIQUE INSIGHTS
- One strong insight per source when possible

5. COMPARISON
- If these are competitors, compare pricing, features, and target market
- If not competitors, explain how they relate

6. OPPORTUNITY
- Best sales or business angle based on everything read

7. SOURCE QUALITY
- Mention weak sources, thin evidence, or skipped tabs`, 1800);

      const appendix = this.buildSourceAppendix(sources, skipped);
      const finalReport = appendix ? `${report}\n\n${appendix}` : report;
      this.setResult(finalReport);
      const data = await chrome.storage.local.get(["researchHistory"]);
      const history = data.researchHistory || [];
      history.unshift({
        id: Date.now(),
        topic: "Multi-tab: " + sources.map((s) => s.domain).join(", "),
        report: finalReport,
        type: "deep",
        savedAt: new Date().toLocaleString(),
        preview: finalReport.substring(0, 120),
        date: Date.now()
      });
      if (history.length > 100) history.pop();
      await chrome.storage.local.set({ researchHistory: history });
    } catch (e) {
      this.setResult("Error: " + e.message);
    } finally {
      this.showLoader(false);
      if (btn) { btn.disabled = false; btn.innerText = "Research All Open Tabs"; }
    }
  }
  taskTemplate(task) {
    document.getElementById("prompt").value = task;
    this.runAgent();
  }

  async getWorkflowState() {
    const res = await chrome.runtime.sendMessage({ type: "WORKFLOW_GET_STATE" });
    return res?.state || { recording: false, recordedSteps: [], status: "No workflow recorded.", tabId: null };
  }

  async getWorkflowTargetTab(preferredTabId = null) {
    if (preferredTabId) {
      try {
        const tab = await chrome.tabs.get(preferredTabId);
        if (Utils.isInjectableTab(tab)) return tab;
      } catch (e) {}
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  getWorkflowRecorderScript() {
    return () => {
      const loadSteps = async () => {
        try {
          const key = `workflowSteps:${location.origin}:${location.pathname}`;
          const data = await chrome.storage.local.get([key]);
          return Array.isArray(data[key]) ? data[key] : [];
        } catch (e) {
          return [];
        }
      };

      const persistSteps = async () => {
        try {
          const key = `workflowSteps:${location.origin}:${location.pathname}`;
          await chrome.storage.local.set({ [key]: window.__workflowSteps || [] });
        } catch (e) {}
        try {
          chrome.runtime.sendMessage({
            type: "WORKFLOW_SYNC_STEPS",
            steps: window.__workflowSteps || [],
            tabId: window.__workflowTabId || null,
            status: `Recording... ${window.__workflowSteps?.length || 0} step(s) captured`
          });
        } catch (e) {}
      };

      const buildSelector = (el) => {
        if (!el) return null;
        if (el.id) return `#${CSS.escape(el.id)}`;
        if (el.getAttribute("name")) return `${el.tagName.toLowerCase()}[name="${el.getAttribute("name")}"]`;
        if (el.getAttribute("data-testid")) return `[data-testid="${el.getAttribute("data-testid")}"]`;
        if (el.getAttribute("aria-label")) return `${el.tagName.toLowerCase()}[aria-label="${el.getAttribute("aria-label")}"]`;
        if (el.placeholder) return `${el.tagName.toLowerCase()}[placeholder="${el.placeholder}"]`;
        if (el.type) return `${el.tagName.toLowerCase()}[type="${el.type}"]`;
        return el.tagName.toLowerCase();
      };

      const upsertFillStep = (selector, value) => {
        const steps = window.__workflowSteps;
        const last = steps[steps.length - 1];
        if (last && last.action === "fillInput" && last.selector === selector && last.url === location.href) {
          last.value = value;
          last.timestamp = Date.now();
        } else {
          steps.push({ action: "fillInput", selector, value, url: location.href, timestamp: Date.now() });
        }
      };

      const clickListener = (e) => {
        if (!window.__workflowRecording) return;
        const el = e.target?.closest("a, button, input, select, textarea, [role='button'], [onclick]");
        if (!el) return;
        const selector = buildSelector(el);
        if (!selector) return;
        window.__workflowSteps.push({
          action: "click",
          selector,
          url: location.href,
          timestamp: Date.now(),
          text: (el.innerText || el.value || "").substring(0, 80)
        });
        persistSteps();
      };

      const inputListener = (e) => {
        if (!window.__workflowRecording) return;
        const el = e.target;
        if (!el || !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
        const selector = buildSelector(el);
        if (!selector) return;

        if (el.tagName === "SELECT" || el.type === "checkbox" || el.type === "radio") {
          upsertFillStep(selector, el.type === "checkbox" ? Boolean(el.checked) : el.value);
        } else {
          upsertFillStep(selector, el.value);
        }
        persistSteps();
      };

      if (window.__workflowListeners) {
        document.removeEventListener("click", window.__workflowListeners.click, true);
        document.removeEventListener("input", window.__workflowListeners.input, true);
        document.removeEventListener("change", window.__workflowListeners.change, true);
      }

      return (async () => {
        window.__workflowSteps = await loadSteps();
        window.__workflowTabId = window.__workflowTabId || null;
        window.__workflowRecording = true;
        window.__workflowListeners = {
          click: clickListener,
          input: inputListener,
          change: inputListener
        };

        document.addEventListener("click", window.__workflowListeners.click, true);
        document.addEventListener("input", window.__workflowListeners.input, true);
        document.addEventListener("change", window.__workflowListeners.change, true);
        await persistSteps();

        return {
          ok: true,
          url: location.href,
          stepCount: window.__workflowSteps.length
        };
      })();
    };
  }

  async startRecording() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Utils.isInjectableTab(tab)) {
      document.getElementById("workflowStatus").innerText = "⚠️ Go to a real website first, then click Record.";
      return;
    }
    await chrome.runtime.sendMessage({
      type: "WORKFLOW_SET_RECORDING",
      recording: true,
      tabId: tab.id,
      status: "⏺ Recording... Interact with the page, then reopen Atom.AI to stop."
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: this.getWorkflowRecorderScript()
    });
    await this.updateWorkflowUI();
  }

  async stopRecording() {
    const state = await this.getWorkflowState();
    const tab = await this.getWorkflowTargetTab(state.tabId);
    if (!Utils.isInjectableTab(tab)) {
      document.getElementById("workflowStatus").innerText = "⚠️ Could not reconnect to the recorded tab.";
      return;
    }

    let steps = [];
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          window.__workflowRecording = false;
          if (window.__workflowListeners) {
            document.removeEventListener("click", window.__workflowListeners.click, true);
            document.removeEventListener("input", window.__workflowListeners.input, true);
            document.removeEventListener("change", window.__workflowListeners.change, true);
          }
          return (async () => {
            let savedSteps = window.__workflowSteps || [];
            if (!savedSteps.length) {
              try {
                const key = `workflowSteps:${location.origin}:${location.pathname}`;
                const data = await chrome.storage.local.get([key]);
                if (Array.isArray(data[key])) savedSteps = data[key];
                await chrome.storage.local.remove([key]);
              } catch (e) {}
            }
            return savedSteps;
          })();
        }
      });
      steps = res?.[0]?.result || [];
    } catch (e) {
      steps = state.recordedSteps || [];
    }

    if (!steps.length && state.recordedSteps?.length) {
      steps = state.recordedSteps;
    }

    await chrome.runtime.sendMessage({ type: "WORKFLOW_SAVE_STEPS", steps });
    await this.updateWorkflowUI();
  }

  async replayWorkflow() {
    const state = await this.getWorkflowState();
    const steps = state.recordedSteps || [];
    if (!steps.length) {
      document.getElementById("workflowStatus").innerText = "No workflow to replay.";
      return;
    }
    const btn = document.getElementById("workflowReplay");
    if (btn) btn.disabled = true;
    document.getElementById("workflowStatus").innerText = "▶ Replaying...";
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let currentUrl = tab?.url || "";
    let failedSteps = 0;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      try {
        if (step.url && currentUrl !== step.url) {
          await chrome.tabs.update(tab.id, { url: step.url });
          await Utils.waitForTab(tab.id, 10000);
          await Utils.wait(800);
          currentUrl = step.url;
        }
        if (step.action === "click") {
          const clickRes = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (sel, txt) => {
              const el = document.querySelector(sel);
              if (el) {
                el.scrollIntoView({ block: "center" });
                el.click();
                return { ok: true, mode: "selector" };
              }
              const normalized = (txt || "").toLowerCase().trim();
              if (normalized) {
                const candidates = [...document.querySelectorAll("a,button,[role='button'],input[type='button'],input[type='submit']")];
                const byText = candidates.find((node) =>
                  (node.innerText || node.value || node.getAttribute("aria-label") || "").toLowerCase().includes(normalized)
                );
                if (byText) {
                  byText.scrollIntoView({ block: "center" });
                  byText.click();
                  return { ok: true, mode: "text" };
                }
              }
              return { ok: false };
            },
            args: [step.selector, step.text || ""]
          });
          if (!clickRes?.[0]?.result?.ok) failedSteps++;
        } else if (step.action === "fillInput") {
          const fillRes = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (sel, val, labelText) => {
              const el = document.querySelector(sel);
              if (el) {
                el.focus();
                if (typeof val === "boolean" && el.type === "checkbox") {
                  el.checked = val;
                } else {
                  el.value = val;
                }
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
                return { ok: true, mode: "selector" };
              }
              const normalized = (labelText || "").toLowerCase().trim();
              if (normalized) {
                const inputCandidates = [...document.querySelectorAll("input,textarea,select")];
                const byHint = inputCandidates.find((node) => {
                  const hint = `${node.placeholder || ""} ${node.name || ""} ${node.id || ""} ${(node.getAttribute("aria-label") || "")}`.toLowerCase();
                  return hint.includes(normalized);
                });
                if (byHint) {
                  byHint.focus();
                  if (typeof val === "boolean" && byHint.type === "checkbox") byHint.checked = val;
                  else byHint.value = val;
                  byHint.dispatchEvent(new Event("input", { bubbles: true }));
                  byHint.dispatchEvent(new Event("change", { bubbles: true }));
                  return { ok: true, mode: "hint" };
                }
              }
              return { ok: false };
            },
            args: [step.selector, step.value, step.text || ""]
          });
          if (!fillRes?.[0]?.result?.ok) failedSteps++;
        }
        await Utils.wait(600);
      } catch (e) {
        failedSteps++;
      }
    }
    const successCount = Math.max(0, steps.length - failedSteps);
    document.getElementById("workflowStatus").innerText = failedSteps
      ? `Replayed ${successCount}/${steps.length} steps. ${failedSteps} step(s) failed.`
      : `Replayed ${steps.length} steps.`;
    if (btn) btn.disabled = false;
  }
  async clearWorkflow() {
    await chrome.runtime.sendMessage({ type: "WORKFLOW_CLEAR" });
    this.updateWorkflowUI();
  }

  async updateWorkflowUI() {
    const state = await this.getWorkflowState();
    if (!state) return;
    document.getElementById("workflowStatus").innerText = state.status;
    document.getElementById("workflowRecord").disabled = state.recording;
    document.getElementById("workflowStop").disabled = !state.recording;
    document.getElementById("workflowReplay").disabled = state.recordedSteps.length === 0;
    const stepCount = document.getElementById("workflowStepCount");
    const liveBadge = document.getElementById("workflowLiveBadge");
    const stateLabel = document.getElementById("workflowStateLabel");
    if (stepCount) stepCount.innerText = String(state.recordedSteps.length || 0);
    if (liveBadge) liveBadge.innerText = state.recording ? "Recording" : (state.recordedSteps.length ? "Ready to replay" : "Idle");
    if (stateLabel) stateLabel.innerText = state.recording ? "Capturing" : (state.recordedSteps.length ? "Saved" : "Ready");
  }

  showLoader(show, msg) {
    const l = document.getElementById("loader");
    if (l) {
      l.style.display = show ? "block" : "none";
      if (msg) l.innerText = "⚡ " + msg;
    }
  }

  setResult(text) {
    const r = document.getElementById("result");
    if (r) r.innerText = text;
    document.dispatchEvent(new CustomEvent("atom:result-meta", {
      detail: {
        area: "automate",
        text,
        signal: text && text.length > 500 ? "Deep output" : "Quick output"
      }
    }));
    this.pushResult(text);
  }

  pushResult(text) {
    if (!text || text === "Result will appear here...") return;
    if (this.resultHistory[this.resultHistory.length - 1] === text) return;
    this.resultHistory.push(text);
    if (this.resultHistory.length > 10) this.resultHistory.shift();
    this.resultIndex = this.resultHistory.length - 1;
    this.updateResultNav();
    chrome.storage.local.set({ resultHistory: this.resultHistory, resultIndex: this.resultIndex });
  }

  updateResultNav() {
    const counter = document.getElementById("resultCounter");
    if (counter) {
      counter.innerText = this.resultHistory.length ? `${this.resultIndex+1}/${this.resultHistory.length}` : "";
    }
  }

  prevResult() {
    if (this.resultIndex > 0) {
      this.resultIndex--;
      const text = this.resultHistory[this.resultIndex];
      document.getElementById("result").innerText = text;
      document.dispatchEvent(new CustomEvent("atom:result-meta", {
        detail: {
          area: "automate",
          text,
          signal: text && text.length > 500 ? "Deep output" : "Quick output"
        }
      }));
      this.updateResultNav();
    }
  }

  nextResult() {
    if (this.resultIndex < this.resultHistory.length - 1) {
      this.resultIndex++;
      const text = this.resultHistory[this.resultIndex];
      document.getElementById("result").innerText = text;
      document.dispatchEvent(new CustomEvent("atom:result-meta", {
        detail: {
          area: "automate",
          text,
          signal: text && text.length > 500 ? "Deep output" : "Quick output"
        }
      }));
      this.updateResultNav();
    }
  }

  async copyResult() {
    const text = document.getElementById("result").innerText;
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById("copy");
    if (btn) {
      const prev = btn.innerText;
      btn.innerText = "✅ Copied!";
      setTimeout(() => btn.innerText = prev, 1200);
    }
  }

  convertToMarkdownTable(text) {
    const raw = String(text || "").trim();
    const arr = this.safeParseJsonArray(raw);
    if (arr?.length) {
      const cols = Array.from(new Set(arr.flatMap((r) => Object.keys(r || {}))));
      const head = `| ${cols.join(" | ")} |`;
      const sep = `| ${cols.map(() => "---").join(" | ")} |`;
      const rows = arr.map((row) => `| ${cols.map((c) => String(row?.[c] ?? "")).join(" | ")} |`);
      return [head, sep, ...rows].join("\n");
    }
    if (raw.includes("\t")) {
      return raw.split(/\r?\n/).map((line, idx) => {
        const row = `| ${line.split("\t").map((x) => x.trim()).join(" | ")} |`;
        if (idx === 0) {
          const sep = `| ${line.split("\t").map(() => "---").join(" | ")} |`;
          return `${row}\n${sep}`;
        }
        return row;
      }).join("\n");
    }
    return raw;
  }

  async copyAsMarkdownTable() {
    const text = document.getElementById("result")?.innerText || "";
    await navigator.clipboard.writeText(this.convertToMarkdownTable(text));
  }

  async exportResultToSheets() {
    const text = document.getElementById("result")?.innerText || "";
    const tsv = Utils.textToTSV(text);
    const res = await this.tryWriteToGoogleSheets(tsv);
    this.setAutomationStatus(res.ok ? "Prepared Google Sheets export." : res.reason);
  }

  async saveResult() {
    const text = document.getElementById("result").innerText;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const d = await chrome.storage.local.get(["notes"]);
    const notes = d.notes || [];
    notes.push({ text, savedAt: new Date().toLocaleString(), url: tab?.url || "" });
    await chrome.storage.local.set({ notes });
    const btn = document.getElementById("save");
    if (btn) {
      const prev = btn.innerText;
      btn.innerText = "✅ Saved!";
      setTimeout(() => btn.innerText = prev, 1200);
    }
  }

  exportResult() {
    const blob = new Blob([document.getElementById("result").innerText], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "atom_research.txt";
    a.click();
  }

  async clearNotes() {
    if (confirm("Clear all saved notes?")) {
      await chrome.storage.local.set({ notes: [] });
      this.setResult("🗑️ Notes cleared.");
    }
  }
}





