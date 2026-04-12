/**
 * Action type system.
 *
 * Actions are structured proposals from the LLM that pass through
 * a deterministic policy evaluator before execution.
 *
 * The LLM NEVER executes actions directly. It outputs a candidate.
 * The policy engine decides. The executor performs. The logger records.
 *
 * Action classes:
 *   A — Free autonomous (reply extras, clip marks, joke flags)
 *   B — Guarded autonomous (funny timeouts, playful warnings)
 *   C — Never autonomous (bans, serious moderation)
 */

export type ActionClass = "A" | "B" | "C";

export type ActionType =
  // Class A — free autonomous
  | "reply_extra"       // additional chat message (lore callback, joke)
  | "clip_mark"         // flag a moment for clipping
  | "joke_flag"         // tag something as a running joke for memory
  | "scene_cue"         // suggest a scene/overlay change
  | "warning_playful"   // playful "watch it" message (no enforcement)
  // Class B — guarded autonomous
  | "timeout_funny"     // short joke timeout (opt-in only)
  | "emote_only_burst"  // brief emote-only mode
  // Class C — never autonomous
  | "ban"
  | "timeout_serious"
  | "mod_action";

export const ACTION_CLASS: Record<ActionType, ActionClass> = {
  reply_extra: "A",
  clip_mark: "A",
  joke_flag: "A",
  scene_cue: "A",
  warning_playful: "A",
  timeout_funny: "B",
  emote_only_burst: "B",
  ban: "C",
  timeout_serious: "C",
  mod_action: "C",
};

export interface ActionProposal {
  action: ActionType;
  target?: string;      // viewer login (if applicable)
  targetId?: string;     // twitch user ID
  duration?: number;     // seconds (for timeouts)
  reason: string;        // why the LLM proposed this
  confidence: number;    // 0-1
  message?: string;      // text to send (for reply_extra, warning_playful)
}

export type PolicyVerdict = "allow" | "deny" | "allow_with_modifiers" | "needs_manual";

export interface PolicyResult {
  verdict: PolicyVerdict;
  reason: string;
  modifiers?: {
    reducedDuration?: number;
    convertTo?: ActionType;
    suppressExecution?: boolean;
  };
}

export interface ActionLogEntry {
  action: ActionType;
  target?: string;
  targetId?: string;
  reason: string;
  policyResult: PolicyVerdict;
  policyReason: string;
  proposedBy: string;
  executed: boolean;
  executionError?: string;
}
