/**
 * Post-generation filters for LLM reply output.
 *
 * Shared by the live reply engine (engine.ts) and the eval runner
 * (eval/runner.ts). Keeping them in one place is load-bearing: if the eval
 * bypasses these filters, the eval doesn't measure what production does,
 * and regressions slip through as "passing" tests (caught 2026-04-17 when
 * patches in engine.ts showed no eval delta because runner.ts didn't
 * invoke them).
 *
 * All filters are deterministic — regex + string predicates, no LLM calls.
 * Intentional design: the architectural lesson from v0.1.31 is that
 * engine-layer enforcement holds every time and prompt-level rules leak
 * probabilistically. Every filter here is a rule moved out of the prompt
 * into code.
 */

import type { ParsedReply } from "../actions/proposals.js";
import { detectDistress, detectTimeoutBait } from "./budget.js";

export interface PostProcessOptions {
  /** The login of the message author — the speaker we're replying to. */
  login: string;
  /** The raw user message that triggered this reply, for trigger detection. */
  message: string;
  /**
   * Optional log hook for observability of which filters fired. Defaults
   * to console.log in engine.ts, silent in the eval. Pass your own to
   * capture drop decisions for test assertions.
   */
  log?: (msg: string) => void;
}

/**
 * Mutate (and return) a ParsedReply after applying deterministic
 * post-generation filters. Order matters:
 *
 *   1. Double-@ strip — remove inline @<login> from reply body when the
 *      send path will auto-prepend it. Catches the 2026-04-17 live failure:
 *      "@okay_chr1s Don't test my patience, @okay_chr1s; …" where the LLM
 *      and the send path both tag the speaker, producing a visible
 *      double-tag in chat.
 *
 *   2. Distress gate — drop timeout_funny / timeout_serious proposals when
 *      the current message contains distress phrasing (and is not also
 *      explicit bait). The reply text ships; only the moderation action
 *      is suppressed. Prevents comedy timeouts on real bad-day venting.
 *
 *   3. Timeout-non-bait gate — drop timeout_funny proposals when no bait
 *      trigger is present. Flash-lite was caught spuriously proposing
 *      timeout_funny on 5 of 8 non-bait probes in the 2026-04-17 baseline
 *      eval ("pipe down", "why did you just say that", "hey maestro",
 *      "hey whats up", "you're kind of annoying today"). The prompt tells
 *      the model actions are optional; the model ignores the nuance. If
 *      the prompt's action schema grows engine-detectable signals for
 *      spam-after-warning or authority-challenge, add them here as OR
 *      clauses — until then, bait is the only affirmative trigger we can
 *      verify without consulting the LLM.
 */
export function applyPostGenFilters(
  parsed: ParsedReply,
  opts: PostProcessOptions,
): ParsedReply {
  const { login, message } = opts;
  const log = opts.log ?? (() => {});

  // 1. Double-@ strip.
  // Only runs when the reply doesn't already start with @ or /me — if the
  // LLM correctly led with @<someone else>, we keep that intact. The regex
  // is bounded with \b so @okay_chr1s doesn't partial-match @okay_chris.
  if (parsed.text && !/^\s*@/.test(parsed.text) && !/^\s*\/me\s/.test(parsed.text)) {
    const loginRe = new RegExp(`\\s*@${escapeRegex(login)}\\b[\\s,]*`, "gi");
    const stripped = parsed.text.replace(loginRe, " ").replace(/\s{2,}/g, " ").trim();
    if (stripped !== parsed.text && stripped.length > 0) {
      log(`[postgen] Double-@ strip — removed inline @${login} from reply body`);
      parsed.text = stripped;
    }
  }

  // 2. Distress gate.
  if (
    parsed.proposal
    && (parsed.proposal.action === "timeout_funny" || parsed.proposal.action === "timeout_serious")
    && detectDistress(message)
    && !detectTimeoutBait(message)
  ) {
    log(`[postgen] Distress gate — dropping ${parsed.proposal.action} against ${login} (distress phrase, no bait)`);
    parsed.proposal = null;
  }

  // 3. Timeout-non-bait gate.
  if (
    parsed.proposal
    && parsed.proposal.action === "timeout_funny"
    && !detectTimeoutBait(message)
  ) {
    log(`[postgen] Timeout gate — dropping timeout_funny against ${login} (no bait trigger)`);
    parsed.proposal = null;
  }

  return parsed;
}

/** Escape a literal string for use inside a RegExp. Defensive against
 *  exotic logins that might contain regex metacharacters. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
