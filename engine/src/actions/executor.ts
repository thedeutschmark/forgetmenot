/**
 * Action executor — performs approved actions and logs everything.
 *
 * Phase 5A: only executes Class A actions (harmless).
 * Phase 5B: adds Helix-based timeout execution for Class B.
 *
 * Every action attempt (approved or denied) is written to action_logs.
 */

import { getDb } from "../db/index.js";
import { sendMessage } from "../gateway/twitch.js";
import { evaluateAction, recordActionExecution } from "./policy.js";
import { executeFunnyTimeout, type TimeoutMode } from "./helix.js";
import type { ActionProposal, PolicyResult, ActionLogEntry } from "./types.js";
import type { BotPolicy, BotAccountCredentials } from "../runtime/config.js";

export interface ExecutionResult {
  executed: boolean;
  policyResult: PolicyResult;
  error?: string;
}

export interface RuntimeContext {
  botAccount: BotAccountCredentials | null;
  broadcasterTwitchId: string;
  clientId: string;
  timeoutMode: TimeoutMode;
}

let _runtimeCtx: RuntimeContext | null = null;

export function setRuntimeContext(ctx: RuntimeContext): void {
  _runtimeCtx = ctx;
}

/**
 * Process an action proposal through the full pipeline:
 * evaluate → execute (if approved) → log.
 *
 * shadowMode: log everything, execute nothing.
 *
 * IMPORTANT: this is async because timeout execution must be
 * awaited — we only record cooldowns/execution after the Helix
 * call actually succeeds.
 */
export async function processAction(
  proposal: ActionProposal,
  policy: BotPolicy,
  shadowMode: boolean,
): Promise<ExecutionResult> {
  // 1. Policy evaluation
  const policyResult = evaluateAction(proposal, policy);

  // 2. Execute (if approved and not shadow)
  let executed = false;
  let executionError: string | undefined;

  if (policyResult.verdict === "allow" || policyResult.verdict === "allow_with_modifiers") {
    if (shadowMode) {
      console.log(`[action:shadow] ${proposal.action} → ${proposal.target || "channel"} (${policyResult.reason})`);
    } else {
      try {
        const result = await executeAction(proposal, policyResult, policy);
        executed = result.executed;
        executionError = result.error;
        // Only record cooldowns after confirmed execution
        if (executed) {
          recordActionExecution(proposal.action, proposal.target, policy);
        }
      } catch (err) {
        executionError = err instanceof Error ? err.message : String(err);
        console.error(`[action] Execution failed: ${executionError}`);
      }
    }
  } else {
    if (shadowMode) {
      console.log(`[action:shadow:denied] ${proposal.action} → ${proposal.target || "channel"} (${policyResult.reason})`);
    }
  }

  // 3. Log — skip for timeout_funny when it reached helix.ts (which owns
  // its own logging). Only log here for policy-denied timeouts that never
  // reached the Helix executor.
  const helixOwnsLog = proposal.action === "timeout_funny" &&
    (policyResult.verdict === "allow" || policyResult.verdict === "allow_with_modifiers");

  if (!helixOwnsLog) {
    logAction({
      action: proposal.action,
      target: proposal.target,
      targetId: proposal.targetId,
      reason: proposal.reason,
      policyResult: policyResult.verdict,
      policyReason: policyResult.reason,
      proposedBy: "llm",
      executed,
      executionError,
    });
  }

  return { executed, policyResult, error: executionError };
}

async function executeAction(proposal: ActionProposal, policyResult: PolicyResult, policyForAction?: BotPolicy): Promise<{ executed: boolean; error?: string }> {
  switch (proposal.action) {
    // ── Class A — harmless ──
    case "reply_extra":
      if (proposal.message) sendMessage(proposal.message);
      break;

    case "warning_playful":
      if (proposal.message) sendMessage(proposal.message);
      break;

    case "clip_mark":
      // Log for now — could hook into OBS or a clip service later
      console.log(`[action] Clip marked: ${proposal.reason}`);
      break;

    case "joke_flag":
      // Write to semantic_notes as a running_joke
      try {
        getDb().prepare(`
          INSERT INTO semantic_notes (scope, subject_type, subject_id, category, fact, confidence, status)
          VALUES ('running_joke', 'channel', ?, 'running_joke', ?, 0.6, 'active')
        `).run(
          proposal.target || "channel",
          proposal.reason,
        );
      } catch { /* don't fail the action on note write failure */ }
      break;

    case "scene_cue":
      // Log for now — could hook into OBS websocket later
      console.log(`[action] Scene cue: ${proposal.reason}`);
      break;

    // ── Class B — guarded (Phase 5B) ──
    case "timeout_funny": {
      if (!_runtimeCtx?.botAccount) {
        console.warn("[action] No bot account — cannot execute timeout");
        return { executed: false, error: "no_bot_account" };
      }
      // Delegate to Helix executor — AWAITED, not fire-and-forget
      const timeoutResult = await executeFunnyTimeout({
        proposal,
        policy: policyForAction!,
        policyResult,
        botAccount: _runtimeCtx.botAccount,
        broadcasterTwitchId: _runtimeCtx.broadcasterTwitchId,
        clientId: _runtimeCtx.clientId,
        mode: _runtimeCtx.timeoutMode,
      });
      return {
        executed: timeoutResult.executed,
        error: timeoutResult.deniedReason || timeoutResult.helixError,
      };
    }

    // Class C and unhandled — should never reach here (policy denies)
    default:
      console.warn(`[action] Unhandled action type: ${proposal.action}`);
      return { executed: false, error: "unhandled_action_type" };
  }

  return { executed: true };
}

function logAction(entry: ActionLogEntry): void {
  try {
    getDb().prepare(`
      INSERT INTO action_logs (action_type, target_twitch_user_id, target_login, reason, policy_result, proposed_by, executed, execution_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.action,
      entry.targetId || null,
      entry.target || null,
      `${entry.reason} | policy: ${entry.policyReason}`,
      entry.policyResult,
      entry.proposedBy,
      entry.executed ? 1 : 0,
      entry.executionError || null,
    );
  } catch { /* don't let log failures break the pipeline */ }
}
