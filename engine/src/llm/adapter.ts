/**
 * LLM adapter — provider-agnostic chat completion.
 *
 * Supports Gemini (via OpenAI-compatible endpoint) and OpenAI.
 * Uses the same request shape for both.
 */

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface LlmResponse {
  text: string;
  model: string;
  tokensUsed: { prompt: number; completion: number; total: number } | null;
  /** OpenAI-compatible finish reason. `"length"` means max_tokens was hit —
   *  caller should assume the reply is a truncated fragment and handle it. */
  finishReason: "stop" | "length" | "content_filter" | "tool_calls" | null;
}

interface ProviderConfig {
  provider: "gemini" | "openai";
  model: string;
  apiKey: string;
}

const ENDPOINTS: Record<string, string> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
};

// Track consecutive failures for health reporting
let consecutiveLlmFailures = 0;

export function getLlmHealth(): "healthy" | "unhealthy" | "unknown" {
  if (consecutiveLlmFailures >= 3) return "unhealthy";
  if (consecutiveLlmFailures === 0) return "healthy";
  return "healthy"; // occasional failures are fine
}

export async function chatCompletion(
  config: ProviderConfig,
  request: LlmRequest,
): Promise<LlmResponse> {
  const endpoint = ENDPOINTS[config.provider];
  if (!endpoint) throw new Error(`Unknown provider: ${config.provider}`);

  const payload = {
    model: config.model,
    messages: request.messages,
    max_tokens: request.maxTokens ?? 250,
    temperature: request.temperature ?? 0.9,
  };

  // Retry 503/429/500s with exponential backoff. Gemini free tier 503s
  // frequently at peak hours — per live-demo direction (2026-04-14), the
  // solution is never to silently deny, so we try a few times before giving
  // up. Max total delay ~2.5s so chat doesn't feel stalled.
  const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  const BACKOFFS_MS = [400, 1200];

  let res: Response | null = null;
  let lastErrBody = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) break;
    lastErrBody = await res.text().catch(() => "");

    if (!RETRY_STATUSES.has(res.status) || attempt === MAX_ATTEMPTS - 1) break;
    await new Promise((r) => setTimeout(r, BACKOFFS_MS[attempt] ?? 1200));
  }

  if (!res || !res.ok) {
    consecutiveLlmFailures++;
    throw new Error(`LLM ${config.provider} returned ${res?.status ?? "?"}: ${lastErrBody.slice(0, 200)}`);
  }

  consecutiveLlmFailures = 0; // reset on success

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const text = data.choices?.[0]?.message?.content?.trim() || "";
  const usage = data.usage;

  // Normalize finish_reason — OpenAI uses "stop"/"length"/"content_filter"/"tool_calls",
  // Gemini's OpenAI-compat layer uses the same strings. Unknown values flatten to null
  // so callers don't have to case on provider-specific quirks.
  const rawFinish = data.choices?.[0]?.finish_reason;
  const finishReason: LlmResponse["finishReason"] =
    rawFinish === "stop" || rawFinish === "length" ||
    rawFinish === "content_filter" || rawFinish === "tool_calls"
      ? rawFinish
      : null;

  return {
    text,
    model: data.model || config.model,
    tokensUsed: usage
      ? { prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0, total: usage.total_tokens || 0 }
      : null,
    finishReason,
  };
}
