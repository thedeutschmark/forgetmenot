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
 * post-generation filters. Order matters — text transforms run before
 * action gates so substrate-scrubbed replies still have action proposals
 * evaluated correctly.
 *
 *   TEXT TRANSFORMS (mutate parsed.text in place):
 *   1. Banned-opener strip — remove "Oh,", "Well,", "Ah,", "So,", "Fine,"
 *      prefixes. Rule 3 bans these as hallmark AI chatbot openers; flash-
 *      lite ignores the prose rule (~14 instances in one live session on
 *      2026-04-17). Strip deterministically, recapitalize.
 *
 *   2. Dangling-comma cleanup — fix "phrase, ." / "phrase, ?" patterns
 *      where the LLM wrote "phrase, {name}." and {name} came out empty
 *      (display_name null / template bug somewhere upstream). Observed
 *      live as "Bold move, ." / "surprisingly durable, ." / "a tan, ?".
 *
 *   3. Double-@ strip — remove inline @<login> from reply body when the
 *      send path will auto-prepend it. Catches the 2026-04-17 live failure:
 *      "@okay_chr1s Don't test my patience, @okay_chr1s; …" where the LLM
 *      and the send path both tag the speaker, producing a visible
 *      double-tag in chat.
 *
 *   4. Bot-substrate scrub — detect rule-3a-banned phrases ("my circuits",
 *      "my internal temperature", "my systems", "you organics", "quaint
 *      biological", etc.). If found, replace the whole reply with a short
 *      canned ack so a banned-sentence leak is never visible to chat.
 *      Aggressive on purpose — substrate leaks are the #1 character-break
 *      and the prose ban (rule 3a) fails probabilistically.
 *
 *   ACTION GATES (mutate parsed.proposal):
 *   5. Distress gate — drop timeout_funny / timeout_serious proposals when
 *      the current message contains distress phrasing (and is not also
 *      explicit bait). Prevents comedy timeouts on real bad-day venting.
 *
 *   6. Timeout-non-bait gate — drop timeout_funny proposals when no bait
 *      trigger is present. Flash-lite was caught spuriously proposing
 *      timeout_funny on 5 of 8 non-bait probes in the 2026-04-17 baseline
 *      eval ("pipe down", "why did you just say that", etc).
 */
export function applyPostGenFilters(
  parsed: ParsedReply,
  opts: PostProcessOptions,
): ParsedReply {
  const { login, message } = opts;
  const log = opts.log ?? (() => {});

  // 1. Banned-opener strip.
  // Rule 3 bans "Oh,", "Well,", "Ah,", "So,", "Fine," as openers — they're
  // the single biggest tell that a reply was LLM-generated. Flash-lite
  // ignores the prose ban ~14 times in one live session. We strip
  // deterministically: match the opener + any trailing whitespace/comma,
  // drop it, then recapitalize the new first letter. If the reply is left
  // empty after stripping, fall through to the other guards.
  if (parsed.text) {
    const openerRe = /^\s*(oh|well|ah|so|fine)\s*,\s*/i;
    if (openerRe.test(parsed.text)) {
      const trimmed = parsed.text.replace(openerRe, "");
      const recapped = trimmed.length > 0
        ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
        : trimmed;
      log(`[postgen] Banned-opener strip — removed "${parsed.text.match(openerRe)![0].trim()}" prefix`);
      parsed.text = recapped;
    }
  }

  // 2. Dangling-punctuation / empty-placeholder cleanup.
  // The LLM writes "phrase, {name}." or "Hello {name}." and {name} comes
  // out empty (display_name bug upstream), leaving artifacts like:
  //   "Bold move, ."     — comma + space + period
  //   "surprisingly durable, ."
  //   "a tan, ?"
  //   "Hello ."          — word + space + period (no comma)
  //   "@{login} ."       — orphan @
  // Three cleanups, in order:
  //   (a) "," + whitespace + terminal punctuation → just the punctuation
  //   (b) whitespace + terminal punctuation immediately after a word → word + punctuation
  //   (c) orphan "@" followed by whitespace + punctuation → just the punctuation
  if (parsed.text) {
    const before = parsed.text;
    const cleaned = parsed.text
      .replace(/,\s+([.?!])/g, "$1")           // (a) "phrase, ." → "phrase."
      .replace(/(\w)\s+([.?!])(?!\w)/g, "$1$2") // (b) "Hello ." → "Hello."
      .replace(/@\s+([.?!])/g, "$1")            // (c) "@ ." → "."
      .replace(/\s{2,}/g, " ")
      .trim();
    if (cleaned !== before && cleaned.length > 0) {
      log(`[postgen] Dangling-punctuation cleanup — fixed empty-placeholder artifact`);
      parsed.text = cleaned;
    }
  }

  // 3. Double-@ strip.
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

  // 4. Bot-substrate scrub.
  // Rule 3a bans bot-narrating-its-substrate language ("my circuits", "my
  // systems", "my internal temperature", "my sustenance", "my components",
  // "you organics", "quaint biological", etc). The prose ban loses —
  // observed live 2026-04-17 with 5+ substrate phrases in one session.
  // Detection here is conservative: only the specific multi-word patterns
  // that unambiguously indicate AI-narration. If found, we replace the
  // entire reply with a short canned ack. Aggressive on purpose: shipping
  // a banned-sentence visible to chat is worse than shipping a terse "Hm."
  if (parsed.text && SUBSTRATE_REGEX.test(parsed.text)) {
    log(`[postgen] Substrate scrub — replaced reply containing substrate narration ("${parsed.text.slice(0, 60)}…")`);
    parsed.text = "Hm.";
  }

  // 5. Distress gate.
  if (
    parsed.proposal
    && (parsed.proposal.action === "timeout_funny" || parsed.proposal.action === "timeout_serious")
    && detectDistress(message)
    && !detectTimeoutBait(message)
  ) {
    log(`[postgen] Distress gate — dropping ${parsed.proposal.action} against ${login} (distress phrase, no bait)`);
    parsed.proposal = null;
  }

  // 6. Timeout-non-bait gate.
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

/**
 * Bot-substrate detection regex. Covers the specific multi-word patterns
 * observed across the 2026-04-16 and 2026-04-17 live sessions. Kept to
 * unambiguous AI-narration shapes — "my code" alone is too broad (could
 * be a developer talking about their own code), but "my circuits",
 * "my internal X", "my programming", "my sustenance" and "you organics"
 * are all unambiguous tells. Case-insensitive.
 */
const SUBSTRATE_REGEX = /\bmy (circuits?|internal (temperature|components|systems|processes|parameters)|systems|components|sustenance|archives|processors?|programming|algorithm|neural|training data|arithmetic functions?|chronological circuits|omniscience|protocols|directives)\b|\byou (organics|humans|meatbags)\b|\bquaint biological\b|\bthermal variance\b|\bpurely digital\b|\bmy (internal temperature|internal components|internal systems|internal processes)\b/i;

/** Escape a literal string for use inside a RegExp. Defensive against
 *  exotic logins that might contain regex metacharacters. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
