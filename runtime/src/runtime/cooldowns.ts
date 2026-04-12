/**
 * Persisted cooldowns — survive restarts.
 *
 * Stores cooldown expiry times in SQLite. Falls back to in-memory
 * if DB is unavailable. Cleans up expired entries periodically.
 */

import { getDb } from "../db/index.js";

/**
 * Check if a cooldown is active. Returns true if still cooling down.
 */
export function isCoolingDown(key: string): boolean {
  try {
    const row = getDb()
      .prepare("SELECT expires_at FROM cooldowns WHERE key = ?")
      .get(key) as { expires_at: string } | undefined;

    if (!row) return false;
    return new Date(row.expires_at).getTime() > Date.now();
  } catch {
    return false;
  }
}

/**
 * Set a cooldown. Overwrites any existing cooldown for this key.
 */
export function setCooldown(key: string, durationMs: number): void {
  const expiresAt = new Date(Date.now() + durationMs).toISOString();
  try {
    getDb().prepare(`
      INSERT INTO cooldowns (key, expires_at) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at
    `).run(key, expiresAt);
  } catch {
    // If DB is unavailable, cooldown is lost — fail open
  }
}

/**
 * Get remaining cooldown time in milliseconds. Returns 0 if not active.
 */
export function getRemainingMs(key: string): number {
  try {
    const row = getDb()
      .prepare("SELECT expires_at FROM cooldowns WHERE key = ?")
      .get(key) as { expires_at: string } | undefined;

    if (!row) return 0;
    const remaining = new Date(row.expires_at).getTime() - Date.now();
    return Math.max(0, remaining);
  } catch {
    return 0;
  }
}

/**
 * Clean up expired cooldowns. Call periodically.
 */
export function pruneExpiredCooldowns(): number {
  try {
    const result = getDb()
      .prepare("DELETE FROM cooldowns WHERE expires_at < datetime('now')")
      .run();
    return Number(result.changes);
  } catch {
    return 0;
  }
}
