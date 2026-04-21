/**
 * Music chime gating — when (and how often) the bot is allowed to drop
 * its own !sr into chat.
 *
 * Two trigger paths, two cooldown clocks:
 *
 *   AUTONOMOUS chime — bot decides on its own to chime in. Gated hard:
 *     - 30 min minimum between bot autonomous chimes
 *     - 10% probability per check tick
 *     - Daily cap of 3 (resets at UTC midnight)
 *     - Requires ≥3 recent chat !sr requests to have any vibe signal
 *     The intent: feels rare, "oh interesting the bot just dropped a
 *     song", not "the bot is spamming the queue".
 *
 *   ASKED chime — viewer says "@bot play something chill". Less gated:
 *     - 5 min cooldown between asked chimes (so a single chatter
 *       can't loop the bot into queueing constantly)
 *     - Always fires when cooldown is satisfied
 *     - No per-tick probability and no daily cap
 *
 * State is in-memory only — restart resets cooldowns. Acceptable
 * trade-off: the bot won't accidentally double-chime through a
 * cooldown reset because the daily cap also resets and there's no
 * persistence layer here that needs to be schema'd. Memory loss on
 * restart costs at most one extra autonomous chime per day.
 */

import { getRecentSrCount } from "./sr-tracker.js";

// ── Tunables (defaults; toolkit knobs can override later if we add them) ──

const AUTONOMOUS_COOLDOWN_MS = 30 * 60 * 1000;
const AUTONOMOUS_PROBABILITY = 0.10; // per tick
const AUTONOMOUS_DAILY_CAP = 3;
const AUTONOMOUS_MIN_VIBE_REQUESTS = 3;
const AUTONOMOUS_VIBE_WINDOW_MS = 60 * 60 * 1000;

const ASKED_COOLDOWN_MS = 5 * 60 * 1000;

// ── Internal state ──

let lastAutonomousChimeAt = 0;
let autonomousChimesToday = 0;
let autonomousDayKey = ""; // YYYY-MM-DD UTC

let lastAskedChimeAt = 0;

// ── Public API ──

/**
 * Should the bot fire an autonomous chime right now? Caller is the
 * engine after each chat message goes through. Returns true at most
 * ~3 times per day (with default tunables) and only when there's
 * been recent !sr activity to read a vibe from.
 */
export function shouldAutonomousChime(): boolean {
  // Cooldown gate
  const sinceLast = Date.now() - lastAutonomousChimeAt;
  if (sinceLast < AUTONOMOUS_COOLDOWN_MS) return false;

  // Daily cap gate
  rollDailyCounterIfNeeded();
  if (autonomousChimesToday >= AUTONOMOUS_DAILY_CAP) return false;

  // Vibe-signal gate — need actual !sr activity to read
  if (getRecentSrCount(AUTONOMOUS_VIBE_WINDOW_MS) < AUTONOMOUS_MIN_VIBE_REQUESTS) {
    return false;
  }

  // Probability gate (last so we don't burn it when other gates would
  // have rejected anyway)
  if (Math.random() > AUTONOMOUS_PROBABILITY) return false;

  return true;
}

/**
 * Record that an autonomous chime just fired (whether the underlying
 * !sr send actually succeeded — we count the attempt to enforce
 * cooldown and cap regardless).
 */
export function recordAutonomousChime(): void {
  lastAutonomousChimeAt = Date.now();
  rollDailyCounterIfNeeded();
  autonomousChimesToday++;
}

/**
 * Should the bot answer a "@bot play something X" abstract music ask
 * right now? Less restrictive than autonomous — a viewer asked, so
 * we mostly say yes; just throttle to once per ~5 min so a single
 * chatter can't loop the bot.
 */
export function shouldAskedChime(): boolean {
  const sinceLast = Date.now() - lastAskedChimeAt;
  return sinceLast >= ASKED_COOLDOWN_MS;
}

export function recordAskedChime(): void {
  lastAskedChimeAt = Date.now();
}

// ── Helpers ──

function rollDailyCounterIfNeeded(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (autonomousDayKey !== today) {
    autonomousDayKey = today;
    autonomousChimesToday = 0;
  }
}
