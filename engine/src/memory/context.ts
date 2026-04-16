/**
 * Memory context builder.
 *
 * Pulls recent events + viewer notes + channel state from SQLite
 * and assembles a compact context object for the LLM prompt.
 */

import { getDb } from "../db/index.js";
import { getCurrentSessionId } from "./channel.js";
import type { SourceKind } from "./notes.js";

export interface ViewerContext {
  login: string;
  displayName: string;
  trustLevel: string;
  isRegular: boolean;
  isMod: boolean;
  isVip: boolean;
  optInFunModeration: boolean;
  notes: string[];
  /** Parallel array — note row IDs in the same order as `notes`. Used by
   *  eval scoring and production observability. Prompt rendering ignores it. */
  noteIds: number[];
  /** Parallel array — provenance kind for each note in `notes`, same
   *  order. `null` for legacy rows written before schema v3. Used by the
   *  prompt renderer to tag notes [said] / [reported] / [guess]. */
  noteKinds: Array<SourceKind | null>;
  /** The target viewer's own last messages, oldest first. Twitch convention:
   *  people split thoughts across multiple lines then @-tag the bot to
   *  demand an answer — so the bot needs to see what they just said BEFORE
   *  the @-line to know what they're asking about. Separate from the
   *  channel-wide `recentMessages` so it survives chat-trim in busy streams. */
  recentOwnMessages: string[];
}

export interface EpisodeEntry {
  summary: string;
  startedAt: string;
  /** Which stream this episode belongs to: "current", "previous", or null (legacy/unknown). */
  stream: "current" | "previous" | null;
}

/** Recap of the previous stream session, if one exists. */
export interface PreviousStreamContext {
  recap: string | null;
  title: string | null;
  category: string | null;
  endedAt: string;
}

export interface ReplyContext {
  recentMessages: Array<{ login: string; text: string; at: string }>;
  targetViewer: ViewerContext | null;
  channelTitle: string | null;
  channelCategory: string | null;
  recentEpisodes: string[];
  /** Structured episodes with stream session context. Budget/prompt uses
   *  this for labeled rendering; recentEpisodes kept for backwards compat. */
  episodes: EpisodeEntry[];
  previousStream: PreviousStreamContext | null;
  recentNotes: string[];
  /** Parallel array — channel note row IDs in the same order as `recentNotes`. */
  recentNoteIds: number[];
  /** Parallel array — provenance kind for each channel note. See
   *  ViewerContext.noteKinds for semantics. */
  recentNoteKinds: Array<SourceKind | null>;
  /** The bot's last few replies, oldest first. Surfaced in the prompt as
   *  an explicit "you just said these — DO NOT repeat openers, structure,
   *  or specific phrasing" instruction. Without this, gemini happily reuses
   *  "Oh, X" / "How precious" / "sweetie" forever. */
  recentBotReplies: string[];
}

/**
 * Build context for a reply to a specific user's message.
 *
 * `staleDays`: notes whose last_confirmed_at is older than this are excluded
 * from the retrieval window. Notes that fall out of the window aren't
 * deleted — they're just not surfaced to the LLM. A later re-extraction
 * that matches the same fact will bump last_confirmed_at and revive it.
 * Default 90 days; override from settings.memoryRetentionDays at the
 * caller site.
 */
