/**
 * Action proposal extraction — parses structured action candidates
 * from LLM reply output.
 *
 * The LLM can include an optional ACTION block in its response:
 *
 *   [ACTION: timeout_funny target=willie duration=5 reason=bit_escalation]
 *
 * This module parses that block. If no ACTION block is present,
 * no action is proposed. The reply text is returned separately.
 */

import type { ActionProposal, ActionType, ACTION_CLASS } from "./types.js";

// Match ANY bracket that starts with `[ACTION:` and grab the rest of the
// bracket content lazily. We strip this bracket from visible reply text no
// matter what shape the LLM produced inside — function-call style
// (`warning_playful(message="...")`), space-separated (`target=x duration=5`),
// or mixed. Leaking a raw `[ACTION: ...]` tag into chat is worse than
// dropping an action proposal we couldn't parse.
const ACTION_REGEX = /\[ACTION:\s*([\s\S]*?)\]/i;
const ACTION_NAME_REGEX = /^\s*(\w+)/;
const PARAM_REGEX = /(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,\s)]+)/g;

const VALID_ACTIONS = new Set<ActionType>([
  "reply_extra", "clip_mark", "joke_flag", "scene_cue", "warning_playful",
  "timeout_funny", "emote_only_burst",
  "ban", "timeout_serious", "mod_action",
]);

export interface ParsedReply {
  text: string;           // clean reply text (ACTION block stripped)
  proposal: ActionProposal | null;
}

/**
 * Parse an LLM response into clean reply text + optional action proposal.
 */
export function parseReplyWithAction(rawText: string): ParsedReply {
  const match = ACTION_REGEX.exec(rawText);

  if (!match) {
    return { text: rawText.trim(), proposal: null };
  }

  // Strip ALL ACTION blocks from the reply text, regardless of whether we
  // can parse them below. The visible chat reply must never contain a raw
  // bracket tag — that's the actual user-facing failure.
  const text = rawText.replace(/\[ACTION:\s*[\s\S]*?\]/gi, "").trim();

  // Inner content may be function-call style (name(k=v, k="v")) or
  // space-separated (name k=v k=v). Pull the action name first, then hand
  // the rest to the generic key=value extractor.
  const inner = match[1];
  const nameMatch = ACTION_NAME_REGEX.exec(inner);
  if (!nameMatch) {
    return { text, proposal: null };
  }
  const actionStr = nameMatch[1].toLowerCase() as ActionType;
  if (!VALID_ACTIONS.has(actionStr)) {
    return { text, proposal: null };
  }

  // Parse parameters from the remaining content
  const paramsStr = inner.slice(nameMatch[0].length);
  const params: Record<string, string> = {};
  let paramMatch: RegExpExecArray | null;
  while ((paramMatch = PARAM_REGEX.exec(paramsStr)) !== null) {
    const key = paramMatch[1];
    let value = paramMatch[2];
    // Strip quotes
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"');
    }
    params[key] = value;
  }

  const proposal: ActionProposal = {
    action: actionStr,
    target: params.target || undefined,
    targetId: params.target_id || undefined,
    duration: params.duration ? parseInt(params.duration, 10) : undefined,
    reason: params.reason || "llm_proposed",
    confidence: params.confidence ? parseFloat(params.confidence) : 0.5,
    message: params.message || undefined,
  };

  return { text, proposal };
}

/**
 * Build a prompt suffix that teaches the LLM how to propose actions.
 * Only included when action engine is active.
 */
export function getActionPromptSuffix(enabledClasses: Set<string>): string {
  const actions: string[] = [];
  if (enabledClasses.has("A")) {
    actions.push("reply_extra(message=)", "clip_mark", "joke_flag", "warning_playful(message=)");
  }
  if (enabledClasses.has("B")) {
    actions.push("timeout_funny(target= duration= reason=)");
  }
  if (actions.length === 0) return "";
  return `Optional: append [ACTION: name key=val] at end of reply. Available: ${actions.join(", ")}. Omit if none fits — may be denied by policy.`;
}
