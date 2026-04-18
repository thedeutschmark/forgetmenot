/**
 * LLM adapter — provider-agnostic chat completion.
 *
 * Supports three providers:
 *   - Gemini (via its OpenAI-compatible endpoint)
 *   - OpenAI
 *   - Anthropic / Claude (native Messages API — shape differs)
 *
 * The shared LlmRequest / LlmResponse interface hides provider quirks
 * from callers. Gemini + OpenAI use the same JSON schema so they share
 * the request/response path. Anthropic uses a distinct schema (system
 * lives outside `messages`, response is `content[]`, tokens are split
 * into input/output, headers differ) so it gets its own branch.
 *
 * Anthropic was added 2026-04-18 as part of the v0.1.35 provider A/B —
 * Gemini flash-lite's default register keeps pulling toward "sarcastic
 * AI chatbot" even with engine-layer scrubs bolted on. Claude Haiku's
 * instruction adherence profile is the hypothesis; empirical eval
 * comparison is the test.
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

export type LlmProvider = "gemini" | "openai" | "anthropic";

interface ProviderConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string;
}

const ENDPOINTS: Record<LlmProvider, string> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  anthropic: "https://api.anthropic.com/v1/messages",
};

// Track consecutive failures for health reporting
let consecutiveLlmFailures = 0;

export function getLlmHealth(): "healthy" | "unhealthy" | "unknown" {
  if (consecutiveLlmFailures >= 3) return "unhealthy";
  if (consecutiveLlmFailures === 0) return "healthy";
  return "healthy"; // occasional failures are fine
}

// Retry 503/429/500s with exponential backoff. Gemini free tier 503s
// frequently at peak hours — per live-demo direction (2026-04-14), the
// solution is never to silently deny, so we try a few times before giving
// up. Max total delay ~2.5s so chat doesn't feel stalled. Same retry
// policy applies to all three providers.
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BACKOFFS_MS = [400, 1200];

export async function chatCompletion(
  config: ProviderConfig,
  request: LlmRequest,
): Promise<LlmResponse> {
  const endpoint = ENDPOINTS[config.provider];
  if (!endpoint) throw new Error(`Unknown provider: ${config.provider}`);

  if (config.provider === "anthropic") {
    return chatCompletionAnthropic(config, request, endpoint);
  }
  return chatCompletionOpenAICompat(config, request, endpoint);
}

/**
 * OpenAI-compatible path — used by both OpenAI proper and Gemini's
 * OpenAI-compat endpoint. Same payload, same response shape, different
 * base URL.
 */
async function chatCompletionOpenAICompat(
  config: ProviderConfig,
  request: LlmRequest,
  endpoint: string,
): Promise<LlmResponse> {
  const payload = {
    model: config.model,
    messages: request.messages,
    max_tokens: request.maxTokens ?? 250,
    temperature: request.temperature ?? 0.9,
  };

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

/**
 * Anthropic Messages API. Differs from OpenAI-compat in several ways:
 *
 *   - `system` is a top-level field, not a `role: "system"` message.
 *     Any system messages in the input get concatenated (joined with
 *     double-newlines, matching how multi-system-message callers
 *     semantically treat their inputs) and moved out of `messages`.
 *
 *   - Remaining messages must alternate user/assistant and start with
 *     user. We collapse consecutive same-role messages by joining with
 *     newlines so the caller doesn't have to enforce alternation.
 *
 *   - Response shape: `content[].text` not `choices[0].message.content`.
 *     Anthropic returns an array of content blocks; for non-tool-use
 *     calls we join any text blocks.
 *
 *   - Usage split: `input_tokens` / `output_tokens` — no total provided
 *     so we compute it.
 *
 *   - Stop reason: `end_turn` maps to "stop", `max_tokens` to "length",
 *     `stop_sequence` to "stop", `tool_use` to "tool_calls".
 *
 *   - Auth: `x-api-key` header + `anthropic-version` required header.
 *     Not Bearer.
 */
async function chatCompletionAnthropic(
  config: ProviderConfig,
  request: LlmRequest,
  endpoint: string,
): Promise<LlmResponse> {
  // Split system messages out and collapse consecutive same-role messages.
  const systemParts: string[] = [];
  const convoMessages: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of request.messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    const last = convoMessages[convoMessages.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      convoMessages.push({ role: m.role, content: m.content });
    }
  }

  // Anthropic requires messages array starts with user. If we somehow
  // end up with assistant-first (shouldn't happen in practice), prepend
  // a minimal user turn so the API accepts the payload.
  if (convoMessages.length > 0 && convoMessages[0].role === "assistant") {
    convoMessages.unshift({ role: "user", content: "(continue)" });
  }

  const payload: Record<string, unknown> = {
    model: config.model,
    messages: convoMessages,
    max_tokens: request.maxTokens ?? 250,
    temperature: request.temperature ?? 0.9,
  };
  if (systemParts.length > 0) {
    payload.system = systemParts.join("\n\n");
  }

  let res: Response | null = null;
  let lastErrBody = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
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
    throw new Error(`LLM anthropic returned ${res?.status ?? "?"}: ${lastErrBody.slice(0, 200)}`);
  }

  consecutiveLlmFailures = 0;

  const data = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: string;
  };

  const text = (data.content || [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("")
    .trim();

  const inputTokens = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;

  let finishReason: LlmResponse["finishReason"] = null;
  switch (data.stop_reason) {
    case "end_turn":
    case "stop_sequence":
      finishReason = "stop";
      break;
    case "max_tokens":
      finishReason = "length";
      break;
    case "tool_use":
      finishReason = "tool_calls";
      break;
  }

  return {
    text,
    model: data.model || config.model,
    tokensUsed: {
      prompt: inputTokens,
      completion: outputTokens,
      total: inputTokens + outputTokens,
    },
    finishReason,
  };
}
