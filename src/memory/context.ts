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
}

export interface ReplyContext {
  recentMessages: Array<{ login: string; text: string; at: string }>;
  targetViewer: ViewerContext | null;
  channelTitle: string | null;
  channelCategory: string | null;
  recentEpisodes: string[];
  recentNotes: string[];
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
    // Load semantic notes for this viewer
    const notes = db
      .prepare(`
        SELECT fact FROM semantic_notes
        WHERE scope = 'viewer' AND subject_id = ? AND status = 'active'
        ORDER BY last_confirmed_at DESC
        LIMIT 10
      `)
      .all(String(viewer.twitch_user_id || viewer.id)) as Array<{ fact: string }>;

    targetViewer = {
      login: String(viewer.login || ""),
      displayName: String(viewer.display_name || viewer.login || ""),
      trustLevel: String(viewer.trust_level || "unknown"),
      isRegular: Boolean(viewer.is_regular),
      isMod: Boolean(viewer.is_mod),
      isVip: Boolean(viewer.is_vip),
      optInFunModeration: Boolean(viewer.opt_in_fun_moderation),
      notes: notes.map((n) => n.fact),
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
      SELECT fact FROM semantic_notes
      WHERE scope = 'channel' AND status = 'active'
      ORDER BY last_confirmed_at DESC
      LIMIT 5
    `)
    .all() as Array<{ fact: string }>;

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
  };
}
