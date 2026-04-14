/**
 * Memory context builder.
 *
 * Pulls recent events + viewer notes + channel state from SQLite
 * and assembles a compact context object for the LLM prompt.
 */

import { getDb } from "../db/index.js";

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
  /** The target viewer's own last messages, oldest first. Twitch convention:
   *  people split thoughts across multiple lines then @-tag the bot to
   *  demand an answer — so the bot needs to see what they just said BEFORE
   *  the @-line to know what they're asking about. Separate from the
   *  channel-wide `recentMessages` so it survives chat-trim in busy streams. */
  recentOwnMessages: string[];
}

export interface ReplyContext {
  recentMessages: Array<{ login: string; text: string; at: string }>;
  targetViewer: ViewerContext | null;
  channelTitle: string | null;
  channelCategory: string | null;
  recentEpisodes: string[];
  recentNotes: string[];
  /** Parallel array — channel note row IDs in the same order as `recentNotes`. */
  recentNoteIds: number[];
  /** The bot's last few replies, oldest first. Surfaced in the prompt as
   *  an explicit "you just said these — DO NOT repeat openers, structure,
   *  or specific phrasing" instruction. Without this, gemini happily reuses
   *  "Oh, X" / "How precious" / "sweetie" forever. */
  recentBotReplies: string[];
}

/**
 * Build context for a reply to a specific user's message.
 */
export function buildReplyContext(
  targetLogin: string,
  targetTwitchId: string,
  maxMessages: number = 20,
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
    const notes = db
      .prepare(`
        SELECT id, fact FROM semantic_notes
        WHERE scope = 'viewer' AND subject_id = ? AND status = 'active'
        ORDER BY last_confirmed_at DESC
        LIMIT 10
      `)
      .all(String(viewer.login || "").toLowerCase()) as Array<{ id: number; fact: string }>;

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
      recentOwnMessages: ownMsgs.map((m) => m.text),
    };
  }

  // Channel state
  const channel = db
    .prepare("SELECT stream_title, stream_category FROM channel_state LIMIT 1")
    .get() as { stream_title: string | null; stream_category: string | null } | undefined;

  // Recent episodes (mid-term memory)
  const episodes = db
    .prepare(`
      SELECT summary FROM episodes
      WHERE status = 'active' AND summary IS NOT NULL
      ORDER BY started_at DESC
      LIMIT 3
    `)
    .all() as Array<{ summary: string }>;

  // Channel-level semantic notes
  const channelNotes = db
    .prepare(`
      SELECT id, fact FROM semantic_notes
      WHERE scope = 'channel' AND status = 'active'
      ORDER BY last_confirmed_at DESC
      LIMIT 5
    `)
    .all() as Array<{ id: number; fact: string }>;

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
    recentNotes: channelNotes.map((n) => n.fact),
    recentNoteIds: channelNotes.map((n) => Number(n.id)),
    recentBotReplies,
  };
}
