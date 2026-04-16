/**
 * Research provider — pluggable backend for TARS-mode factual grounding.
 *
 * Phase 1 (current): InternalKnowledgeProvider returns no snippets. The
 *   reasoning-model re-run relies on the Pro model's own world knowledge,
 *   which is substantially better than Flash-Lite. No external infra, no
 *   new API keys, no per-query cost.
 *
 * Phase 2 (scaffolded, not active): a real search provider (Brave, Tavily,
 *   etc.) that returns 1-2 bounded snippets to inject into the research
 *   re-run prompt. The interface is stable so dropping in a new provider
 *   is a registration change, not a refactor of the engine.
 *
 * Contract: `snippets` is hard-capped at 2 entries, each under ~80 tokens.
 * Providers enforce these limits internally — the engine trusts the shape.
 */

export interface ResearchResult {
  /** 0-2 short factual snippets. Empty is valid and means "no external
   *  data — let the reasoning model work from its own training." */
  snippets: string[];
  /** Human-readable provider name for logging. */
  source: string;
}

export interface ResearchProvider {
  research(query: string): Promise<ResearchResult>;
}

/**
 * Phase 1 provider — no external calls, zero extra tokens, zero extra
 * latency beyond the reasoning-model re-run itself. Treats the TARS-mode
 * call as "same question, smarter model" rather than "same model, more
 * context". Surprisingly effective for Gemini 2.5 Pro.
 */
export class InternalKnowledgeProvider implements ResearchProvider {
  async research(_query: string): Promise<ResearchResult> {
    return { snippets: [], source: "internal" };
  }
}

let currentProvider: ResearchProvider = new InternalKnowledgeProvider();

/** Override the default provider (used by tests + future web-search init). */
export function setResearchProvider(provider: ResearchProvider): void {
  currentProvider = provider;
}

export function getResearchProvider(): ResearchProvider {
  return currentProvider;
}

/** Detect a RESEARCH sentinel in LLM output. Must be strict — false
 *  positives turn every reply into a research re-run. */
const RESEARCH_PATTERN = /\[RESEARCH:\s*([^\]]{1,200})\]/;

export interface ResearchSentinel {
  query: string;
  /** The text after the sentinel was removed — usually empty when the
   *  LLM followed instructions, but we handle mixed output gracefully. */
  remainingText: string;
}

export function parseResearchSentinel(text: string): ResearchSentinel | null {
  const match = RESEARCH_PATTERN.exec(text);
  if (!match) return null;
  const query = match[1].trim();
  if (!query) return null;
  const remainingText = text.replace(RESEARCH_PATTERN, "").trim();
  return { query, remainingText };
}

/**
 * Pick the reasoning model for the research re-run based on the user's
 * configured provider. Intentionally hardcoded per-provider rather than a
 * separate setting — the choice is "best available reasoning model for
 * this provider" which rarely needs per-user tuning.
 */
export function pickResearchModel(provider: "gemini" | "openai"): string {
  // gemini-2.5-pro has native thinking mode. Flash-Lite (the default
  // reply model) doesn't. Pro's world knowledge is materially better for
  // factual questions.
  if (provider === "gemini") return "gemini-2.5-pro";
  // OpenAI: gpt-4o is the best non-reasoning-class model, cheaper than
  // o1/o3 while still a real step up from mini variants.
  return "gpt-4o";
}
