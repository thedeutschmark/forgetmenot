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
import { syncChannelState } from "./channel.js";
import { getDb } from "../db/index.js";
import type { RuntimeBundle } from "../runtime/config.js";

const COMPACTION_INTERVAL_MS = 180_000; // 3 minutes
const EVENT_TTL_HOURS = 24; // prune raw events older than this

let timer: ReturnType<typeof setInterval> | null = null;
let currentBundle: RuntimeBundle | null = null;
let apiKey: string = "";
let clientId: string = "";

export function startCompaction(
  bundle: RuntimeBundle,
  llmApiKey: string,
  twitchClientId: string,
): void {
  currentBundle = bundle;
  apiKey = llmApiKey;
  clientId = twitchClientId;

  if (timer) clearInterval(timer);

  // Run immediately on start
  void runCompaction();

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
      );
    } catch (err) {
      console.error("[compaction] Channel sync failed:", err instanceof Error ? err.message : err);
    }
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
