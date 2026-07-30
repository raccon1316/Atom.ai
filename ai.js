import { Utils } from './utils.js';

// ai.js
export const DEFAULT_BACKEND_BASES = [
  "https://atom-ai-eight.vercel.app",
  "https://atom-ai.vercel.app",
  "https://atomai.pro"
];

function normalizeBackendBase(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return parsed.origin.replace(/\/$/, "");
  } catch {
    return raw.replace(/\/$/, "").replace(/\/api\/.*$/i, "");
  }
}

export class AI {
  constructor({ getApiKey, getModel, onCall }) {
    this.getApiKey = getApiKey;
    this.getModel = getModel;
    this.onCall = onCall;
    this.traceContext = null;
  }

  setTraceContext(context = null) {
    this.traceContext = context && typeof context === 'object' ? { ...context } : null;
  }

  clearTraceContext() {
    this.traceContext = null;
  }

  async checkLimit() {
    if (!this.onCall) return true;
    const result = await this.onCall();
    if (typeof result === "boolean") {
      if (!result) throw new Error("Usage limit reached. Please try later.");
      return true;
    }
    if (result && typeof result === "object") {
      if (result.allowed === false) {
        throw new Error(result.reason || "Usage limit reached. Please try later.");
      }
      return true;
    }
    if (!result) throw new Error("Usage limit reached. Please try later.");
    return true;
  }

  buildEndpoint() {
    return `${DEFAULT_BACKEND_BASES[0]}/api/chat`;
  }

  async getEndpointCandidates() {
    const bases = [];
    try {
      const data = await chrome.storage.local.get(["backendBaseUrl"]).catch(() => ({}));
      const stored = normalizeBackendBase(data?.backendBaseUrl);
      if (stored) bases.push(stored);
    } catch {}

    for (const base of DEFAULT_BACKEND_BASES) {
      const normalized = normalizeBackendBase(base);
      if (normalized) bases.push(normalized);
    }

    return [...new Set(bases)].map((base) => `${base}/api/chat`);
  }

  async safeParseResponse(res) {
    const raw = await res.text();
    if (!raw || !raw.trim()) return {};
    try {
      return JSON.parse(raw);
    } catch (e) {
      return { _raw: raw };
    }
  }

  extractErrorMessage(status, data) {
    const providerError = data?.error?.message || data?.error || "";
    if (typeof providerError === "string" && providerError.trim()) return providerError.trim();
    if (status === 401) {
      return "Backend authentication failed. The server API key may be expired or misconfigured. Please contact support.";
    }
    if (status === 429) {
      return "Rate limited. The backend is handling too many requests. Please try again in a moment.";
    }
    if (status === 502 || status === 503 || status === 504) {
      return "Backend service temporarily unavailable. Please try again in a moment.";
    }
    const detail = typeof data?._raw === "string" ? data._raw.slice(0, 220) : "";
    if (detail) return `AI request failed (${status}): ${detail}`;
    return `AI request failed with status ${status}. The backend may be down.`;
  }

  async requestCompletion({ messages, maxTokens = 600, temperature = 0.3, retries = 2 }) {
    await this.checkLimit();

    const model = this.getModel();
    const startedAt = Date.now();
    const body = {
      model,
      max_tokens: maxTokens,
      temperature,
      messages
    };
    const endpoints = await this.getEndpointCandidates();
    const context = this.traceContext && typeof this.traceContext === 'object' ? this.traceContext : {};
    const inputText = Array.isArray(messages)
      ? messages.map((message) => `[${String(message?.role || 'user')}] ${String(message?.content || '')}`).join('\n\n')
      : String(context.prompt || context.input || '');

    let lastError = null;
    for (const endpoint of endpoints) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Extension-Id": chrome.runtime.id
            },
            body: JSON.stringify(body)
          });
          const data = await this.safeParseResponse(res);
          if (!res.ok) {
            const message = this.extractErrorMessage(res.status, data);
            const retryable = [404, 408, 500, 502, 503, 504].includes(Number(res.status));
            if (retryable && endpoint !== endpoints[endpoints.length - 1]) {
              lastError = new Error(message);
              break;
            }
            throw new Error(message);
          }
          if (data?.error) {
            throw new Error(this.extractErrorMessage(res.status, data));
          }
          const text = data?.choices?.[0]?.message?.content;
          if (typeof text !== "string" || !text.trim()) {
            throw new Error("AI returned an empty response");
          }
          await Utils.pushDetailedReport({
            kind: String(context.kind || 'ai-chat'),
            title: String(context.title || context.action || 'AI Call'),
            status: 'success',
            source: String(context.source || 'ai'),
            action: String(context.action || 'chat'),
            model,
            endpoint,
            durationMs: Date.now() - startedAt,
            input: inputText,
            output: text,
            context
          });
          return text;
        } catch (e) {
          lastError = e;
          const retryable = /fetch|network|failed to fetch|load failed|timeout|ECONN|CORS/i.test(String(e?.message || ""));
          if (!retryable) {
            throw e;
          }
          if (attempt < retries) {
            await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
            continue;
          }
          break;
        }
      }
    }
    await Utils.pushDetailedReport({
      kind: String(context.kind || 'ai-chat'),
      title: String(context.title || context.action || 'AI Call'),
      status: 'error',
      source: String(context.source || 'ai'),
      action: String(context.action || 'chat'),
      model,
      endpoint: endpoints[0] || '',
      durationMs: Date.now() - startedAt,
      input: inputText,
      output: '',
      error: lastError?.message || 'AI call failed after retries',
      context
    });
    throw lastError || new Error("AI call failed after retries");
  }

  async chat(prompt, maxTokens = 600, temperature = 0.3, retries = 2) {
    return await this.requestCompletion({
      messages: [{ role: "user", content: prompt }],
      maxTokens,
      temperature,
      retries
    });
  }

  async chatWithMessages(messages, maxTokens = 600, temperature = 0.3, retries = 1) {
    if (!Array.isArray(messages) || !messages.length) {
      throw new Error("Messages are required for chatWithMessages");
    }
    return await this.requestCompletion({
      messages,
      maxTokens,
      temperature,
      retries
    });
  }
}
