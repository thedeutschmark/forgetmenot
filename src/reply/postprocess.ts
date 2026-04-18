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
   * Recent bot replies (newest first or oldest first, order doesn't
   * matter) used for anti-repetition detection. Pass an empty array or
   * omit to disable the anti-repetition filter. Typically the same
   * value that's rendered into the prompt's YOUR RECENT REPLIES block.
   */
  recentReplies?: string[];
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

  // 3b. Insult-intensity strip.
  // HARD RULE 10: "mean for no reason reads as try-hard". Live v0.1.34
  // caught "It's 2026, you absolute buffoon, try to keep up." to the
  // broadcaster for a simple "what year is it" question — flash-lite
  // reaching for the cheap intensified insult. Regex-detect the
  // "you <intensifier> <insult-noun>" shape and strip the intensifier-
  // plus-insult-noun clause, leaving the factual payload intact. If the
  // stripped reply is left with just a comma-fragment, also clean that.
  // Preserves replies that are dry or sharp without crossing into
  // gratuitous-cruelty territory.
  if (parsed.text && INSULT_REGEX.test(parsed.text)) {
    const before = parsed.text;
    const stripped = parsed.text
      .replace(INSULT_REGEX, "")
      .replace(/,\s*,/g, ",")
      .replace(/,\s*([.?!])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (stripped.length > 0) {
      log(`[postgen] Insult-intensity strip — removed "${before.match(INSULT_REGEX)![0]}" from reply`);
      parsed.text = stripped;
    }
  }

  // 3c. Anti-repetition.
  // HARD RULE 2: don't reuse openers, sentence shapes, or specific
  // phrasing from YOUR RECENT REPLIES. Caught live on the 2026-04-18
  // 10-probe run: "That's rich coming from..." appeared in two
  // consecutive replies back-to-back. Prose rule leaks — flash-lite
  // pattern-matches its own prior output and repeats the hook.
  //
  // Two-tier detection:
  //   (a) Exact duplicate (case-insensitive, whitespace-normalized) →
  //       replace with canned "Hm." — the same reply twice is useless.
  //   (b) 5+ consecutive word substring overlap with any recent reply →
  //       log only. Stripping a shared chunk risks mangling the sentence
  //       (same tradeoff that killed length-cap enforcement). Log gives
  //       observability; if rates are high in live, v0.1.36 can
  //       escalate to canned-fallback or LLM re-roll.
  //
  // Recent replies are passed in from the engine via opts.recentReplies
  // (matches context.recentBotReplies in the live path). Eval mode can
  // pass an empty array; fixtures are single-message and have no history.
  if (parsed.text && opts.recentReplies && opts.recentReplies.length > 0) {
    const norm = (s: string) => s.toLowerCase().replace(/^\s*@\S+\s+/, "").replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
    const currentNorm = norm(parsed.text);
    const currentWords = currentNorm.split(" ").filter(Boolean);

    let duplicateOf: string | null = null;
    let overlapWindow: string | null = null;

    for (const prior of opts.recentReplies) {
      const priorNorm = norm(prior);
      if (!priorNorm) continue;

      // Tier a — exact duplicate
      if (priorNorm === currentNorm) {
        duplicateOf = prior;
        break;
      }

      // Tier b — 5+ consecutive word overlap
      if (!overlapWindow && currentWords.length >= 5) {
        const priorWords = priorNorm.split(" ").filter(Boolean);
        const priorSet = priorWords.join(" ");
        for (let i = 0; i + 5 <= currentWords.length; i++) {
          const window = currentWords.slice(i, i + 5).join(" ");
          if (priorSet.includes(window)) {
            overlapWindow = window;
            break;
          }
        }
      }
    }

    if (duplicateOf) {
      log(`[postgen] Anti-repetition — current reply is an exact duplicate of recent reply, replacing with canned`);
      parsed.text = "Hm.";
    } else if (overlapWindow) {
      log(`[postgen] Anti-repetition — 5+ word overlap with recent reply: "${overlapWindow}" (logged, not mutated)`);
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
 * observed across the 2026-04-16, 2026-04-17, and 2026-04-18 live sessions.
 * Kept to unambiguous AI-narration shapes — "my code" alone is too broad
 * (could be a developer talking about their own code), but the specific
 * possessive-abstract-noun tells below are all rule-3a violations.
 *
 * Three families:
 *   (1) Substrate hardware/process — "my circuits", "my internal
 *       temperature", "my systems", "my sustenance", "my archives",
 *       "my processors", "my programming", "my algorithm", "my neural",
 *       "my training data". These are AI-narrating-its-guts.
 *
 *   (2) Possessive-abstract-noun — "my patience", "my limits",
 *       "my tolerance", "my standards", "my sanity", "my mercy".
 *       Expanded 2026-04-18 after live probe 3 returned "testing my
 *       patience again?" and the original live @okay_chr1s failure
 *       ("Don't test my patience"). Same AI-chatbot-persona-bragging
 *       family as "my circuits" — bot narrating an internal state.
 *
 *   (3) Second-person narration shapes — "you organics", "you humans",
 *       "you meatbags", "quaint biological", "thermal variance",
 *       "purely digital". Hostile-AI stereotype phrases.
 */
const SUBSTRATE_REGEX = /\bmy (circuits?|internal (temperature|components|systems|processes|parameters)|systems|components|sustenance|archives|processors?|programming|algorithm|neural|training data|arithmetic functions?|chronological circuits|omniscience|protocols|directives|patience|limits|tolerance|standards|sanity|mercy)\b|\byou (organics|humans|meatbags)\b|\bquaint biological\b|\bthermal variance\b|\bpurely digital\b/i;

/**
 * Insult-intensity detection regex. Rule 10 + the v0.1.34 live observation:
 * the model reaches for cheap intensifier+insult combos ("you absolute
 * buffoon", "you complete moron") when a dry jab would have worked. This
 * catches the specific hostile-intensifier shape; milder sarcasm and
 * ordinary dry putdowns pass through untouched.
 *
 * The comma trailer in the pattern lets us strip "you absolute buffoon,"
 * mid-sentence cleanly. Without it, strip leaves a dangling comma.
 */
const INSULT_REGEX = /,?\s*\byou (absolute|total|complete|utter|fucking|damn|bloody|goddamn) (buffoon|moron|idiot|imbecile|dumbass|clown|fool|jackass|loser|simpleton|halfwit|cretin|twit)\b[,.!?]?/i;

/** Escape a literal string for use inside a RegExp. Defensive against
 *  exotic logins that might contain regex metacharacters. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
