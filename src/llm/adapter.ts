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

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    consecutiveLlmFailures++;
    const body = await res.text().catch(() => "");
    throw new Error(`LLM ${config.provider} returned ${res.status}: ${body.slice(0, 200)}`);
  }

  consecutiveLlmFailures = 0; // reset on success

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const text = data.choices?.[0]?.message?.content?.trim() || "";
  const usage = data.usage;

  return {
    text,
    model: data.model || config.model,
    tokensUsed: usage
      ? { prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0, total: usage.total_tokens || 0 }
      : null,
  };
}
