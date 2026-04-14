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

// Defense-in-depth: naked action leaks WITHOUT the [ACTION: ] wrapper.
// Seen in live output: LLM emits `reply_extra message="..."` on its own at
// the tail of a reply. The primary ACTION_REGEX doesn't match that, so the
// leak lands in chat. This pattern catches any known action name followed
// by `(`, `key=value`, or trailing params — anywhere in the text — and is
// used to scrub the visible reply as a second pass.
const NAKED_ACTION_REGEX = new RegExp(
  `(?:^|\\s|[.!?,;])\\s*(?:${Array.from(VALID_ACTIONS).join("|")})\\b\\s*(?:\\([^)]*\\)|(?:\\w+\\s*=\\s*(?:"[^"]*"|\\S+)\\s*)+)`,
  "gi",
);

export interface ParsedReply {
  text: string;           // clean reply text (ACTION block stripped)
  proposal: ActionProposal | null;
}

/**
 * Strip naked action leaks from visible reply text. Catches the case where
 * the LLM emits `reply_extra(message="...")` or `warning_playful target=x`
 * with no [ACTION: ...] wrapper at all — common when the model treats the
 * action grammar as inline tool-call syntax. Safe to call unconditionally.
 */
export function stripNakedActionLeaks(text: string): string {
  return text.replace(NAKED_ACTION_REGEX, " ").replace(/\s{2,}/g, " ").trim();
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
  const hasA = enabledClasses.has("A");
  const hasB = enabledClasses.has("B");
  if (!hasA && !hasB) return "";

  const lines: string[] = [];
  lines.push(
    "Formatting: Twitch chat is plain text. No markdown renders — no **bold**, no *italics*, no _underscores_. Don't use them; they get stripped. For a narrated action (tilting head, smirking, reacting physically), you MAY start the entire line with `/me `, which renders as italic attributed to you. Use /me RARELY — at most once every 10-20 replies, and only when the action is genuinely funny or adds something no regular reply could. Overusing /me makes it stale fast. Default to normal replies.",
  );
  lines.push(
    "Actions (optional): you may append ONE action block on a new line after your reply, in the form [ACTION: name key=value key=value]. Never mention the action block in your prose — chat only sees the prose, the action is processed separately.",
  );

  if (hasA) {
    lines.push(
      "- reply_extra key=message=\"<extra line>\" — queue a second follow-up line",
      "- clip_mark — mark the current moment as clip-worthy",
      "- joke_flag — log that this was a bit",
      "- warning_playful message=\"<warning>\" — in-character warning, no enforcement",
    );
  }

  if (hasB) {
    lines.push(
      "- timeout_funny target=<login> duration=<seconds 3-30> reason=<short_tag> — short joke timeout. USE IT when a viewer:",
      "  · dares or eggs you on (\"bet you won't time me out\", \"do it coward\", \"timeout me\")",
      "  · spams repeatedly after being warned",
      "  · directly challenges your authority in-character",
      "  Be willing to actually use it on bait — refusing breaks the bit. Keep duration short (5-10s). reason is a short tag like \"bait_accepted\" or \"spam_escalation\", not a sentence.",
    );
  }

  lines.push(
    "Omit the block entirely if no action fits. Low-confidence proposals get denied by policy — that's fine, better to try than stay silent on clear bait.",
  );

  return lines.join("\n");
}
