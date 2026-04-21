/**
 * In-memory ring buffer of recent `!sr <query>` requests seen in chat.
 *
 * Used by the music picker (autonomous chime + abstract-ask handling) as the
 * sole vibe signal. Per 2026-04-21 user direction: do NOT analyze what's
 * currently playing on Spotify — analyze what other chatters have been
 * REQUESTING. The bot's job is to read the room's queue, not the speaker.
 *
 * Lightweight by design: in-memory only, no persistence. Restart wipes
 * the buffer; fine, the bot just won't have signal for a few minutes
 * until viewers !sr again.
 *
 * The bot's own !sr emissions are also tracked (so the picker can avoid
 * re-suggesting something the bot just queued).
 */

export interface SrRequest {
  /** Twitch login of whoever ran !sr. May be the bot itself. */
  requester: string;
  /** Raw query text after `!sr ` — could be a song title, "title artist",
   *  a Spotify URL, etc. Trimmed and capped. */
  query: string;
  /** ms epoch */
  ts: number;
  /** True iff this !sr was emitted by the bot itself (autonomous chime
   *  or abstract-ask response). Lets the picker exclude its own picks. */
  fromBot: boolean;
}

const recentRequests: SrRequest[] = [];
const MAX_BUFFER = 30;
const SR_REGEX = /^\s*!sr\s+(.+)/i;

/**
 * Pass every chat message through this. If it starts with `!sr `, it's
 * captured into the buffer. Otherwise no-op. Cheap to call per message.
 *
 * `botLogin` is the bot's own Twitch login (lowercased) so we can flag
 * its own emissions correctly when the IRC echo comes back through.
 */
export function trackChatMessage(login: string, text: string, botLogin: string): void {
  const m = text.match(SR_REGEX);
  if (!m) return;
  const query = m[1].trim().slice(0, 200);
  if (!query) return;
  recentRequests.push({
    requester: login,
    query,
    ts: Date.now(),
    fromBot: login.toLowerCase() === botLogin.toLowerCase(),
  });
  while (recentRequests.length > MAX_BUFFER) recentRequests.shift();
}

/**
 * Recent !sr requests within `maxAgeMs` (default 60 min). Returns most
 * recent first. Includes bot's own emissions — caller decides whether
 * to filter them via `excludeBotEmissions`.
 */
export function getRecentSrRequests(
  maxAgeMs = 60 * 60 * 1000,
  excludeBotEmissions = false,
): SrRequest[] {
  const cutoff = Date.now() - maxAgeMs;
  const out = recentRequests.filter((r) => r.ts >= cutoff);
  if (excludeBotEmissions) return out.filter((r) => !r.fromBot).slice().reverse();
  return out.slice().reverse();
}

/** Total count in the buffer (after age filter). Used by chime gate to
 *  require a minimum signal before firing. */
export function getRecentSrCount(maxAgeMs = 60 * 60 * 1000): number {
  const cutoff = Date.now() - maxAgeMs;
  return recentRequests.filter((r) => r.ts >= cutoff).length;
}
