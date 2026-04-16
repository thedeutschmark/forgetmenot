/**
 * Compaction loop — periodically processes raw events into higher-tier
 * memory structures.
 *
 * Runs every INTERVAL_MS:
 *   1. Write episodes from accumulated chat events
 *   2. Extract semantic notes from new episodes
 *   3. Sync channel state from Twitch Helix
 *   4. Prune old raw events past TTL
 *
 * Each step is independent — a failure in one doesn't block the others.
 */

import { writeEpisodes } from "./episodes.js";
import { extractNotes } from "./notes.js";
import { syncChannelState, restoreSessionState, getCurrentSessionId, flushCurrentSession } from "./channel.js";
import { getDb } from "../db/index.js";
import type { RuntimeBundle } from "../runtime/config.js";

const COMPACTION_INTERVAL_MS = 180_000; // 3 minutes
const EVENT_TTL_HOURS = 24; // prune raw events older than this
/** Close the current session if it's been idle this long AND the channel
 *  is not currently live. Covers the case where Helix missed the offline
 *  transition. Sized above max stream length (4-8h) with buffer — a mid-
 *  stream silence should never trigger this; the is_live gate is the real
 *  protection, the threshold is belt-and-suspenders. */
const SILENCE_GAP_HOURS = 12;

let timer: ReturnType<typeof setInterval> | null = null;
let currentBundle: RuntimeBundle | null = null;
let apiKey: string = "";
let clientId: string = "";

function currentLlmConfig(): { provider: "gemini" | "openai"; model: string; apiKey: string } | null {
  if (!currentBundle || !apiKey) return null;
  return {
    provider: currentBundle.settings.aiProvider,
    model: currentBundle.settings.aiModel,
    apiKey,
  };
}

/**
 * Flush the current session for shutdown. Called by the process SIGINT/
 * SIGTERM/SIGHUP handler in index.ts so closing the bot ("right-click
 * close") still generates a recap before exit.
 */
export async function flushCurrentSessionForShutdown(): Promise<void> {
  await flushCurrentSession(currentLlmConfig());
}

export function startCompaction(
  bundle: RuntimeBundle,
  llmApiKey: string,
  twitchClientId: string,
): void {
  currentBundle = bundle;
  apiKey = llmApiKey;
  clientId = twitchClientId;

  if (timer) clearInterval(timer);

  // Restore session state (may retroactively close a stale session), then
  // kick off the first compaction. The periodic timer is set up immediately
  // so the loop runs regardless of how long restore takes.
  void (async () => {
    try {
      await restoreSessionState(currentLlmConfig());
    } catch (err) {
      console.error("[compaction] Session restore failed:", err instanceof Error ? err.message : err);
    }
    await runCompaction();
  })();

  timer = setInterval(() => void runCompaction(), COMPACTION_INTERVAL_MS);
  console.log(`[compaction] Loop started (every ${COMPACTION_INTERVAL_MS / 1000}s)`);
}

export function updateCompactionBundle(bundle: RuntimeBundle): void {
  currentBundle = bundle;
}

export function stopCompaction(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log("[compaction] Loop stopped.");
  }
}

async function runCompaction(): Promise<void> {
  if (!currentBundle || !apiKey) return;

  const { settings } = currentBundle;

  // 1. Write episodes
  try {
    const episodesCreated = await writeEpisodes(settings, apiKey);
    if (episodesCreated > 0) {
      console.log(`[compaction] ${episodesCreated} episode(s) written.`);
    }
  } catch (err) {
    console.error("[compaction] Episode write failed:", err instanceof Error ? err.message : err);
  }

  // 2. Extract semantic notes
  try {
    const notes = await extractNotes(settings, apiKey);
    if (notes.created > 0 || notes.superseded > 0) {
      console.log(`[compaction] Notes: ${notes.created} created, ${notes.superseded} superseded, ${notes.skipped} skipped.`);
    }
  } catch (err) {
    console.error("[compaction] Note extraction failed:", err instanceof Error ? err.message : err);
  }

  // 3. Channel state sync
  if (currentBundle.botAccount) {
    try {
      await syncChannelState(
        currentBundle.broadcasterTwitchId,
        currentBundle.botAccount.accessToken,
        clientId,
        { provider: settings.aiProvider, model: settings.aiModel, apiKey },
      );
    } catch (err) {
      console.error("[compaction] Channel sync failed:", err instanceof Error ? err.message : err);
    }
  }

  // 3.5. Silence-gap fallback — close the open session if it's been idle
  // for SILENCE_GAP_HOURS AND Helix currently reports the channel offline.
  // The is_live gate is the primary protection: during a live stream the
  // session stays open no matter how quiet chat gets. The idle threshold
  // is a backstop for when Helix misses the true→false transition.
  try {
    const openId = getCurrentSessionId();
    if (openId != null) {
      const db = getDb();
      const row = db
        .prepare(`
          SELECT (julianday('now') - julianday(
                   COALESCE(
                     (SELECT MAX(occurred_at) FROM events WHERE occurred_at >= stream_sessions.started_at),
                     started_at
                   )
                 )) * 24.0 AS hours_idle,
                 (SELECT MAX(is_live) FROM channel_state) AS is_live
          FROM stream_sessions
          WHERE id = ?
        `)
        .get(openId) as { hours_idle: number; is_live: number | null } | undefined;
      if (row && row.is_live !== 1 && row.hours_idle > SILENCE_GAP_HOURS) {
        console.log(`[compaction] Session #${openId} idle ${row.hours_idle.toFixed(1)}h, channel offline — closing (silence-gap fallback)`);
        await flushCurrentSession(currentLlmConfig());
      }
    }
  } catch (err) {
    console.error("[compaction] Silence-gap check failed:", err instanceof Error ? err.message : err);
  }

  // 4. Prune old raw events
  try {
    const db = getDb();
    const pruned = db
      .prepare(`
        DELETE FROM events
        WHERE occurred_at < datetime('now', '-${EVENT_TTL_HOURS} hours')
      `)
      .run();
    if (pruned.changes > 0) {
      console.log(`[compaction] Pruned ${pruned.changes} old events.`);
    }
  } catch (err) {
    console.error("[compaction] Event pruning failed:", err instanceof Error ? err.message : err);
  }
}
