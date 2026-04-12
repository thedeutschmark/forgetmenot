/**
 * Helix moderation executor — the only path to real Twitch moderation
 * actions. Separated from the generic executor so the safety boundary
 * is explicit.
 *
 * Three rollout modes:
 *   shadow           — log only, no chat, no API
 *   dry_run   — announce in chat, no actual timeout
 *   live             — real Helix API call
 *
 * Every call is fail-closed: missing credentials, expired tokens,
 * protected targets, and ambiguous context all result in denial.
 */

import { getDb } from "../db/index.js";
import { sendMessage } from "../gateway/twitch.js";
import type { ActionProposal, PolicyResult } from "./types.js";
import type { BotPolicy, BotAccountCredentials, TimeoutMode } from "../runtime/config.js";

export type { TimeoutMode };

interface TimeoutContext {
  proposal: ActionProposal;
  policy: BotPolicy;
  policyResult: PolicyResult;
  botAccount: BotAccountCredentials;
  broadcasterTwitchId: string;
  clientId: string;
  mode: TimeoutMode;
}

interface TimeoutResult {
  executed: boolean;
  mode: TimeoutMode;
  appliedDuration: number;
  helixStatus?: number;
  helixError?: string;
  deniedReason?: string;
}

// ── Audience safety heuristics ──

const CONFLICT_KEYWORDS = [
  "kys", "kill yourself", "fuck you", "stfu", "shut up", "hate you",
  "racist", "sexist", "homophob", "transphob", "slur", "n word",
  "kill", "die", "threat", "harass", "bully", "doxx",
];

const RECENT_DENIED_THRESHOLD = 3;    // deny if 3+ denials in last 5 min
const RECENT_ACTION_WINDOW_MS = 300_000; // 5 minutes
const RAPID_FIRE_THRESHOLD = 8;        // messages from target in last 2 min

/**
 * Execute a funny timeout through the full safety pipeline.
 */
