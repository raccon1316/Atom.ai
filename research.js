// research.js
import { Utils } from './utils.js';

export class Research {
  constructor(ai, userSettings) {
    this.ai = ai;
    this.userSettings = userSettings;
    this.selectedCompanyType = "sales";
    this.initEventListeners();
  }

  showProgress(show, steps = []) {
    const panel = document.getElementById("researchProgress");
    const stepsEl = document.getElementById("progressSteps");
    const bar = document.getElementById("progressBarFill");
    if (!panel) return;
    panel.style.display = show ? "block" : "none";
    if (stepsEl) {
      stepsEl.innerHTML = "";
      steps.forEach((step) => {
        const div = document.createElement("div");
        div.innerText = step;
        stepsEl.appendChild(div);
      });
    }
    if (bar) bar.style.width = show ? "20%" : "0%";
  }

  setProgress(stepText, progressPercent) {
    const stepsEl = document.getElementById("progressSteps");
    const bar = document.getElementById("progressBarFill");
    if (stepsEl && stepText) {
      const div = document.createElement("div");
      div.innerText = stepText;
      stepsEl.appendChild(div);
    }
    if (bar && typeof progressPercent === "number") {
      bar.style.width = `${Math.max(0, Math.min(100, progressPercent))}%`;
    }
  }

