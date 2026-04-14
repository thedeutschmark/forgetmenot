/**
 * Reply engine — decides whether to reply, builds prompt, calls LLM.
 *
 * Three modes:
 *   shadow        — full pipeline, writes to bot_messages, does NOT send.
 *   mentions_only — live, but only replies when bot name is mentioned.
 *   live          — full probabilistic replies.
 *
 * All blocked attempts are logged to action_logs for observability.
 * Cooldowns run in shadow mode too so cadence matches production.
 */

import { getDb } from "../db/index.js";
import { buildReplyContext, type ReplyContext } from "../memory/context.js";
import { chatCompletion, type LlmMessage } from "../llm/adapter.js";
import { checkReplyPolicy, isMentionOfBot, recordReply, validateReplyText } from "./policy.js";
import { assemblePrompt, type PromptMetrics } from "./budget.js";
import { sendMessage, isConnected } from "../gateway/twitch.js";
import { parseReplyWithAction } from "../actions/proposals.js";
import { processAction } from "../actions/executor.js";
import { ACTION_CLASS } from "../actions/types.js";
import type { BotSettings, RuntimeBundle } from "../runtime/config.js";
import crypto from "node:crypto";

export type EngineMode = "shadow" | "mentions_only" | "live";

export interface EngineConfig {
  mode: EngineMode;
  apiKey: string;
}

let config: EngineConfig | null = null;
let currentBundle: RuntimeBundle | null = null;

const BASE_REPLY_CHANCE: Record<string, number> = {
  low: 0.05,
  medium: 0.15,
  high: 0.35,
};

export function initEngine(engineConfig: EngineConfig, bundle: RuntimeBundle): void {
  config = engineConfig;
  currentBundle = bundle;
  console.log(`[reply] Engine initialized (mode: ${engineConfig.mode})`);
}

export function updateBundle(bundle: RuntimeBundle): void {
  currentBundle = bundle;
}

/** Get current engine mode (used by /health and /control endpoints). */
export function getEngineMode(): EngineMode | null {
  return config?.mode || null;
}

/** Set engine mode at runtime (used by /control/pause and /control/resume). */
export function setEngineMode(mode: EngineMode): void {
  if (!config) return;
  config.mode = mode;
  console.log(`[reply] Engine mode → ${mode}`);
}

// Pause state — when paused, mode is forced to "shadow" but previous mode is preserved.
let pausedFromMode: EngineMode | null = null;

export function isPaused(): boolean {
  return pausedFromMode !== null;
}

/** Returns the previous mode that was saved, or null if not paused. */
export function pause(): EngineMode | null {
  if (!config || pausedFromMode !== null) return pausedFromMode;
  pausedFromMode = config.mode;
  config.mode = "shadow";
  console.log(`[reply] Paused (was ${pausedFromMode})`);
  return pausedFromMode;
}

/** Returns the restored mode, or null if not paused. */
export function resume(): EngineMode | null {
  if (!config || pausedFromMode === null) return null;
  config.mode = pausedFromMode;
  const restored = pausedFromMode;
  pausedFromMode = null;
  console.log(`[reply] Resumed → ${restored}`);
  return restored;
}

/**
 * Called for every incoming chat message.
 */
