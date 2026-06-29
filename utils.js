export const Utils = {
  async mapWithConcurrency(items, mapper, concurrency = 3) {
    const list = Array.isArray(items) ? items : [];
    const limit = Math.max(1, Number(concurrency) || 1);
    const results = new Array(list.length);
    let nextIndex = 0;

    const worker = async () => {
      while (nextIndex < list.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await mapper(list[currentIndex], currentIndex);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(limit, list.length) }, () => worker())
    );
    return results;
  },

  async setBoundedStorageArray(key, items, options = {}) {
    const {
      maxItems = 100,
      minItems = 10,
      trimStep = 10,
      onTrim = null
    } = options;

    let nextItems = Array.isArray(items) ? items.slice(0, maxItems) : [];
    const floor = Math.max(1, Math.min(minItems, maxItems));
    const step = Math.max(1, trimStep);

    while (nextItems.length >= floor) {
      try {
        await chrome.storage.local.set({ [key]: nextItems });
        return { ok: true, count: nextItems.length, trimmed: Array.isArray(items) ? items.length - nextItems.length : 0 };
      } catch (error) {
        const isQuotaError = /quota|max.*bytes|limit/i.test(String(error?.message || ""));
        if (!isQuotaError || nextItems.length <= floor) {
          return { ok: false, error };
        }
        nextItems = nextItems.slice(0, Math.max(floor, nextItems.length - step));
      }
    }

    if (typeof onTrim === 'function') onTrim();
    return { ok: false, error: new Error(`Could not store ${key} within quota.`) };
  },

  async writeDebugLog(message, level = 'info') {
    const data = await chrome.storage.local.get(['debugLogs']);
    const logs = Array.isArray(data.debugLogs) ? data.debugLogs : [];
    logs.unshift({
      ts: new Date().toISOString(),
      level: String(level || 'info'),
      message: String(message || '')
    });
    await chrome.storage.local.set({ debugLogs: logs.slice(0, 100) });
  },

  textToTSV(text = '') {
    const clean = String(text || '').trim();
    if (!clean) return '';
    if (clean.includes('\t')) return clean;
    const lines = clean.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return '';
    if (lines[0].includes(',')) {
      return lines.map((line) => line.split(',').map((c) => c.trim()).join('\t')).join('\n');
    }
    return 'value\n' + lines.map((line) => line.replace(/\t/g, ' ')).join('\n');
  },

  async tryWriteToGoogleSheets(tsv) {
    const payload = String(tsv || '').trim();
    if (!payload) return { ok: false, reason: 'No data provided.' };
    try {
      const sheetsUrl = 'https://docs.google.com/spreadsheets/create';
      await chrome.tabs.create({ url: sheetsUrl, active: true });
      await navigator.clipboard.writeText(payload);
      return { ok: true, reason: 'Opened Google Sheets and copied TSV. Paste into cell A1.' };
    } catch (e) {
      try {
        await navigator.clipboard.writeText(payload);
        return { ok: false, reason: 'Copied to clipboard. Paste manually in Google Sheets.' };
      } catch {
        return { ok: false, reason: e?.message || 'Failed to prepare Google Sheets export.' };
      }
    }
  },

  cleanText(text = '', maxLength = 6000) {
    return String(text || '').replace(/\s+/g, ' ').trim().substring(0, maxLength);
  },

  sanitizeCacheKeyPart(value) {
    return String(value || '')
      .replace(/^https?:\/\//i, '')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 180);
  },

  normalizePageUrl(url) {
    return String(url || '').trim().split('#')[0];
  },

  async getPageText(tabId, maxLength = 2000) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: (maxLen) => {
          const body = document.body;
          if (!body) return '';

          const extract = (node) => {
            if (!node) return '';
            const clone = node.cloneNode(true);
            clone.querySelectorAll(
              'script,style,noscript,template,nav,footer,header,aside,' +
              'svg,img,video,canvas,iframe,form,[role="navigation"],[role="banner"],[aria-hidden="true"]'
            ).forEach((el) => el.remove());
            return (clone.innerText || '').replace(/\s+/g, ' ').trim();
          };

          const candidates = [
            document.querySelector('main'),
            document.querySelector('article'),
            document.querySelector('[role="main"]'),
            document.querySelector('.main'),
            document.querySelector('#main'),
            document.querySelector('#content'),
            document.querySelector('#app'),
            document.querySelector('#root'),
            body
          ].filter(Boolean);

          let best = '';
          for (const candidate of candidates) {
            const text = extract(candidate);
            if (text.length > best.length) best = text;
          }

          return best.slice(0, Math.min(2000, Math.max(1, Number(maxLen) || 2000)));
        },
        args: [maxLength]
      });
      return String(res?.[0]?.result || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
    } catch (e) {
      return '';
    }
  },

  async extractPageSignals(tabId) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ');
          const links = [...new Set([...document.querySelectorAll('a[href]')].map((a) => {
            try {
              const href = new URL(a.href, location.href).href;
              return /^https?:\/\//i.test(href) ? href : '';
            } catch {
              return '';
            }
          }).filter(Boolean))].slice(0, 30);
          const emails = [...new Set((bodyText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((x) => x.toLowerCase()))].slice(0, 20);
          const phones = [...new Set((bodyText.match(/(?:\+?\d[\d\s().-]{7,}\d)/g) || []).map((x) => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 20);
          return {
            title: document.title || '',
            url: location.href,
            emails,
            phones,
            links
          };
        }
      });
      return res?.[0]?.result || { emails: [], phones: [], links: [] };
    } catch {
      return { emails: [], phones: [], links: [] };
    }
  },

  async getCachedPageText(url, options = {}) {
    const {
      tabId = null,
      active = false,
      maxLength = 2000,
      ttlMs = 60 * 60 * 1000,
      refresh = false,
      openIfNeeded = true,
      waitMs = 12000
    } = options;

    const normalizedUrl = this.normalizePageUrl(url);
    if (!normalizedUrl) {
      return { ok: false, cached: false, url: '', text: '', error: 'Missing URL.' };
    }

    const cacheKey = this.sanitizeCacheKeyPart(normalizedUrl);
    const now = Date.now();
    const data = await chrome.storage.local.get(['pageTextCache']);
    const cache = data.pageTextCache && typeof data.pageTextCache === 'object' ? data.pageTextCache : {};
    const cached = cache[cacheKey];
    if (!refresh && cached?.text && cached?.savedAt && (now - Number(cached.savedAt || 0)) < ttlMs) {
      return {
        ok: true,
        cached: true,
        url: normalizedUrl,
        domain: cached.domain || this.normalizeDomain(normalizedUrl),
        title: cached.title || '',
        text: cached.text,
        signals: cached.signals || { emails: [], phones: [], links: [] },
        savedAt: cached.savedAt
      };
    }

    let tempTab = null;
    let sourceTabId = tabId || null;
    let sourceTitle = '';

    try {
      if (!sourceTabId) {
        const tabs = await chrome.tabs.query({});
        const normalizedTarget = normalizedUrl.toLowerCase();
        const matched = tabs.find((tab) => tab?.id && this.isInjectableTab(tab) && this.isReadableHttpUrl(tab.url) && this.normalizePageUrl(tab.url).toLowerCase() === normalizedTarget);
        if (matched?.id) {
          sourceTabId = matched.id;
          sourceTitle = matched.title || '';
        }
      }

      if (!sourceTabId) {
        if (!openIfNeeded) {
          return {
            ok: false,
            cached: false,
            url: normalizedUrl,
            text: '',
            error: 'No readable tab found for this URL.'
          };
        }
        tempTab = await chrome.tabs.create({ url: normalizedUrl, active });
        sourceTabId = tempTab.id;
        await this.waitForTab(sourceTabId, waitMs);
        await this.wait(500);
      } else {
        await this.waitForTab(sourceTabId, waitMs);
        await this.wait(250);
      }

      let text = await this.getPageText(sourceTabId, maxLength);
      if (!text) {
        await this.wait(800);
        text = await this.getPageText(sourceTabId, maxLength);
      }

      if (!text) {
        return {
          ok: false,
          cached: false,
          url: normalizedUrl,
          text: '',
          error: 'Not enough readable text on the page.'
        };
      }

      const signals = await this.extractPageSignals(sourceTabId);
      const contactBits = [];
      if (signals?.emails?.length) contactBits.push(`Emails: ${signals.emails.slice(0, 5).join(', ')}`);
      if (signals?.phones?.length) contactBits.push(`Phones: ${signals.phones.slice(0, 5).join(', ')}`);
      if (signals?.links?.length) contactBits.push(`Links: ${signals.links.slice(0, 5).join(', ')}`);
      const augmentedText = contactBits.length ? `${text}\n\nLOCAL CONTACT SIGNALS\n${contactBits.join('\n')}` : text;
      const payload = {
        ok: true,
        cached: false,
        url: normalizedUrl,
        domain: this.normalizeDomain(normalizedUrl),
        title: sourceTitle || signals.title || '',
        text: String(augmentedText || '').slice(0, Math.min(2000, Math.max(1, Number(maxLength) || 2000))),
        signals,
        savedAt: now
      };

      cache[cacheKey] = payload;
      const entries = Object.entries(cache)
        .filter(([, entry]) => entry?.savedAt && (now - Number(entry.savedAt || 0)) < ttlMs)
        .sort((a, b) => Number(b[1].savedAt || 0) - Number(a[1].savedAt || 0))
        .slice(0, 120);
      await chrome.storage.local.set({ pageTextCache: Object.fromEntries(entries) });
      return payload;
    } catch (error) {
      return {
        ok: false,
        cached: false,
        url: normalizedUrl,
        text: '',
        error: error?.message || 'Failed to read page text.'
      };
    } finally {
      if (tempTab?.id) {
        try { await chrome.tabs.remove(tempTab.id); } catch (e) {}
      }
    }
  },

  cleanMarkdownTable(markdown = '') {
    const text = String(markdown || '').replace(/```(?:markdown|md)?/gi, '').replace(/```/g, '').trim();
    if (!text) return '';

    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const tableLines = lines.filter((line) => line.includes('|'));
    if (tableLines.length < 2) return text;

    const splitRow = (line) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
    const isSeparatorRow = (cells) => cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
    const rows = tableLines.map(splitRow).filter((cells) => !isSeparatorRow(cells)).map((cells) => cells.map((cell) => cell.replace(/\s+/g, ' ').trim()));
    if (rows.length < 2) return text;

    const header = rows[0];
    const width = Math.max(2, header.length);
    const bodyRows = rows.slice(1)
      .map((cells) => {
        const cleaned = cells.slice(0, width);
        while (cleaned.length < width) cleaned.push('');
        return cleaned;
      })
      .filter((cells) => cells.some((cell) => cell.trim().length > 0));

    if (!bodyRows.length) return text;
    const separator = Array.from({ length: width }, () => '---');
    return [header, separator, ...bodyRows]
      .map((cells) => '| ' + cells.map((cell) => cell || '').join(' | ') + ' |')
      .join('\n');
  },

  async getBackendBaseCandidates() {
    const defaults = [
      'https://atom-ai-eight.vercel.app',
      'https://atom-ai.vercel.app',
      'https://atomai.pro'
    ];
    const bases = [];
    try {
      const data = await chrome.storage.local.get(['backendBaseUrl']).catch(() => ({}));
      const stored = String(data?.backendBaseUrl || '').trim();
      if (stored) {
        try {
          bases.push(new URL(stored).origin.replace(/\/$/, ''));
        } catch {
          bases.push(stored.replace(/\/$/, '').replace(/\/api\/.*$/i, ''));
        }
      }
    } catch {}
    defaults.forEach((base) => bases.push(base));
    return [...new Set(bases.filter(Boolean))];
  },

  async callBattleCardApi(pages, installId, options = {}) {
    const payload = {
      pages: Array.isArray(pages)
        ? pages.map((page) => ({
          url: String(page?.url || '').trim(),
          text: String(page?.text || '').trim().slice(0, 2000)
        })).filter((page) => page.url && page.text)
        : [],
      installId: String(installId || '').trim(),
      isPro: !!options.isPro
    };

    if (!payload.pages.length) {
      return { ok: false, error: 'No cleaned page text available.' };
    }

    const endpoints = [];
    if (options.endpoint) {
      endpoints.push(String(options.endpoint).trim());
    }
    for (const base of await this.getBackendBaseCandidates()) {
      endpoints.push(`${base}/api/battle-card`);
    }

    let lastError = null;
    for (const endpoint of [...new Set(endpoints.filter(Boolean))]) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });

        const raw = await res.text();
        let data = {};
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch {
          data = { raw };
        }

        if (!res.ok) {
          const errorText = data?.error || data?.message || 'Battle card failed (' + res.status + ')';
          const retryable = [404, 408, 500, 502, 503, 504].includes(Number(res.status));
          if (retryable) {
            lastError = new Error(errorText);
            continue;
          }
          return {
            ok: false,
            error: errorText,
            raw: data?.raw || raw
          };
        }

        const table = String(data?.table || data?.markdown || data?.result || raw || '').trim();
        const clean = this.cleanMarkdownTable(table);
        if (!clean) {
          lastError = new Error('Battle card returned an empty table.');
          continue;
        }
        return { ok: true, table: clean, raw: data };
      } catch (error) {
        lastError = error;
      }
    }

    return {
      ok: false,
      error: lastError?.message || 'Battle card failed.',
      raw: null
    };
  },
  wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  isInjectableTab(tab) {
    if (!tab?.url) return false;
    const bad = ['chrome://', 'chrome-extension://', 'about:', 'edge://', 'brave://', 'devtools://', 'view-source:'];
    return !bad.some((prefix) => tab.url.startsWith(prefix));
  },

  isReadableHttpUrl(url) {
    return /^https?:\/\//i.test(url || '');
  },

  normalizeDomain(url) {
    try {
      return new URL(url).hostname.replace(/^www\./i, '');
    } catch {
      return 'unknown';
    }
  },

  safeTabLabel(tab) {
    if (!tab) return 'Unknown tab';
    return (tab.title || this.normalizeDomain(tab.url) || 'Untitled tab').trim();
  },

  async getReadableTabs(options = {}) {
    const {
      currentWindow = true,
      maxTabs = 5,
      excludeTabId = null,
      includeActive = true
    } = options;

    const tabs = await chrome.tabs.query(currentWindow ? { currentWindow: true } : {});
    const seenUrls = new Set();
    const filtered = tabs.filter((tab) => {
      if (!tab?.id || tab.id === excludeTabId) return false;
      if (!includeActive && tab.active) return false;
      if (!this.isInjectableTab(tab) || !this.isReadableHttpUrl(tab.url)) return false;
      const normalized = (tab.url || '').split('#')[0];
      if (seenUrls.has(normalized)) return false;
      seenUrls.add(normalized);
      return true;
    });

    filtered.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)));
    return filtered.slice(0, maxTabs);
  },

  async readTabSource(tab, options = {}) {
    const { maxLength = 1800, waitMs = 12000 } = options;
    const source = {
      tabId: tab?.id || null,
      title: this.safeTabLabel(tab),
      url: tab?.url || '',
      domain: this.normalizeDomain(tab?.url),
      text: '',
      ok: false,
      error: ''
    };

    if (!tab?.id || !this.isInjectableTab(tab) || !this.isReadableHttpUrl(tab.url)) {
      source.error = 'Tab is not readable.';
      return source;
    }

    try {
      await this.waitForTab(tab.id, waitMs);
      await this.wait(3000); // let SPA hydrate (React/Next/Vue)

      let text = await this.getPageText(tab.id, maxLength);

      // Retry up to 3x for slow SPAs (Notion, Stripe, Airtable etc.)
      let attempts = 0;
      while ((!text || text.length < 150) && attempts < 3) {
        await this.wait(3000);
        text = await this.getPageText(tab.id, maxLength);
        attempts++;
      }

      if (!text || text.length < 80) {
        source.error = 'Not enough readable text on the page.';
        return source;
      }
      source.text = text;
      source.ok = true;
      return source;
    } catch (error) {
      source.error = error?.message || 'Failed to read tab.';
      return source;
    }
  },

  async collectTabSources(tabs, options = {}) {
    const { maxLength = 1800 } = options;
    const sources = [];
    const skipped = [];

    for (const tab of tabs) {
      if (window.cancelCurrentTask) {
        throw new Error('Task canceled.');
      }
      const source = await this.readTabSource(tab, { maxLength, waitMs: options.waitMs || 8000 });
      if (source.ok) {
        sources.push(source);
      } else {
        skipped.push({
          title: source.title,
          url: source.url,
          reason: source.error || 'Skipped'
        });
      }
    }

    return { sources, skipped };
  },

  async openAndReadUrl(url, options = {}) {
    const result = await this.getCachedPageText(url, {
      active: options.active ?? false,
      maxLength: options.maxLength ?? 2000,
      ttlMs: options.ttlMs ?? (60 * 60 * 1000),
      refresh: true,
      openIfNeeded: true,
      waitMs: options.waitMs ?? 12000
    });
    return {
      tabId: result?.tabId || null,
      title: result?.title || '',
      url: result?.url || url,
      domain: result?.domain || this.normalizeDomain(url),
      text: result?.text || '',
      ok: !!result?.ok,
      error: result?.error || ''
    };
  },
  formatSourceList(sources = []) {
    return sources.map((source, index) => `${index + 1}. ${source.domain} - ${source.title}`).join('\n');
  },

  async getGoogleLinks(tabId) {
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const links = [];
          document.querySelectorAll('a h3').forEach((el) => {
            const a = el.closest('a');
            if (a && a.href && !a.href.includes('google.com')) links.push(a.href);
          });
          return links.slice(0, 4);
        }
      });
      return res?.[0]?.result || [];
    } catch {
      return [];
    }
  },

  async waitForTab(tabId, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') return true;
      } catch {
        return false;
      }
      await this.wait(500);
    }
    return false;
  },

  async googleResearch(query) {
    try {
      const url = 'https://www.google.com/search?q=' + encodeURIComponent(query);
      const source = await this.openAndReadUrl(url, { active: false, maxLength: 5000, waitMs: 7000 });
      return source.text || '';
    } catch {
      return '';
    }
  },

  async collectStructuredPageData(url, aiInstance) {
    let domain = 'unknown';
    try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch {}

    // ── Step 1: Try direct page scrape ──
    let pageText = '';
    try {
      const source = await this.openAndReadUrl(url, { active: false, maxLength: 5000, waitMs: 12000 });
      if (source.ok && source.text && source.text.length >= 80) {
        pageText = source.text;
      }
    } catch {}

    // ── Step 2: If direct scrape failed or too short, use Google search ──
    // Many modern sites (Notion, Airtable etc) block scripting or are JS-rendered
    // Google snippets give us pricing/feature signals even when the page is blank
    const googleOverview   = await this.googleResearch(`${domain} pricing features product overview`);
    const googleNews       = await this.googleResearch(`${domain} recent news updates 2025 2026`);

    // Combine whatever we have
    const combinedData = [
      pageText ? `DIRECT PAGE CONTENT:\n${pageText}` : `NOTE: Direct page scrape was blocked or empty for ${domain}.`,
      googleOverview ? `GOOGLE OVERVIEW:\n${googleOverview.substring(0, 2000)}` : '',
      googleNews     ? `RECENT NEWS:\n${googleNews.substring(0, 1500)}` : ''
    ].filter(Boolean).join('\n\n');

    if (combinedData.length < 100) {
      return { url, domain, pricing: 'N/A', features: 'N/A', targetAudience: 'N/A', recentNews: 'N/A', ok: false, textLength: 0, error: 'No data found' };
    }

    // ── Step 3: AI extraction ──
    const prompt = `Extract structured sales intelligence for "${domain}" from the data below.
Return ONLY a valid JSON object with these exact keys (no markdown, no explanation):
{
  "pricing": "pricing plans, tiers, costs — be specific with numbers if visible",
  "features": "top 4-5 key features or capabilities",
  "targetAudience": "who this product is for (role, company size, industry)",
  "recentNews": "latest news, funding, product launches, or partnerships"
}

DATA:
${combinedData.substring(0, 7000)}`;

    try {
      const aiResponse = await aiInstance.chat(prompt, 900);
      let structuredData;
      try {
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        structuredData = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      } catch { structuredData = null; }

      if (!structuredData) {
        // AI didn't return JSON — use raw response split into fields
        structuredData = {
          pricing: aiResponse.substring(0, 200) || 'See website',
          features: aiResponse.substring(200, 500) || 'See website',
          targetAudience: aiResponse.substring(500, 700) || 'See website',
          recentNews: googleNews.substring(0, 300) || 'N/A'
        };
      }

      return {
        url,
        domain,
        pricing:        structuredData.pricing        || googleOverview.substring(0, 150) || 'N/A',
        features:       structuredData.features       || 'N/A',
        targetAudience: structuredData.targetAudience || 'N/A',
        recentNews:     structuredData.recentNews     || googleNews.substring(0, 200) || 'N/A',
        ok:             true,
        textLength:     pageText.length || 0
      };
    } catch (aiError) {
      // AI call failed — return what Google gave us raw
      return {
        url,
        domain,
        pricing:        googleOverview.substring(0, 200) || 'N/A',
        features:       googleOverview.substring(200, 500) || 'N/A',
        targetAudience: 'N/A',
        recentNews:     googleNews.substring(0, 200) || 'N/A',
        ok:             false,
        textLength:     pageText.length || 0,
        error:          aiError?.message || 'AI extraction failed'
      };
    }
  }
};