  initEventListeners() {
    const btn = document.getElementById("companyResearch");
    if (btn) btn.addEventListener("click", () => this.runCompanyResearch());

    const personBtn = document.getElementById("personResearch");
    if (personBtn) personBtn.addEventListener("click", () => this.runPersonResearch());

    const deepBtn = document.getElementById("intelResearch");
    if (deepBtn) deepBtn.addEventListener("click", () => this.deepResearch());

    const multiTabBtn = document.getElementById("intelMultiTab");
    if (multiTabBtn) multiTabBtn.addEventListener("click", () => this.multiTabResearch());

    const compareBtn = document.getElementById("intelCompare");
    if (compareBtn) compareBtn.addEventListener("click", () => this.compare());

    const marketSizeBtn = document.getElementById("marketSize");
    if (marketSizeBtn) marketSizeBtn.addEventListener("click", () => this.marketSize());

    const marketTrendsBtn = document.getElementById("marketTrends");
    if (marketTrendsBtn) marketTrendsBtn.addEventListener("click", () => this.marketTrends());

    const marketPlayersBtn = document.getElementById("marketPlayers");
    if (marketPlayersBtn) marketPlayersBtn.addEventListener("click", () => this.marketPlayers());
    const battleBtn = document.getElementById("generateBattleCard");
    if (battleBtn) battleBtn.addEventListener("click", () => this.runBattleCard());

    // Type chips
    document.querySelectorAll(".company-type-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        document.querySelectorAll(".company-type-chip").forEach(c => c.classList.remove("active"));
        chip.classList.add("active");
        this.selectedCompanyType = chip.dataset.type;
      });
    });

    // Page analysis chips
    document.querySelectorAll(".intel-chip").forEach(chip => {
      chip.addEventListener("click", () => this.pageAnalysis(chip.dataset.action));
    });
  }

  async runCompanyResearch() {
    const company = document.getElementById("companyName").value.trim();
    if (!company) return alert("Enter a company name or URL");
    const btn = document.getElementById("companyResearch");
    btn.disabled = true;
    btn.innerText = "🔄 Researching...";
    try {
      this.showProgress(true, ["Starting company research..."]);
      const report = await this.salesResearch(company);
      const resultEl = document.getElementById("companyResult");
      resultEl.style.display = "block";
      resultEl.innerText = report;
      this.showReportActions("companyResult", company, report);
      await this.saveToHistory(company, report, "company");
    } catch (e) {
      document.getElementById("companyResult").innerText = "⚠️ Research failed: " + e.message;
    } finally {
      this.showProgress(false);
      btn.disabled = false;
      btn.innerText = "⚡ Generate Sales Brief";
    }
  }

  async salesResearch(company) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeHost = activeTab?.url ? new URL(activeTab.url).hostname.replace("www.", "") : "";
    const companySlug = company.toLowerCase().replace(/[^a-z0-9]/g, "");
    const isOnCompanySite = activeHost.includes(companySlug.substring(0, 5)) && Utils.isInjectableTab(activeTab);

    const fetchPageText = async (url) => {
      try {
        const tab = await chrome.tabs.create({ url, active: false });
        const text = await Promise.race([Utils.getPageText(tab.id), new Promise(r => setTimeout(() => r(""), 8000))]);
        await chrome.tabs.remove(tab.id);
        return text || "";
      } catch { return ""; }
    };

    const fetchGoogleSnippets = async (query) => {
      try {
        const url = "https://www.google.com/search?q=" + encodeURIComponent(query);
        const tab = await chrome.tabs.create({ url, active: false });
        await Utils.waitForTab(tab.id, 5000);
        await Utils.wait(800);
        const text = await Utils.getPageText(tab.id);
        await chrome.tabs.remove(tab.id);
        return text || "";
      } catch { return ""; }
    };

    const fetchCompanySite = async () => {
      if (isOnCompanySite) {
        return await Utils.getPageText(activeTab.id);
      }
      // Find official site via Google
      const searchText = await fetchGoogleSnippets(company + " official site about product");
      const links = await (async () => {
        const tab = await chrome.tabs.create({ url: "https://www.google.com/search?q=" + encodeURIComponent(company + " official website about"), active: false });
        await Utils.waitForTab(tab.id, 5000);
        await Utils.wait(800);
        const links = await Utils.getGoogleLinks(tab.id);
        await chrome.tabs.remove(tab.id);
        return links;
      })();
      if (links[0]) return await fetchPageText(links[0]);
      return searchText;
    };

    const websiteData = await (async () => {
      if (isOnCompanySite) return await Utils.getPageText(activeTab.id);
      return await fetchCompanySite();
    })();

    const [newsData, peopleData, painData, compData] = await Promise.all([
      fetchGoogleSnippets(company + " site:techcrunch.com OR site:reuters.com OR site:bloomberg.com OR site:forbes.com 2025"),
      fetchGoogleSnippets('"' + company + '" CEO OR founder OR "head of" OR "VP of" site:linkedin.com OR site:crunchbase.com'),
      fetchGoogleSnippets(company + " reviews biggest problem OR main issue OR negative site:g2.com OR site:reddit.com OR site:glassdoor.com"),
      fetchGoogleSnippets(company + " competitors alternatives vs site:g2.com OR site:crunchbase.com OR site:capterra.com")
    ]);

    const allData = `=== COMPANY WEBSITE ===\n${websiteData.substring(0, 2500)}\n\n=== NEWS ===\n${newsData.substring(0, 2000)}\n\n=== LEADERSHIP ===\n${peopleData.substring(0, 1500)}\n\n=== PAIN SIGNALS ===\n${painData.substring(0, 1500)}\n\n=== COMPETITORS ===\n${compData.substring(0, 1500)}`;

    const typePrompts = {
      sales: this.buildSalesPrompt(company, allData),
      full: this.buildFullPrompt(company, allData),
      competitor: this.buildCompetitorPrompt(company, allData),
      investor: this.buildInvestorPrompt(company, allData)
    };
    const report = await this.ai.chat(typePrompts[this.selectedCompanyType], 1500);
    return report;
  }

  buildSalesPrompt(company, data) {
    return `You are a senior B2B sales intelligence analyst. Write a sales brief for ${company}. Use the data below. Format exactly as:

⚡ SALES BRIEF — ${company.toUpperCase()}
🏢 WHAT THEY DO
💰 COMPANY SNAPSHOT
🔥 THEIR PAIN POINTS
📰 RECENT NEWS
👤 WHO TO CALL
⚔️ THEIR COMPETITORS
🎯 OPENING LINE
⚠️ DO NOT REFERENCE
📊 CONFIDENCE: [X/100]

DATA:
${data}`;
  }

  buildFullPrompt(company, data) {
    return `You are a senior business intelligence analyst. Write a company dossier for ${company}. Use the data below. Format exactly as:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🗂️ COMPANY INTELLIGENCE REPORT — ${company.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🏢 WHAT THEY DO
📊 COMPANY SNAPSHOT
🛠️ PRODUCTS & PRICING
👥 LEADERSHIP
📈 GROWTH SIGNALS (Last 90 days)
⚔️ COMPETITIVE LANDSCAPE
📰 RECENT NEWS
⚠️ RISKS & RED FLAGS
🔮 12-MONTH OUTLOOK
📊 RESEARCH CONFIDENCE: [X/100]

DATA:
${data}`;
  }

  buildCompetitorPrompt(company, data) {
    return `You are a competitive intelligence analyst. Write a competitor analysis for ${company}. Use the data below. Format exactly as:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚔️ COMPETITIVE INTEL — ${company.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🏆 MARKET POSITION
💪 GENUINE STRENGTHS
😟 REAL WEAKNESSES
⚔️ THEIR TOP COMPETITORS
🎯 HOW TO WIN AGAINST ${company.toUpperCase()}
😤 OBJECTIONS THEY CANNOT ANSWER WELL
💡 MARKET GAPS
📊 RESEARCH CONFIDENCE: [X/100]

DATA:
${data}`;
  }

  buildInvestorPrompt(company, data) {
    return `You are a VC analyst. Write an investor brief for ${company}. Use the data below. Format exactly as:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 INVESTOR BRIEF — ${company.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚡ VERDICT
📌 INVESTMENT THESIS
💰 FUNDING & FINANCIALS
📈 GROWTH SIGNALS
🏆 COMPETITIVE MOAT
🌍 MARKET OPPORTUNITY
⚠️ KEY RISKS
🚪 EXIT SCENARIOS
📊 RESEARCH CONFIDENCE: [X/100]

DATA:
${data}`;
  }

  async runPersonResearch() {
    const person = document.getElementById("personName").value.trim();
    if (!person) return alert("Enter a person name");
    const btn = document.getElementById("personResearch");
    btn.disabled = true;
    btn.innerText = "🔄 Researching...";
    try {
      const resultEl = document.getElementById("companyResult");
      resultEl.style.display = "block";
      resultEl.innerText = "🔄 Finding information...";
      const [bioData, newsData, linkedinData] = await Promise.all([
        Utils.googleResearch(person + " biography career background"),
        Utils.googleResearch(person + " interview quote opinion 2025"),
        Utils.googleResearch('"' + person + '" site:linkedin.com OR site:crunchbase.com OR site:twitter.com')
      ]);
      const combined = [bioData, newsData, linkedinData].join("\n\n").substring(0, 6000);
      const personReport = await this.ai.chat(`You are a sales intelligence analyst. Prepare a pre-meeting brief on ${person}. Be specific and useful. Use the data below. Format exactly as:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 PERSON BRIEF — ${person.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🧑 WHO THEY ARE
💼 CAREER PATTERN
🎯 WHAT DRIVES THEM
💬 HOW TO APPROACH
🔑 3 SPECIFIC TALKING POINTS
❓ 3 SMART QUESTIONS TO ASK
📰 RECENT ACTIVITY
📊 RESEARCH CONFIDENCE: [X/100]

DATA:
${combined}`);
      resultEl.innerText = personReport;
      this.showReportActions("companyResult", person, personReport);
      await this.saveToHistory(person, personReport, "person");
    } catch (e) {
      document.getElementById("companyResult").innerText = "⚠️ Research failed: " + e.message;
    } finally {
      btn.disabled = false;
      btn.innerText = "👤 Research This Person";
    }
  }

  async deepResearch() {
    const topic = document.getElementById("intelTopic").value.trim();
    if (!topic) return alert("Enter a research topic");
    const btn = document.getElementById("intelResearch");
    btn.disabled = true;
    btn.innerText = "🔄 Researching...";
    try {
      const resultEl = document.getElementById("intelResult");
      resultEl.style.display = "block";
      this.showProgress(true, ["Searching sources..."]);
      resultEl.innerText = "🔄 Searching multiple sources...";
      const combined = await Utils.googleResearch(topic + " 2025");
      this.setProgress("Analyzing source data...", 55);
      const report = await this.ai.chat(`You are a professional business research analyst. Write a structured research report on: "${topic}". Use the data below. Format exactly as:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ATOM.AI RESEARCH REPORT
Topic: ${topic}
Date: ${new Date().toDateString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔍 OVERVIEW
📊 KEY FACTS & DATA
📰 RECENT DEVELOPMENTS
⚖️ DIFFERENT PERSPECTIVES
🔮 OUTLOOK & IMPLICATIONS
📚 SOURCES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DATA:
${combined.substring(0, 8000)}`);
      this.setProgress("Finalizing report...", 100);
      resultEl.innerText = report;
      this.showReportActions("intelResult", topic, report);
      await this.saveToHistory(topic, report, "deep");
    } catch (e) {
      document.getElementById("intelResult").innerText = "⚠️ Research failed: " + e.message;
    } finally {
      this.showProgress(false);
      btn.disabled = false;
      btn.innerText = "🔬 Deep Research";
    }
  }

  async multiTabResearch() {
    const topic = document.getElementById("intelTopic").value.trim();
    if (!topic) return alert("Enter a topic");
    const btn = document.getElementById("intelMultiTab");
    btn.disabled = true;
    btn.innerText = "Loading...";
    try {
      const resultEl = document.getElementById("intelResult");
      resultEl.style.display = "block";
      this.showProgress(true, ["Opening sources..."]);
      resultEl.innerText = "Gathering multiple sources...";
      const urls = [
        "https://en.wikipedia.org/wiki/" + encodeURIComponent(topic),
        "https://news.google.com/search?q=" + encodeURIComponent(topic),
        "https://www.google.com/search?q=" + encodeURIComponent(topic)
      ];

      const sources = [];
      const skipped = [];
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        const domain = (() => { try { return new URL(url).hostname; } catch { return url; } })();
        this.setProgress(`Reading tab ${i + 1}/${urls.length}: ${domain}`, Math.round(((i + 1) / urls.length) * 85));
        const source = await Utils.openAndReadUrl(url, { active: false, maxLength: 2800, waitMs: 9000 });
        if (source.ok) {
          sources.push(source);
        } else {
          skipped.push({ title: source.title || source.domain, url, reason: source.error || "Unreadable source" });
        }
      }

      if (!sources.length) {
        resultEl.innerText = "Could not read the research sources for this topic.";
        return;
      }

      const combined = sources.map((source, index) =>
        `[SOURCE ${index + 1}] ${source.title}\nDomain: ${source.domain}\nURL: ${source.url}\n${source.text}`
      ).join("\n\n---\n\n");

      const appendixLines = [];
      appendixLines.push("SOURCES USED");
      appendixLines.push(...sources.map((source, index) => `${index + 1}. ${source.domain} - ${source.title}`));
      if (skipped.length) {
        appendixLines.push("");
        appendixLines.push("SKIPPED SOURCES");
        appendixLines.push(...skipped.map((item, index) => `${index + 1}. ${item.url} - ${item.reason}`));
      }

      const report = await this.ai.chat(`Multi-source research on: "${topic}"

Requirements:
- Cite important claims with [Source: domain]
- Separate confirmed facts from inferred insights
- Flag gaps or conflicting evidence
- Keep the report specific and decision-useful

Research material:
${combined.substring(0, 10000)}

Write sections:
1. Overview
2. Key Facts
3. Latest News
4. Insights and Implications
5. Risks or Gaps
6. Source Quality`, 1600);
      this.setProgress("Building final report...", 100);

      const finalReport = report + "\n\n" + appendixLines.join("\n");
      resultEl.innerText = finalReport;
      this.showReportActions("intelResult", topic, finalReport);
      await this.saveToHistory(topic, finalReport, "deep");
    } catch (e) {
      document.getElementById("intelResult").innerText = "Research failed: " + e.message;
    } finally {
      this.showProgress(false);
      btn.disabled = false;
      btn.innerText = "Multi-Source";
    }
  }
  async compare() {
    const topic = document.getElementById("intelTopic").value.trim();
    if (!topic) return alert("Enter two things to compare e.g. 'Notion vs Airtable'");
    const btn = document.getElementById("intelCompare");
    btn.disabled = true;
    btn.innerText = "🔄 Comparing...";
    try {
      const resultEl = document.getElementById("intelResult");
      resultEl.style.display = "block";
      resultEl.innerText = "🔄 Researching both sides...";
      const combined = await Utils.googleResearch(topic);
      const report = await this.ai.chat(`Compare: "${topic}"\n\nResearch:\n${combined.substring(0, 6000)}\n\nFormat:\n📋 Overview\n⚡ Key Differences\n✅ Option A — Pros/Cons\n✅ Option B — Pros/Cons\n🏆 Verdict`);
      resultEl.innerText = report;
      this.showReportActions("intelResult", topic, report);
      await this.saveToHistory(topic, report, "compare");
    } catch (e) {
      document.getElementById("intelResult").innerText = "⚠️ Compare failed: " + e.message;
    } finally {
      btn.disabled = false;
      btn.innerText = "⚖️ Compare";
    }
  }

  async marketSize() {
    const topic = document.getElementById("marketTopic").value.trim();
    if (!topic) return alert("Enter an industry or market");
    const btn = document.getElementById("marketSize");
    btn.disabled = true;
    btn.innerText = "🔄 Researching...";
    try {
      const resultEl = document.getElementById("intelResult");
      resultEl.style.display = "block";
      resultEl.innerText = "🔄 Analyzing market size...";
      const combined = await Utils.googleResearch(topic + " market size TAM revenue 2025");
      const report = await this.ai.chat(`Market size analysis for: "${topic}"\n\nData:\n${combined.substring(0, 8000)}\n\nProvide:\n📊 Total Market Size (TAM)\n📈 Growth Rate (CAGR)\n🌍 Geographic Breakdown\n💰 Revenue Potential\n🔮 2025-2030 Projections\n📚 Sources`);
      resultEl.innerText = report;
      this.showReportActions("intelResult", topic, report);
      await this.saveToHistory(topic, report, "market");
    } catch (e) {
      document.getElementById("intelResult").innerText = "⚠️ Market size failed: " + e.message;
    } finally {
      btn.disabled = false;
      btn.innerText = "📊 Market Size";
    }
  }

  async marketTrends() {
    const topic = document.getElementById("marketTopic").value.trim();
    if (!topic) return alert("Enter an industry");
    const btn = document.getElementById("marketTrends");
    btn.disabled = true;
    btn.innerText = "🔄 Analyzing...";
    try {
      const resultEl = document.getElementById("intelResult");
      resultEl.style.display = "block";
      resultEl.innerText = "🔄 Finding trends...";
      const combined = await Utils.googleResearch(topic + " trends 2025 growth emerging");
      const report = await this.ai.chat(`Market trends for: "${topic}"\n\nData:\n${combined.substring(0, 8000)}\n\nProvide:\n📈 Top 5 Emerging Trends\n🔄 Disruptions Happening Now\n⚠️ Threats & Risks\n💡 Opportunities\n🔮 What's Next`);
      resultEl.innerText = report;
      this.showReportActions("intelResult", topic, report);
      await this.saveToHistory(topic, report, "market");
    } catch (e) {
      document.getElementById("intelResult").innerText = "⚠️ Market trends failed: " + e.message;
    } finally {
      btn.disabled = false;
      btn.innerText = "📈 Trends";
    }
  }

  async marketPlayers() {
    const topic = document.getElementById("marketTopic").value.trim();
    if (!topic) return alert("Enter an industry");
    const btn = document.getElementById("marketPlayers");
    btn.disabled = true;
    btn.innerText = "🔄 Finding...";
    try {
      const resultEl = document.getElementById("intelResult");
      resultEl.style.display = "block";
      resultEl.innerText = "🔄 Finding key players...";
      const combined = await Utils.googleResearch(topic + " top companies leaders market share 2025");
      const report = await this.ai.chat(`Key players in: "${topic}"\n\nData:\n${combined.substring(0, 8000)}\n\nProvide:\n🏆 Top 5-10 Companies\n💰 Estimated Market Share\n📍 HQ & Funding\n⚡ Competitive Advantages\n🆕 Emerging Challengers`);
      resultEl.innerText = report;
      this.showReportActions("intelResult", topic, report);
      await this.saveToHistory(topic, report, "market");
    } catch (e) {
      document.getElementById("intelResult").innerText = "⚠️ Key players failed: " + e.message;
    } finally {
      btn.disabled = false;
      btn.innerText = "🏆 Key Players";
    }
  }

  async pageAnalysis(action) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const text = await Utils.getPageText(tab.id);
    const resultEl = document.getElementById("intelResult");
    if (!resultEl) return;
    resultEl.style.display = "block";
    resultEl.innerText = "🔄 Analyzing...";

    const prompts = {
      factcheck: `Fact-check this page. Mark each claim:\n✅ Likely true\n⚠️ Unverified\n❌ Likely false/misleading\n\nBe specific with evidence.\n\nPage:\n${text.substring(0, 3000)}`,
      bias: `Analyze bias on this page:\n- Political direction (left/center/right)\n- Emotional language %\n- Missing perspectives\n- Loaded/manipulative words\n- Overall bias score /10\n\nPage:\n${text.substring(0, 3000)}`,
      scam: `Analyze this website for scam signals:\n- Trust signals present/missing\n- Pressure tactics\n- Unrealistic claims\n- Missing legitimacy info\n- Red flags\n- Scam probability % with explanation\n\nPage:\n${text.substring(0, 3000)}`,
      darkpattern: `Find dark patterns (deceptive design) on this page:\n- Fake urgency/scarcity\n- Hidden costs\n- Pre-checked boxes\n- Misleading buttons\n- Forced continuity\nList each found with explanation.\n\nPage:\n${text.substring(0, 3000)}`,
      privacy: `Privacy audit of this website:\n- Data likely collected\n- Tracking methods\n- Third-party scripts\n- Cookie consent issues\n- Data sharing risks\n- Privacy score /10\n\nPage:\n${text.substring(0, 3000)}`,
      sentiment: `Sentiment analysis of this page:\n- Overall sentiment (positive/neutral/negative)\n- Tone (formal/casual/aggressive/friendly)\n- Emotion detected\n- Key sentiment drivers\n- Score /10 from negative to positive\n\nPage:\n${text.substring(0, 3000)}`,
    };

    const result = await this.ai.chat(prompts[action]);
    resultEl.innerText = result;
    this.showReportActions("intelResult", action + " analysis", result);
    await this.saveToHistory(action + " — " + document.title, result, "page");
  }

  showReportActions(containerId, topic, text) {
    const container = document.getElementById(containerId);
    document.dispatchEvent(new CustomEvent("atom:result-meta", {
      detail: {
        area: containerId === "companyResult" ? "research" : "intel",
        text,
        signal: text && text.length > 1200 ? "Rich brief" : "Focused brief"
      }
    }));
    // Remove old action bar if exists
    const old = container.parentNode.querySelector(".report-action-bar");
    if (old) old.remove();

    const bar = document.createElement("div");
    bar.className = "report-action-bar";
    bar.style.cssText = "display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;";
    bar.innerHTML = `
      <button class="btn btn-g bsm" id="reportCopy_${containerId}">📋 Copy</button>
      <button class="btn btn-g bsm" id="reportSave_${containerId}">💾 Save</button>
      <button class="btn btn-t bsm" id="reportPDF_${containerId}">📄 Export PDF</button>
      <button class="btn btn-g bsm" id="reportTxt_${containerId}">📝 Export TXT</button>
      <button class="btn btn-g bsm" id="reportSheets_${containerId}">📊 To Sheets</button>
    `;
    container.parentNode.insertBefore(bar, container.nextSibling);

    document.getElementById(`reportCopy_${containerId}`).addEventListener("click", async () => {
      await navigator.clipboard.writeText(text);
      const btn = document.getElementById(`reportCopy_${containerId}`);
      btn.innerText = "✅ Copied!";
      setTimeout(() => btn.innerText = "📋 Copy", 1200);
    });
    document.getElementById(`reportSave_${containerId}`).addEventListener("click", async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const d = await chrome.storage.local.get(["notes"]);
      const notes = d.notes || [];
      notes.push({ text, savedAt: new Date().toLocaleString(), url: tab?.url || "", topic });
      await chrome.storage.local.set({ notes });
      const btn = document.getElementById(`reportSave_${containerId}`);
      btn.innerText = "✅ Saved!";
      setTimeout(() => btn.innerText = "💾 Save", 1200);
    });
    document.getElementById(`reportPDF_${containerId}`).addEventListener("click", () => {
      this.exportReportAsPDF(topic, text);
    });
    document.getElementById(`reportTxt_${containerId}`).addEventListener("click", () => {
      const blob = new Blob([text], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "atom_" + topic.replace(/\s+/g, "_").toLowerCase() + ".txt";
      a.click();
    });
    document.getElementById(`reportSheets_${containerId}`).addEventListener("click", async () => {
      const tsv = Utils.textToTSV(text);
      const out = await Utils.tryWriteToGoogleSheets(tsv);
      alert(out.ok ? "Prepared Google Sheets export." : out.reason);
    });
  }

  async runBattleCard() {
    const urls = [
      document.getElementById("battleUrl1")?.value.trim(),
      document.getElementById("battleUrl2")?.value.trim(),
      document.getElementById("battleUrl3")?.value.trim()
    ].filter(Boolean);
    if (!urls.length) return alert("Enter at least one competitor URL.");
    const out = document.getElementById("battleOutput");
    if (!out) return;
    out.style.display = "block";
    out.innerText = "Building competitor battle card...";
    try {
      const table = await this.battleCard(urls);
      out.innerText = table;
      this.attachBattleActions(table);
    } catch (e) {
      out.innerText = "Battle card failed: " + e.message;
    }
  }

  async battleCard(urls) {
    const snapshots = [];
    for (const url of urls) {
      const source = await Utils.openAndReadUrl(url, { active: false, maxLength: 4000, waitMs: 9000 });
      const news = await Utils.googleResearch(`${url} recent news 2026`);
      snapshots.push({
        url,
        text: source.text || "",
        news: news.substring(0, 1200)
      });
    }
    const prompt = `Create a markdown comparison table for these competitors.
Columns: Competitor | Pricing | Key Features | Target Audience | Recent News
Return only the markdown table.

DATA:
${JSON.stringify(snapshots).substring(0, 14000)}`;
    return await this.ai.chat(prompt, 1400);
  }

  attachBattleActions(markdownTable) {
    const output = document.getElementById("battleOutput");
    if (!output) return;
    let bar = document.getElementById("battleActions");
    if (bar) bar.remove();
    bar = document.createElement("div");
    bar.id = "battleActions";
    bar.className = "report-action-bar";
    bar.innerHTML = `
      <button class="btn btn-g bsm" id="copyBattleTable">📋 Copy as Table</button>
      <button class="btn btn-g bsm" id="copyBattleSheets">📊 Copy to Sheets</button>
    `;
    output.parentNode.insertBefore(bar, output.nextSibling);
    document.getElementById("copyBattleTable")?.addEventListener("click", async () => {
      await navigator.clipboard.writeText(markdownTable);
    });
    document.getElementById("copyBattleSheets")?.addEventListener("click", async () => {
      const tsv = markdownTable
        .split("\n")
        .filter((line) => /^\|/.test(line) && !/^-+\|/.test(line.replace(/\s/g, "")))
        .map((line) => line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).join("\t"))
        .join("\n");
      await Utils.tryWriteToGoogleSheets(tsv);
    });
  }

  exportReportAsPDF(topic, content) {
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Atom.AI — ${topic}</title>
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
    <h1>${topic}</h1>
    <div class="date">Generated: ${new Date().toLocaleString()}</div>
  </div>
  <pre>${content.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>
  <br><button onclick="window.print()" style="margin-top:24px;padding:12px 24px;background:#6c63ff;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;">Print / Save as PDF</button>
</body>
</html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, "_blank");
    if (win) setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async saveToHistory(topic, report, type) {
    const data = await chrome.storage.local.get(["researchHistory"]);
    const history = data.researchHistory || [];
    history.unshift({
      id: Date.now(),
      topic,
      report,
      type,
      savedAt: new Date().toLocaleString(),
      preview: report.replace(/[━=\n]/g, " ").substring(0, 120),
      date: Date.now()
    });
    if (history.length > 100) history.pop();
    await chrome.storage.local.set({ researchHistory: history });

    // Webhook sync
    if (this.userSettings.webhookUrl && this.userSettings.webhookUrl.startsWith("http")) {
      try {
        await fetch(this.userSettings.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic, report, type, source: "atom.ai", timestamp: new Date().toISOString() })
        });
      } catch (e) {}
    }
  }
}


