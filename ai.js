// ai.js
export class AI {
  constructor({ getApiKey, getModel, onCall }) {
    this.getApiKey = getApiKey;
    this.getModel = getModel;
    this.onCall = onCall;
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

  buildEndpoint(apiKey) {
    return apiKey.startsWith("gsk_")
      ? "https://api.groq.com/openai/v1/chat/completions"
      : "https://integrate.api.nvidia.com/v1/chat/completions";
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
    const detail = typeof data?._raw === "string" ? data._raw.slice(0, 220) : "";
    if (detail) return `AI request failed (${status}): ${detail}`;
    return `AI request failed with status ${status}`;
  }

  async requestCompletion({ messages, maxTokens = 600, temperature = 0.3, retries = 2 }) {
    const key = this.getApiKey();
    if (!key) throw new Error("API key not set");
    await this.checkLimit();

    const model = this.getModel();
    const endpoint = this.buildEndpoint(key);
    const body = {
      model,
      max_tokens: maxTokens,
      temperature,
      messages
    };

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });
        const data = await this.safeParseResponse(res);
        if (!res.ok) {
          throw new Error(this.extractErrorMessage(res.status, data));
        }
        if (data?.error) {
          throw new Error(this.extractErrorMessage(res.status, data));
        }
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text !== "string" || !text.trim()) {
          throw new Error("AI returned an empty response");
        }
        return text;
      } catch (e) {
        lastError = e;
        if (attempt === retries) break;
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
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
