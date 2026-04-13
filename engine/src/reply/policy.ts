/**
 * Reply policy — low-risk gates for the shadow/live reply engine.
 *
 * These are deterministic checks, not LLM decisions.
 * The policy engine for actions (timeouts etc) comes in Phase 5.
 */

import type { BotPolicy, BotSettings } from "../runtime/config.js";
import { isCoolingDown, setCooldown } from "../runtime/cooldowns.js";

export interface PolicyCheckResult {
  allowed: boolean;
  reason: string;
}

const GLOBAL_COOLDOWN_MS = 5_000;
const PER_USER_COOLDOWN_MS = 30_000;

export function checkReplyPolicy(
  settings: BotSettings,
  policy: BotPolicy,
  targetLogin: string,
): PolicyCheckResult {
  // Safe mode blocks everything
  if (policy.safeMode) {
    return { allowed: false, reason: "safe_mode" };
  }

  // Autonomous replies must be enabled
  if (!policy.autonomousRepliesEnabled) {
    return { allowed: false, reason: "autonomous_replies_disabled" };
  }

  // Global cooldown (persisted)
  if (isCoolingDown("reply:global")) {
    return { allowed: false, reason: "global_cooldown" };
  }

  // Per-user cooldown (persisted)
  if (isCoolingDown(`reply:user:${targetLogin.toLowerCase()}`)) {
    return { allowed: false, reason: "per_user_cooldown" };
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

export function validateReplyText(text: string, settings: BotSettings): string | null {
  if (!text || text.trim().length === 0) return null;

  let cleaned = text.trim();

  // Strip newlines (Twitch doesn't support multi-line)
  cleaned = cleaned.replace(/[\r\n]+/g, " ");

  // Cap length (Twitch max is 500 chars, but we keep it shorter)
  const maxChars = Math.min(500, settings.maxReplyLength * 4); // rough tokens-to-chars
  if (cleaned.length > maxChars) {
    cleaned = cleaned.slice(0, maxChars).trim();
  }

  // If the LLM hit max_tokens and we got a dangling fragment, trim back to
  // the last complete sentence. Avoids mid-word / mid-clause cutoffs like
  // "Define "alive." My" that read as broken.
  cleaned = trimToCompleteSentence(cleaned);

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
