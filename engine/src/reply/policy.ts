/**
 * Reply policy — low-risk gates for the shadow/live reply engine.
 *
 * These are deterministic checks, not LLM decisions.
 * The policy engine for actions (timeouts etc) comes in Phase 5.
 */

import type { BotPolicy, BotSettings } from "../runtime/config.js";
import { isCoolingDown, setCooldown } from "../runtime/cooldowns.js";
import { stripNakedActionLeaks } from "../actions/proposals.js";

export interface PolicyCheckResult {
  allowed: boolean;
  reason: string;
}

// Cooldowns tuned for the demo scenario: multiple viewers @-mentioning
// the bot within seconds of each other. 5s global was denying every
// second mention. Direct mentions now bypass cooldown entirely — the
// user explicitly asked, so we answer. Autonomous replies still respect
// both cooldowns so the bot doesn't monopolise chat.
const GLOBAL_COOLDOWN_MS = 2_000;
const PER_USER_COOLDOWN_MS = 10_000;

export function checkReplyPolicy(
  settings: BotSettings,
  policy: BotPolicy,
  targetLogin: string,
  isMention: boolean = false,
): PolicyCheckResult {
  // Safe mode blocks everything
  if (policy.safeMode) {
    return { allowed: false, reason: "safe_mode" };
  }

  // Autonomous replies must be enabled for non-mentions. Direct mentions
  // are always a user-initiated ask and shouldn't be gated by the
  // autonomous-reply toggle — that toggle is about the bot speaking
  // unprompted, not about whether it can answer when addressed.
  if (!policy.autonomousRepliesEnabled && !isMention) {
    return { allowed: false, reason: "autonomous_replies_disabled" };
  }

  // Cooldowns only apply to autonomous replies. Mentions bypass so chat
  // never sees "global_cooldown" deny on a direct @-ask.
  if (!isMention) {
    if (isCoolingDown("reply:global")) {
      return { allowed: false, reason: "global_cooldown" };
    }
    if (isCoolingDown(`reply:user:${targetLogin.toLowerCase()}`)) {
      return { allowed: false, reason: "per_user_cooldown" };
    }
  }

  // Denylist
  if (policy.denylist.includes(targetLogin.toLowerCase())) {
    return { allowed: false, reason: "denylisted" };
  }

  return { allowed: true, reason: "ok" };
}

/**
 * Check whether a chat message mentions the bot. Matches botName OR any alias,
 * case-insensitive substring. Aliases come from BotSettings.botAliases — users
 * configure these in the toolkit (e.g. "automark", "auto mark", "robot mark"
 * for a bot named "Auto_Mark").
 */
export function isMentionOfBot(message: string, settings: BotSettings): boolean {
  const lower = message.toLowerCase();
  if (lower.includes(settings.botName.toLowerCase())) return true;
  for (const alias of settings.botAliases || []) {
    if (alias && lower.includes(alias.toLowerCase())) return true;
  }
  return false;
}

export function recordReply(targetLogin: string): void {
  setCooldown("reply:global", GLOBAL_COOLDOWN_MS);
  setCooldown(`reply:user:${targetLogin.toLowerCase()}`, PER_USER_COOLDOWN_MS);
}

export function validateReplyText(
  text: string,
  settings: BotSettings,
  finishReason?: "stop" | "length" | "content_filter" | "tool_calls" | null,
): string | null {
  if (!text || text.trim().length === 0) return null;

  let cleaned = text.trim();

  // Strip newlines (Twitch doesn't support multi-line)
  cleaned = cleaned.replace(/[\r\n]+/g, " ");

  // Belt-and-suspenders: strip any naked action leak that slipped past
  // parseReplyWithAction. Parser only catches `[ACTION: name ...]`, this
  // also catches `reply_extra(message="...")` / `warning_playful k=v` emitted
  // on their own by an LLM that dropped the bracket wrapper. Chat should
  // NEVER see these, regardless of prompt obedience.
  cleaned = stripNakedActionLeaks(cleaned);

  // Markdown cleanup for Twitch chat:
  //  - `**bold**` / `__bold__` / `*italic*` — all invisible in Twitch.
  //    Drop the markers, keep the content. We do NOT auto-convert
  //    asterisk-wrapped text into /me — per 2026-04-14 direction, /me
  //    should be rare and intentional, picked by the LLM when genuinely
  //    funny. Mass-converting every `*shrugs*` into /me kills the bit.
  cleaned = cleaned
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1");

  // Cap length (Twitch max is 500 chars, but we keep it shorter)
  const maxChars = Math.min(500, settings.maxReplyLength * 4); // rough tokens-to-chars
  if (cleaned.length > maxChars) {
    cleaned = cleaned.slice(0, maxChars).trim();
  }

  // If the LLM hit max_tokens and we got a dangling fragment, trim back to
  // the last complete sentence. Avoids mid-word / mid-clause cutoffs like
  // "Define "alive." My" that read as broken.
  cleaned = trimToCompleteSentence(cleaned);

  // Truncation fallback: if the provider told us finish_reason="length" AND
  // trimToCompleteSentence couldn't find a safe boundary, we still send the
  // fragment with an ellipsis so chat gets *a* response. Explicit user
  // direction (2026-04-14): "the solution should never be to not respond."
  // A slightly rough reply beats silent denial — we'd rather chat see a
  // truncated thought than nothing at all.
  if (finishReason === "length" && !/[.!?…][\s"')\]}]*$/.test(cleaned)) {
    // Trim trailing partial word so the ellipsis doesn't land mid-syllable.
    cleaned = cleaned.replace(/\s+\S*$/, "").trim();
    if (cleaned.length === 0) return null;
    cleaned = cleaned + "…";
  }

  return cleaned || null;
}

/**
 * If the text ends mid-sentence, trim back to the last sentence terminator.
 * Keeps the whole thing if no terminator is found (better than empty).
 */
function trimToCompleteSentence(text: string): string {
  // Terminal characters that signal a complete thought.
  // Includes closing quotes/brackets immediately after punctuation.
  if (/[.!?…][\s"')\]}]*$/.test(text)) return text;

  // Find the last sentence terminator (and its trailing quote/bracket if any).
  const match = text.match(/^(.*[.!?…][\s"')\]}]*)(?:\s|$)/);
  if (match && match[1].length >= 10) {
    return match[1].trim();
  }

  // No good split point — keep as is. Better a slightly truncated reply
  // than nothing at all.
  return text;
}