export async function onChatMessage(
  login: string,
  twitchId: string,
  message: string,
): Promise<void> {
  if (!config || !currentBundle) return;
  const { settings, policy } = currentBundle;

  // Determine if this is a mention — checks botName plus any configured aliases
  const isMention = isMentionOfBot(message, settings);

  // Should we attempt a reply?
  if (!shouldAttemptReply(login, message, settings, config.mode, isMention)) return;

  // Policy check — mentions bypass cooldowns and the autonomous-replies gate
  const policyResult = checkReplyPolicy(settings, policy, login, isMention);
  if (!policyResult.allowed) {
    logBlockedAttempt(login, twitchId, "policy", policyResult.reason, isMention);
    return;
  }

  // Fail-closed: refuse to send if credentials are stale
  const bundleExpired = new Date(currentBundle.expiresAt).getTime() < Date.now();
  if (config.mode !== "shadow" && bundleExpired) {
    logBlockedAttempt(login, twitchId, "runtime", "bundle_expired", isMention);
    return;
  }

  // Fail-closed: refuse if Twitch is disconnected (live modes only)
  if (config.mode !== "shadow" && !isConnected()) {
    logBlockedAttempt(login, twitchId, "runtime", "twitch_disconnected", isMention);
    return;
  }

  // Build context
  const context = buildReplyContext(login, twitchId);

  // Build prompt (with token budget + prioritized drops)
  const { messages, metrics } = buildPrompt(settings, context, login, message);

  // One-line structured log per reply — evidence for future tuning.
  // Parseable later: estimated input tokens, stable prefix size, drops.
  console.log(
    `[llm] prompt est_in=${metrics.estimatedInputTokens} stable=${metrics.stablePrefixTokens}`
    + ` chat=${metrics.finalSectionCounts.recentChat}`
    + ` lore=${metrics.finalSectionCounts.viewerLore}`
    + ` notes=${metrics.finalSectionCounts.channelNotes}`
    + ` sessions=${metrics.finalSectionCounts.recentEpisodes}`
    + (metrics.sectionsDropped.length ? ` dropped=${metrics.sectionsDropped.join(",")}` : ""),
  );

  // Context fingerprint for debugging
  const contextHash = crypto
    .createHash("sha256")
    .update(messages.map((m) => m.content).join("||"))
    .digest("hex")
    .slice(0, 12);

  try {
    const response = await chatCompletion(
      { provider: settings.aiProvider, model: settings.aiModel, apiKey: config.apiKey },
      { messages, maxTokens: settings.maxReplyLength, temperature: 0.9 },
    );

    // Parse reply text and optional action proposal
    const parsed = parseReplyWithAction(response.text);
    const replyText = validateReplyText(parsed.text, settings, response.finishReason);

    if (!replyText) {
      const reason =
        response.finishReason === "length" ? "truncated_reply" : "empty_reply";
      logBlockedAttempt(login, twitchId, "validation", reason, isMention);
      return;
    }

    // Write to bot_messages (always). token_usage_json gets real provider
    // counts AND our estimate/drops so we can compare them later.
    const db = getDb();
    db.prepare(`
      INSERT INTO bot_messages (reply_text, trigger_type, viewer_target_id, model_name, token_usage_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      replyText,
      isMention ? "mention" : "probabilistic",
      twitchId,
      response.model,
      JSON.stringify({
        ...(response.tokensUsed || {}),
        estInput: metrics.estimatedInputTokens,
        stablePrefix: metrics.stablePrefixTokens,
        sectionsDropped: metrics.sectionsDropped,
        finalCounts: metrics.finalSectionCounts,
        // Real SQLite row IDs the LLM actually saw — for cross-referencing
        // production replies against the eval baseline.
        retainedNoteIds: metrics.retainedNoteIds,
        contextHash,
        mode: config.mode,
        hasAction: parsed.proposal !== null,
      }),
    );

    // Record cooldown in ALL modes
    recordReply(login);

    // When the bot is answering a specific viewer, prepend @login so the
    // reply is visibly addressed. Skip if the LLM already @-tagged someone,
    // or if this is a /me action message — /me renders as "auto_mark ..."
    // so an @ prefix would land inside the narration text awkwardly.
    const isMeAction = /^\s*\/me\s/.test(replyText);
    const alreadyTagged = /^\s*@/.test(replyText);
    const prefixed = isMeAction || alreadyTagged
      ? replyText
      : `@${login} ${replyText}`;

    // Send the reply
    if (config.mode === "shadow") {
      console.log(`[reply:shadow] → ${login}: ${prefixed}`);
    } else {
      sendMessage(prefixed);
      console.log(`[reply:${config.mode}] → ${login}: ${prefixed}`);
    }

    // Process action proposal (if any)
    if (parsed.proposal && currentBundle) {
      const isShadow = config.mode === "shadow";
      processAction(parsed.proposal, currentBundle.policy, isShadow);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[reply] LLM call failed:", errMsg);
    logBlockedAttempt(login, twitchId, "llm_error", errMsg.slice(0, 200), isMention);
  }
}

function shouldAttemptReply(
  login: string,
  message: string,
  settings: BotSettings,
  mode: EngineMode,
  isMention: boolean,
): boolean {
  // Always reply to mentions
  if (isMention) return true;

  // mentions_only mode: only reply to mentions
  if (mode === "mentions_only") return false;

  // Skip commands
  if (message.startsWith("!")) return false;

  // Skip probabilistic replies on messages with too little signal. Without
  // this, an emoji-only message like "🐊" can trigger a probabilistic
  // reply, and the LLM — having no actual content to react to — falls back
  // to riffing on whatever was in the prior chat thread, producing
  // nonsensical replies addressed to someone who said nothing meaningful.
  // Heuristics:
  //   - Strip emoji/punctuation/whitespace, count remaining alpha chars
  //   - Require >= 8 chars OR >= 2 distinct words
  const stripped = message.replace(/[\p{Emoji}\p{Punctuation}\s]+/gu, "");
  const wordCount = message.trim().split(/\s+/).filter((w) => w.length > 1).length;
  if (stripped.length < 8 && wordCount < 2) return false;

  // Probabilistic reply
  const chance = BASE_REPLY_CHANCE[settings.replyFrequency] ?? 0.1;
  return Math.random() < chance;
}

function logBlockedAttempt(
  login: string,
  twitchId: string,
  blockType: string,
  reason: string,
  wasMention: boolean,
): void {
  try {
    getDb().prepare(`
      INSERT INTO action_logs (action_type, target_twitch_user_id, target_login, reason, policy_result, proposed_by, executed)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `).run(
      wasMention ? "reply_mention_blocked" : "reply_blocked",
      twitchId,
      login,
      `${blockType}: ${reason}`,
      "deny",
      "reply_engine",
    );
  } catch { /* don't let logging failures break the reply pipeline */ }
}

function buildPrompt(
  settings: BotSettings,
  context: ReplyContext,
  targetLogin: string,
  currentMessage: string,
): { messages: LlmMessage[]; metrics: PromptMetrics } {
  // {{botName}} in the persona is substituted at prompt time so changes to
  // the bot's connected Twitch account flow through automatically.
  const effectiveName = (settings.botName && settings.botName.trim()) || "the bot";

  // Policy is required for the action schema — fall back to empty if bundle
  // hasn't loaded yet (first tick) to keep the prompt assemblable.
  const policy = currentBundle?.policy ?? {
    autonomousRepliesEnabled: false, funModerationEnabled: false, funnyTimeoutEnabled: false,
    maxTimeoutDurationSeconds: 0, perViewerCooldownMinutes: 0, globalCooldownMinutes: 0,
    optInRequired: true, allowlist: [], denylist: [], sensitiveTopics: [], safeMode: true,
  };

  const assembled = assemblePrompt(
    settings, policy, context, targetLogin, currentMessage, effectiveName,
    currentBundle?.broadcasterLogin ?? null,
  );

  return {
    messages: [
      { role: "system", content: assembled.systemContent },
      { role: "user", content: assembled.userContent },
    ],
    metrics: assembled.metrics,
  };
}