export function buildReplyContext(
  targetLogin: string,
  targetTwitchId: string,
  maxMessages: number = 20,
  staleDays: number = 90,
): ReplyContext {
  const db = getDb();

  // Recent chat messages (working set)
  const recentMessages = db
    .prepare(`
      SELECT v.login, e.message_text AS text, e.occurred_at AS at
      FROM events e
      LEFT JOIN viewers v ON v.twitch_user_id = e.twitch_user_id
      WHERE e.event_type = 'chat_message'
      ORDER BY e.occurred_at DESC
      LIMIT ?
    `)
    .all(maxMessages) as Array<{ login: string | null; text: string; at: string }>;

  // Reverse so oldest is first (chronological order for the prompt)
  recentMessages.reverse();

  // Target viewer profile
  let targetViewer: ViewerContext | null = null;
  const viewer = db
    .prepare(`SELECT * FROM viewers WHERE twitch_user_id = ? OR login = ?`)
    .get(targetTwitchId, targetLogin.toLowerCase()) as Record<string, unknown> | undefined;

  if (viewer) {
    // Load semantic notes for this viewer.
    // subject_id is the lowercase login (matches how memory/notes.ts writes them
    // — see notes.ts line 127). Using twitch_user_id here returns nothing.
    // Stale filter: note must have been confirmed within the retention
    // window. Sliding window — a stale note that gets re-confirmed via
    // the dedup path re-enters the retrieval set automatically because
    // its last_confirmed_at jumps to now.
    const staleCutoff = `-${Math.max(1, Math.round(staleDays))} days`;
    // Retrieval rank = confidence * recency_factor, where recency_factor
    // decays with age since last_confirmed_at. Blend keeps high-confidence
    // facts surfaced even as they age, without letting truly ancient
    // claims beat fresh reconfirmations. See notes below.
    const notes = db
      .prepare(`
        SELECT id, fact, source_kind FROM semantic_notes
        WHERE scope = 'viewer' AND subject_id = ? AND status = 'active'
          AND last_confirmed_at > datetime('now', ?)
        ORDER BY (confidence * (1.0 / (1.0 + (julianday('now') - julianday(last_confirmed_at)) / 7.0))) DESC,
                 last_confirmed_at DESC
        LIMIT 10
      `)
      .all(String(viewer.login || "").toLowerCase(), staleCutoff) as Array<{ id: number; fact: string; source_kind: string | null }>;

    // Target viewer's own recent chat messages. On Twitch, users frequently
    // split a single thought across multiple messages ("wait", "actually",
    // "@bot what I meant was..."), then @-tag the bot to force a reply. If
    // we only show the single @-message, the bot has no idea what they're
    // actually asking. Pull their last 5 messages so the intent is visible.
    const ownMsgs = db
      .prepare(`
        SELECT message_text AS text FROM events
        WHERE event_type = 'chat_message' AND twitch_user_id = ?
        ORDER BY occurred_at DESC
        LIMIT 5
      `)
      .all(targetTwitchId) as Array<{ text: string }>;
    ownMsgs.reverse();

    targetViewer = {
      login: String(viewer.login || ""),
      displayName: String(viewer.display_name || viewer.login || ""),
      trustLevel: String(viewer.trust_level || "unknown"),
      isRegular: Boolean(viewer.is_regular),
      isMod: Boolean(viewer.is_mod),
      isVip: Boolean(viewer.is_vip),
      optInFunModeration: Boolean(viewer.opt_in_fun_moderation),
      notes: notes.map((n) => n.fact),
      noteIds: notes.map((n) => Number(n.id)),
      noteKinds: notes.map((n) => normalizeKind(n.source_kind)),
      recentOwnMessages: ownMsgs.map((m) => m.text),
    };
  }

  // Channel state
  const channel = db
    .prepare("SELECT stream_title, stream_category FROM channel_state LIMIT 1")
    .get() as { stream_title: string | null; stream_category: string | null } | undefined;

  // Recent episodes (mid-term memory) — session-aware retrieval.
  // Pull up to 2 from the current stream session + 1 from the previous,
  // so the LLM can distinguish "now" from "last time." Falls back to the
  // old "last 3 by time" query when no session is active (legacy/unknown).
  const activeSessionId = getCurrentSessionId();

  const currentEpisodes = activeSessionId != null
    ? db.prepare(`
        SELECT summary, started_at FROM episodes
        WHERE status = 'active' AND summary IS NOT NULL AND stream_session_id = ?
        ORDER BY started_at DESC LIMIT 2
      `).all(activeSessionId) as Array<{ summary: string; started_at: string }>
    : db.prepare(`
        SELECT summary, started_at FROM episodes
        WHERE status = 'active' AND summary IS NOT NULL
        ORDER BY started_at DESC LIMIT 2
      `).all() as Array<{ summary: string; started_at: string }>;

  // Previous session: find the most recent closed session (not the current one)
  const prevSession = (activeSessionId != null
    ? db.prepare(`
        SELECT id, recap, title, category, ended_at FROM stream_sessions
        WHERE ended_at IS NOT NULL AND id != ?
        ORDER BY ended_at DESC LIMIT 1
      `).get(activeSessionId)
    : db.prepare(`
        SELECT id, recap, title, category, ended_at FROM stream_sessions
        WHERE ended_at IS NOT NULL
        ORDER BY ended_at DESC LIMIT 1
      `).get()
  ) as { id: number; recap: string | null; title: string | null; category: string | null; ended_at: string } | undefined;

  // Grab 1 episode from the previous session for more detail
  const prevEpisodes = prevSession
    ? db.prepare(`
        SELECT summary, started_at FROM episodes
        WHERE status = 'active' AND summary IS NOT NULL AND stream_session_id = ?
        ORDER BY started_at DESC LIMIT 1
      `).all(prevSession.id) as Array<{ summary: string; started_at: string }>
    : [];

  // currentEpisodes is DESC from query — reverse to chronological for prompt
  currentEpisodes.reverse();

  // Build structured episodes list (chronological current, then previous)
  const structuredEpisodes: EpisodeEntry[] = [
    ...currentEpisodes.map((e) => ({
      summary: e.summary,
      startedAt: e.started_at,
      stream: "current" as const,
    })),
    ...prevEpisodes.map((e) => ({
      summary: e.summary,
      startedAt: e.started_at,
      stream: "previous" as const,
    })),
  ];

  // Flat list for backwards compat (recentEpisodes)
  const episodes = [...currentEpisodes, ...prevEpisodes];

  const previousStream: PreviousStreamContext | null = prevSession
    ? {
        recap: prevSession.recap,
        title: prevSession.title,
        category: prevSession.category,
        endedAt: prevSession.ended_at,
      }
    : null;

  // Channel-level semantic notes — same stale filter + same
  // confidence*recency blend as viewer notes.
  const channelStaleCutoff = `-${Math.max(1, Math.round(staleDays))} days`;
  const channelNotes = db
    .prepare(`
      SELECT id, fact, source_kind FROM semantic_notes
      WHERE scope = 'channel' AND status = 'active'
        AND last_confirmed_at > datetime('now', ?)
      ORDER BY (confidence * (1.0 / (1.0 + (julianday('now') - julianday(last_confirmed_at)) / 7.0))) DESC,
               last_confirmed_at DESC
      LIMIT 5
    `)
    .all(channelStaleCutoff) as Array<{ id: number; fact: string; source_kind: string | null }>;

  // Bot's own recent replies — fed back into the prompt so the LLM sees
  // its own pattern and breaks out of trope loops. Without this, gemini
  // reuses "Oh, X" / "How precious" / "sweetie" indefinitely.
  const recentBotReplies = (() => {
    try {
      return (db
        .prepare(`SELECT reply_text FROM bot_messages ORDER BY id DESC LIMIT 5`)
        .all() as Array<{ reply_text: string }>)
        .map((r) => r.reply_text)
        .reverse();
    } catch {
      return [];
    }
  })();

  return {
    recentMessages: recentMessages.map((m) => ({
      login: m.login || "unknown",
      text: m.text,
      at: m.at,
    })),
    targetViewer,
    channelTitle: channel?.stream_title ?? null,
    channelCategory: channel?.stream_category ?? null,
    recentEpisodes: episodes.map((e) => e.summary),
    episodes: structuredEpisodes,
    previousStream,
    recentNotes: channelNotes.map((n) => n.fact),
    recentNoteIds: channelNotes.map((n) => Number(n.id)),
    recentNoteKinds: channelNotes.map((n) => normalizeKind(n.source_kind)),
    recentBotReplies,
  };
}

/** Coerce raw DB value to our SourceKind enum, returning null for unknown
 *  or legacy values. Keeps invalid data out of the prompt renderer. */
function normalizeKind(raw: string | null | undefined): SourceKind | null {
  if (raw === "self_claim" || raw === "reported" || raw === "inferred") return raw;
  return null;
}
