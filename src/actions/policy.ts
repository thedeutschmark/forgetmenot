/**
 * Action policy evaluator — deterministic checks on every proposal.
 *
 * The LLM proposes. This module decides. No exceptions.
 *
 * Input: proposal + viewer context + channel policy + runtime state
 * Output: allow / deny / allow_with_modifiers / needs_manual
 */

import { getDb } from "../db/index.js";
import type { ActionProposal, PolicyResult, ActionType, ActionClass } from "./types.js";
import { ACTION_CLASS } from "./types.js";
import type { BotPolicy } from "../runtime/config.js";
import { isCoolingDown, setCooldown } from "../runtime/cooldowns.js";

export function evaluateAction(
  proposal: ActionProposal,
  policy: BotPolicy,
): PolicyResult {
  const actionClass = ACTION_CLASS[proposal.action];

  // ── Hard denies ──

  // Safe mode blocks everything
  if (policy.safeMode) {
    return deny("safe_mode_active");
  }

  // Class C actions are NEVER autonomous
  if (actionClass === "C") {
    return deny("class_c_never_autonomous");
  }

  // Class B requires fun moderation to be enabled
  if (actionClass === "B" && !policy.funModerationEnabled) {
    return deny("fun_moderation_disabled");
  }

  // Funny timeouts require the feature flag
  if (proposal.action === "timeout_funny" && !policy.funnyTimeoutEnabled) {
    return deny("funny_timeout_disabled");
  }

  // ── Target validation (for actions that have a target) ──

  if (proposal.target && actionClass === "B") {
    // Denylist check — always honored (these viewers must NEVER be targeted)
    if (policy.denylist.includes(proposal.target.toLowerCase())) {
      return deny("target_denylisted");
    }

    // Opt-in mode: strict — viewer must have opted in OR be allowlisted,
    // and must have a non-trivial trust history. The safe default for
    // streamers who don't want surprises.
    if (policy.optInRequired) {
      const viewer = getViewer(proposal.target);
      if (!viewer) {
        return deny("target_unknown");
      }
      if (!viewer.optInFunModeration && !policy.allowlist.includes(proposal.target.toLowerCase())) {
        return deny("target_not_opted_in");
      }
      if (viewer.trustLevel === "unknown" || viewer.trustLevel === "new") {
        return deny("target_low_trust");
      }
    }
    // Open-season mode (optInRequired=false): any viewer is fair game
    // except denylist. Per 2026-04-14 user direction — the previous
    // "must be regular or allowlisted" guard made the bot refuse every
    // timeout request from new viewers, even when they harassed it. The
    // streamer sets optInRequired=false explicitly; respect that choice.
  }

  // ── Duration validation (for timeouts) ──

  if (proposal.action === "timeout_funny") {
    const maxDuration = policy.maxTimeoutDurationSeconds;
    if (proposal.duration && proposal.duration > maxDuration) {
      return allowWithModifiers(
        "duration_reduced",
        { reducedDuration: maxDuration },
      );
    }
    if (!proposal.duration || proposal.duration <= 0) {
      return allowWithModifiers(
        "default_duration_applied",
        { reducedDuration: Math.min(5, maxDuration) },
      );
    }
  }

  // ── Cooldown checks ──

  if (proposal.target && actionClass === "B") {
    // Per-viewer cooldown (persisted)
    const viewerKey = `action:${proposal.action}:${proposal.target.toLowerCase()}`;
    if (isCoolingDown(viewerKey)) {
      return deny("per_viewer_cooldown");
    }

    // Global action cooldown (persisted)
    if (isCoolingDown("action:global")) {
      return deny("global_cooldown");
    }
  }

  // ── Class A actions pass through with minimal checks ──

  if (actionClass === "A") {
    return allow("class_a_allowed");
  }

  // ── Class B actions that passed all checks ──

  return allow("class_b_approved");
}

/**
 * Record that an action was executed (for cooldown tracking).
 */
export function recordActionExecution(action: ActionType, target?: string, policy?: BotPolicy): void {
  const globalMs = (policy?.globalCooldownMinutes ?? 5) * 60_000;
  const perViewerMs = (policy?.perViewerCooldownMinutes ?? 30) * 60_000;

  setCooldown("action:global", globalMs);
  if (target) {
    setCooldown(`action:${action}:${target.toLowerCase()}`, perViewerMs);
  }
}

// ── Helpers ──

function allow(reason: string): PolicyResult {
  return { verdict: "allow", reason };
}

function deny(reason: string): PolicyResult {
  return { verdict: "deny", reason };
}

function allowWithModifiers(reason: string, modifiers: PolicyResult["modifiers"]): PolicyResult {
  return { verdict: "allow_with_modifiers", reason, modifiers };
}

interface ViewerRecord {
  trustLevel: string;
  isRegular: boolean;
  isMod: boolean;
  isVip: boolean;
  optInFunModeration: boolean;
}

function getViewer(login: string): ViewerRecord | null {
  try {
    const row = getDb()
      .prepare("SELECT trust_level, is_regular, is_mod, is_vip, opt_in_fun_moderation FROM viewers WHERE login = ?")
      .get(login.toLowerCase()) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      trustLevel: String(row.trust_level || "unknown"),
      isRegular: Boolean(row.is_regular),
      isMod: Boolean(row.is_mod),
      isVip: Boolean(row.is_vip),
      optInFunModeration: Boolean(row.opt_in_fun_moderation),
    };
  } catch {
    return null;
  }
}
