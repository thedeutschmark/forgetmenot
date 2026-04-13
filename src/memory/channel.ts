/**
 * Channel state sync — keeps stream title, category, and live status
 * fresh in the channel_state table so prompts stay grounded.
 *
 * Uses the Twitch Helix API (GET /helix/streams) with the bot account
 * access token. Runs periodically alongside the compaction loop.
 */

import { getDb } from "../db/index.js";

export async function syncChannelState(
  broadcasterTwitchId: string,
  accessToken: string,
  clientId: string,
): Promise<void> {
  try {
    const res = await fetch(
      `https://api.twitch.tv/helix/streams?user_id=${broadcasterTwitchId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Client-Id": clientId,
        },
      },
    );

    if (!res.ok) {
      console.warn(`[channel] Helix streams returned ${res.status}`);
      return;
    }

    const data = (await res.json()) as {
      data?: Array<{
        title?: string;
        game_name?: string;
        type?: string;
      }>;
    };

    const stream = data.data?.[0];
    const isLive = stream?.type === "live";
    const title = stream?.title || null;
    const category = stream?.game_name || null;

    const db = getDb();
    db.prepare(`
      INSERT INTO channel_state (broadcaster_twitch_id, stream_title, stream_category, is_live, last_sync_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(broadcaster_twitch_id) DO UPDATE SET
        stream_title = excluded.stream_title,
        stream_category = excluded.stream_category,
        is_live = excluded.is_live,
        last_sync_at = datetime('now')
    `).run(broadcasterTwitchId, title, category, isLive ? 1 : 0);
  } catch (err) {
    console.warn("[channel] Sync failed:", err instanceof Error ? err.message : err);
  }
}