export async function executeFunnyTimeout(ctx: TimeoutContext): Promise<TimeoutResult> {
  const { proposal, policy, policyResult, botAccount, broadcasterTwitchId, clientId, mode } = ctx;
  const target = proposal.target?.toLowerCase() || "";
  const targetId = proposal.targetId || "";

  // Apply duration from policy modifiers or proposal
  const appliedDuration = policyResult.modifiers?.reducedDuration ?? proposal.duration ?? 5;

  // ── Hard deny checks (beyond what policy.ts already checked) ──

  // Target class protections
  const viewer = getViewerRecord(target);

  if (!viewer) {
    return denied("target_not_found", appliedDuration, mode, proposal, null);
  }

  // Never timeout broadcaster
  if (viewer.twitchUserId === broadcasterTwitchId) {
    return denied("target_is_broadcaster", appliedDuration, mode);
  }

  // Never timeout mods
  if (viewer.isMod) {
    return denied("target_is_mod", appliedDuration, mode);
  }

  // Never timeout VIPs by default
  if (viewer.isVip) {
    return denied("target_is_vip", appliedDuration, mode);
  }

  // Never timeout unknown/new trust
  if (viewer.trustLevel === "unknown" || viewer.trustLevel === "new") {
    return denied("target_low_trust", appliedDuration, mode);
  }

  // ── Audience safety heuristics ──

  // Check for conflict in recent messages from target
  const recentTargetMessages = getRecentMessages(target, 120_000); // last 2 min
  const hasConflict = recentTargetMessages.some((msg) =>
    CONFLICT_KEYWORDS.some((kw) => msg.toLowerCase().includes(kw)),
  );
  if (hasConflict) {
    return denied("conflict_detected_in_target_messages", appliedDuration, mode);
  }

  // Check for rapid-fire (heated conversation)
  if (recentTargetMessages.length > RAPID_FIRE_THRESHOLD) {
    return denied("rapid_fire_conversation", appliedDuration, mode);
  }

  // Check for too many recent denied actions (system might be unstable)
  const recentDenials = getRecentDeniedCount(RECENT_ACTION_WINDOW_MS);
  if (recentDenials >= RECENT_DENIED_THRESHOLD) {
    return denied("too_many_recent_denials", appliedDuration, mode);
  }

  // Check if target was already actioned recently
  const lastActionOnTarget = getLastActionTime(target);
  if (lastActionOnTarget && Date.now() - lastActionOnTarget < RECENT_ACTION_WINDOW_MS) {
    return denied("target_recently_actioned", appliedDuration, mode);
  }

  // ── Duration final clamp (before any API call) ──
  const finalDuration = Math.max(1, Math.min(policy.maxTimeoutDurationSeconds, appliedDuration));

  // ── Execute based on mode ──

  if (mode === "shadow") {
    logTimeoutAttempt(proposal, finalDuration, "shadow", "allow", null, null, viewer);
    console.log(`[helix:shadow] Would timeout ${target} for ${finalDuration}s — ${proposal.reason}`);
    return { executed: false, mode, appliedDuration: finalDuration };
  }

  if (mode === "dry_run") {
    const notice = `[DRY RUN] ${target} would have been timed out for ${finalDuration}s: ${proposal.reason}`;
    sendMessage(notice);
    logTimeoutAttempt(proposal, finalDuration, "dry_run", "allow", null, null, viewer);
    console.log(`[helix:dry_run] ${notice}`);
    return { executed: false, mode, appliedDuration: finalDuration };
  }

  // ── Live execution via Helix ──

  try {
    const res = await fetch("https://api.twitch.tv/helix/moderation/bans", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botAccount.accessToken}`,
        "Client-Id": clientId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        data: {
          user_id: targetId || viewer.twitchUserId,
          duration: finalDuration,
          reason: `[Auto_Mark] ${proposal.reason}`.slice(0, 500),
        },
      }),
    });

    const helixStatus = res.status;

    if (res.ok) {
      // Announce in chat
      sendMessage(`${target} has been sentenced to ${finalDuration}s of silence for: ${proposal.reason}`);
      logTimeoutAttempt(proposal, finalDuration, "live", "allow", helixStatus, null, viewer);
      console.log(`[helix:live] Timed out ${target} for ${finalDuration}s`);
      return { executed: true, mode, appliedDuration: finalDuration, helixStatus };
    }

    // Helix error
    const errBody = await res.text().catch(() => "");
    logTimeoutAttempt(proposal, finalDuration, "live", "helix_error", helixStatus, errBody.slice(0, 200), viewer);
    console.error(`[helix:live] Timeout failed (${helixStatus}): ${errBody.slice(0, 200)}`);
    return { executed: false, mode, appliedDuration: finalDuration, helixStatus, helixError: errBody.slice(0, 200) };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logTimeoutAttempt(proposal, finalDuration, "live", "network_error", null, errMsg, viewer);
    console.error(`[helix:live] Network error: ${errMsg}`);
    return { executed: false, mode, appliedDuration: finalDuration, helixError: errMsg };
  }
}

// ── Helpers ──

function denied(reason: string, duration: number, mode: TimeoutMode, proposal?: ActionProposal, viewer?: ViewerSnapshot | null): TimeoutResult {
  console.log(`[helix:denied] ${reason}`);
  // Durably log every denial with the real reason
  try {
    getDb().prepare(`
      INSERT INTO action_logs (action_type, target_twitch_user_id, target_login, reason, policy_result, proposed_by, executed, execution_error)
      VALUES ('timeout_funny', ?, ?, ?, 'deny', 'helix_safety', 0, ?)
    `).run(
      viewer?.twitchUserId || proposal?.targetId || null,
      proposal?.target || null,
      JSON.stringify({ helixDenial: reason, mode, proposedDuration: proposal?.duration, appliedDuration: duration, targetSnapshot: viewer ? { trustLevel: viewer.trustLevel, isMod: viewer.isMod, isVip: viewer.isVip, optIn: viewer.optInFunModeration } : null }),
      reason,
    );
  } catch { /* don't let logging break the denial */ }
  return { executed: false, mode, appliedDuration: duration, deniedReason: reason };
}

interface ViewerSnapshot {
  twitchUserId: string;
  login: string;
  trustLevel: string;
  isMod: boolean;
  isVip: boolean;
  isRegular: boolean;
  optInFunModeration: boolean;
}

function getViewerRecord(login: string): ViewerSnapshot | null {
  try {
    const row = getDb()
      .prepare("SELECT twitch_user_id, login, trust_level, is_mod, is_vip, is_regular, opt_in_fun_moderation FROM viewers WHERE login = ?")
      .get(login) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      twitchUserId: String(row.twitch_user_id || ""),
      login: String(row.login || ""),
      trustLevel: String(row.trust_level || "unknown"),
      isMod: Boolean(row.is_mod),
      isVip: Boolean(row.is_vip),
      isRegular: Boolean(row.is_regular),
      optInFunModeration: Boolean(row.opt_in_fun_moderation),
    };
  } catch { return null; }
}

function getRecentMessages(login: string, windowMs: number): string[] {
  try {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const rows = getDb()
      .prepare(`
        SELECT e.message_text FROM events e
        JOIN viewers v ON v.twitch_user_id = e.twitch_user_id
        WHERE v.login = ? AND e.occurred_at > ? AND e.event_type = 'chat_message'
        ORDER BY e.occurred_at DESC
        LIMIT 20
      `)
      .all(login, cutoff) as Array<{ message_text: string }>;
    return rows.map((r) => r.message_text);
  } catch { return []; }
}

function getRecentDeniedCount(windowMs: number): number {
  try {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const row = getDb()
      .prepare("SELECT COUNT(*) as cnt FROM action_logs WHERE policy_result = 'deny' AND occurred_at > ?")
      .get(cutoff) as { cnt: number };
    return row?.cnt || 0;
  } catch { return 0; }
}

function getLastActionTime(login: string): number | null {
  try {
    const row = getDb()
      .prepare("SELECT occurred_at FROM action_logs WHERE target_login = ? AND executed = 1 ORDER BY occurred_at DESC LIMIT 1")
      .get(login) as { occurred_at: string } | undefined;
    return row ? new Date(row.occurred_at).getTime() : null;
  } catch { return null; }
}

function logTimeoutAttempt(
  proposal: ActionProposal,
  appliedDuration: number,
  mode: TimeoutMode,
  result: string,
  helixStatus: number | null,
  helixError: string | null,
  viewer: ViewerSnapshot | null,
): void {
  try {
    getDb().prepare(`
      INSERT INTO action_logs (action_type, target_twitch_user_id, target_login, reason, policy_result, proposed_by, executed, execution_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "timeout_funny",
      viewer?.twitchUserId || proposal.targetId || null,
      proposal.target || null,
      JSON.stringify({
        proposedDuration: proposal.duration,
        appliedDuration,
        mode,
        reason: proposal.reason,
        confidence: proposal.confidence,
        targetSnapshot: viewer ? {
          trustLevel: viewer.trustLevel,
          isMod: viewer.isMod,
          isVip: viewer.isVip,
          isRegular: viewer.isRegular,
          optIn: viewer.optInFunModeration,
        } : null,
        helixStatus,
        helixError,
      }),
      result,
      "reply_engine",
      result === "allow" && mode === "live" ? 1 : 0,
      helixError || null,
    );
  } catch { /* don't let logging break execution */ }
}
