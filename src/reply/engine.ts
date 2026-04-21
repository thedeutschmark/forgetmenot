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
import { assemblePrompt, detectTimeoutBait, detectDistress, detectAbstractMusicAsk, detectSpecificMusicAsk, type PromptMetrics } from "./budget.js";
import { trackChatMessage as trackSrChatMessage } from "../music/sr-tracker.js";
import { pickSongFromVibe } from "../music/picker.js";
import {
  shouldAutonomousChime, recordAutonomousChime,
  shouldAskedChime, recordAskedChime,
} from "../music/chime.js";
import { getRecentSrRequests } from "../music/sr-tracker.js";
import { applyPostGenFilters } from "./postprocess.js";
import { sendMessage, isConnected } from "../gateway/twitch.js";
import { parseReplyWithAction } from "../actions/proposals.js";
import { processAction } from "../actions/executor.js";
import { ACTION_CLASS } from "../actions/types.js";
import {
  getResearchProvider,
  parseResearchSentinel,
  pickResearchFallbackModel,
  pickResearchModel,
} from "../research/provider.js";
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

/**
 * Mentions get a fuller model than autonomous probabilistic replies.
 *
 * Reasoning (2026-04-20 user direction): direct @-mentions are user-
 * initiated asks where quality matters most and volume is bounded by
 * actual viewer demand. Probabilistic chime-ins fire on every Nth chat
 * line and need to stay cheap. Routing the two paths to different
 * models lets us spend tokens where the experience benefit is highest
 * without inflating cost on the high-volume path.
 *
 * Model choice:
 *   - mention   → gemini-2.5-flash (full, NOT -lite). More headroom
 *                 for instruction following, cleaner register, fewer
 *                 substrate / honorific / refusal leaks observed in
 *                 the user's own A/B testing.
 *   - non-mention (probabilistic) → settings.aiModel (the configured
 *                 default, normally gemini-2.5-flash-lite). Cheap
 *                 enough for autonomous chatter.
 *
 * Token budget:
 *   The default settings.maxReplyLength=250 is tuned for flash-lite's
 *   typically short outputs. Flash-full can produce slightly longer
 *   replies; we bump to max(600, settings.maxReplyLength * 2) on
 *   mentions to prevent finish_reason="length" truncation. The
 *   downstream validateReplyText still hard-caps the visible character
 *   count at min(500, maxReplyLength * 4) so chat never sees a wall of
 *   text — the bump is purely the model's generation budget, not the
 *   send-to-chat cap.
 */
const MENTION_MODEL = "gemini-2.5-flash";
function pickReplyModel(
  settings: { aiModel: string; maxReplyLength: number },
  isMention: boolean,
): { model: string; maxTokens: number } {
  if (isMention) {
    return {
      model: MENTION_MODEL,
      maxTokens: Math.max(600, settings.maxReplyLength * 2),
    };
  }
  return { model: settings.aiModel, maxTokens: settings.maxReplyLength };
}

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

  // Music: every chat message — including the bot's own !sr echo —
  // gets passed through the !sr tracker so the picker has a vibe
  // signal to read. Cheap, returns immediately when the message
  // doesn't start with !sr. Done before any policy/mention gating
  // so even messages from known-chat-bots' !sr broadcasts (rare)
  // can contribute, and so the bot's own emissions are recorded.
  trackSrChatMessage(login, message, currentBundle.botAccount?.login || settings.botName);

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

  // Music ask intercept — only on direct @-mention. Specific named-song
  // asks ("play X by Y") get a short redirect to !sr; abstract vibe asks
  // ("play something chill") get answered by the picker. Skipped for
  // non-mention chat so the bot doesn't step on viewer-to-viewer talk
  // where someone happens to say "play something chill" to a friend.
  if (isMention && config.mode === "live") {
    const musicHandled = await handleMusicAsk(login, message, settings.botName);
    if (musicHandled) {
      // Music ask consumed the turn — record it as a reply for cooldown
      // and rate-limit purposes, then fire the post-message autonomous
      // chime tick (it'll be cooldown-blocked because we just chimed,
      // but the tick is cheap and gating is centralized in chime.ts).
      recordReply(login);
      void maybeFireAutonomousChime();
      return;
    }
  }

  // Build context — stale filter uses memoryRetentionDays from settings so
  // notes that haven't been reconfirmed within the retention window drop
  // out of the retrieval set.
  const context = buildReplyContext(login, twitchId, 20, settings.memoryRetentionDays);

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
    // Route mentions to a fuller model (gemini-2.5-flash) with a bumped
    // maxTokens budget so we don't truncate. Probabilistic non-mention
    // replies stay on whatever's configured (typically flash-lite) for
    // cost. See pickReplyModel comment block for full reasoning.
    const reply = pickReplyModel(settings, isMention);
    console.log(`[reply] model=${reply.model} maxTokens=${reply.maxTokens} isMention=${isMention}`);
    let response = await chatCompletion(
      { provider: settings.aiProvider, model: reply.model, apiKey: config.apiKey },
      { messages, maxTokens: reply.maxTokens, temperature: 0.9 },
    );

    // TARS-mode research gate. Fires only when the operator enabled
    // thinkingAllowed AND the main model emitted the [RESEARCH:] sentinel.
    // One re-run with the reasoning model. We don't loop — if the reasoning
    // model also punts, that's a real gap and we fall through to fallback
    // handling like any other short reply.
    let researchFired = false;
    let researchSource = "none";
    if (settings.thinkingAllowed) {
      const sentinel = parseResearchSentinel(response.text);
      if (sentinel) {
        researchFired = true;
        const provider = getResearchProvider();
        const research = await provider.research(sentinel.query);
        researchSource = research.source;

        // Re-assert the date header inside the research note. The reasoning
        // model (gemini-2.5-pro) ignored the top-of-system timeAnchor on the
        // 2026-04-16 retest and deflected 2024 F1 / Oasis questions as
        // "future data" / "temporal spoiler". Putting the anchor ALSO at the
        // end of the prompt, right before generation, catches that bleed.
        const todayHeader = `TODAY: ${new Date().toISOString().slice(0, 10)}. 2024 and 2025 events are PAST — do NOT claim they "haven't happened" or "aren't over yet". If you don't know, say "I don't know" plainly.`;
        const researchNote = research.snippets.length > 0
          ? `${todayHeader}\n\nRESEARCH CONTEXT for "${sentinel.query}":\n${research.snippets.map((s) => `• ${s}`).join("\n")}\nUse this to answer naturally. Do not cite or mention that research happened.`
          : `${todayHeader}\n\nRESEARCH CONTEXT for "${sentinel.query}": no external data available — answer from your own knowledge, or say "I don't know" if you genuinely don't. Do not mention the gap or that research happened. Keep your voice (HARD RULES still apply).`;

        // Swap the system message to strip the RESEARCH MODE block (no
        // sentinel on the re-run) and keep HARD RULES + persona intact.
        // Append the research note as a second system turn so the model
        // sees it as instruction, not chat content.
        const reasoningMessages: LlmMessage[] = [
          ...messages,
          { role: "system", content: researchNote },
        ];

        const reasoningModel = pickResearchModel();
        console.log(`[reply] TARS re-run: model=${reasoningModel} source=${researchSource} query="${sentinel.query.slice(0, 80)}"`);

        // Try the primary reasoning model, then fall back to a lighter
        // model if it 503s or returns empty text. Pro is congested enough
        // that ~5-10% of re-runs 503 even after the adapter's retries;
        // Pro's hidden-thinking budget can also fully consume max_tokens
        // on borderline queries, yielding a zero-character visible reply.
        // A mediocre Flash answer beats a silent drop on either path.
        let reasoningResult: Awaited<ReturnType<typeof chatCompletion>> | null = null;
        let reasoningError: unknown = null;
        try {
          reasoningResult = await chatCompletion(
            { provider: settings.aiProvider, model: reasoningModel, apiKey: config.apiKey },
            // Reasoning models (gemini-2.5-pro) spend tokens on hidden
            // thinking before they produce the visible reply. If we only
            // allot ~500 they blow the whole budget on thinking and return
            // an empty message — which looks identical to a silent failure.
            // 4000 gives thinking ~3500 and a normal chat reply ~500.
            { messages: reasoningMessages, maxTokens: 4000, temperature: 0.8 },
          );
        } catch (err) {
          reasoningError = err;
        }

        const primaryEmpty = reasoningResult !== null && !reasoningResult.text.trim();
        if (reasoningError !== null || primaryEmpty) {
          const fallbackModel = pickResearchFallbackModel();
          const cause = reasoningError
            ? `error: ${reasoningError instanceof Error ? reasoningError.message.slice(0, 120) : String(reasoningError).slice(0, 120)}`
            : "empty_reply";
          console.log(`[reply] TARS fallback: ${fallbackModel} (${cause})`);
          researchSource = `${researchSource}+fallback`;
          reasoningResult = await chatCompletion(
            { provider: settings.aiProvider, model: fallbackModel, apiKey: config.apiKey },
            // Flash has no hidden thinking — normal budget is fine.
            { messages: reasoningMessages, maxTokens: settings.maxReplyLength, temperature: 0.8 },
          );
        }

        response = reasoningResult!;
      }
    }

    // Parse reply text and optional action proposal.
    // All deterministic post-generation filters are applied through
    // applyPostGenFilters so the eval runner and the live engine share
    // one code path — any filter that lives only in this function is
    // invisible to the eval harness and will regress silently.
    const parsed = applyPostGenFilters(
      parseReplyWithAction(response.text),
      {
        login,
        message,
        recentReplies: context.recentBotReplies ?? [],
        log: (m) => console.log(`[reply] ${m}`),
      },
    );

    // Bait fallback: if the viewer explicitly demanded a timeout AND fun
    // moderation is enabled AND the LLM produced reply text but didn't
    // include the action block, synthesize the proposal in code. The
    // prompt instructs the LLM to include it, but gemini frequently
    // ignores that and just verbally agrees ('Fine, you asked for it')
    // without the [ACTION:] tag. Without this fallback the bait sequence
    // dies at the LLM step every time.
    if (
      !parsed.proposal
      && detectTimeoutBait(message)
      && policy.funModerationEnabled
      && policy.funnyTimeoutEnabled
    ) {
      parsed.proposal = {
        action: "timeout_funny",
        target: login,
        targetId: twitchId,
        duration: 5,
        reason: "bait_accepted",
        confidence: 1,
      };
      console.log(`[reply] Synthesized timeout_funny proposal for ${login} (bait detected, LLM omitted action)`);
    }

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
        researchFired,
        researchSource,
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

  // Autonomous music chime tick — fired AFTER the normal reply flow so
  // the bot's chime can occasionally land in addition to whatever it
  // was already doing. Internally cooldown / probability / cap gated;
  // this call is cheap and almost always returns without firing.
  void maybeFireAutonomousChime();
}

/**
 * Music-ask handler. Called from onChatMessage when a direct @-mention
 * is detected and engineMode is live. Returns true if it consumed the
 * turn (sent a reply or redirect) so the caller can short-circuit the
 * normal LLM reply path.
 *
 *   SPECIFIC ask ("play X by Y"): bot redirects with a short canned
 *     "use !sr <song> <artist> yourself" line. Per 2026-04-21 user
 *     direction — bot doesn't queue specific named songs for users.
 *
 *   ABSTRACT ask ("play something chill"): bot calls pickSongFromVibe
 *     with the recent chat !sr buffer + the viewer's own message as
 *     hint. Sends `!sr <pick>` if the picker returned something. May
 *     also send a brief "got you" line so chat sees the bot acted.
 */
async function handleMusicAsk(
  login: string,
  message: string,
  botName: string,
): Promise<boolean> {
  if (!config) return false;

  // Specific ask → redirect (always; no cooldown)
  if (detectSpecificMusicAsk(message)) {
    const m = message.match(/\b(?:play|queue|put on|throw on|drop|add)\s+([\w\s'.,!?&-]{2,80})/i);
    const songHint = m ? m[1].trim().slice(0, 80) : "your song";
    const reply = `@${login} type \`!sr ${songHint}\` yourself — i don't queue specific named tracks for people.`;
    sendMessage(reply);
    console.log(`[music:redirect] ${login} asked for specific song; redirected to !sr`);
    return true;
  }

  // Abstract ask → pick from vibe
  if (detectAbstractMusicAsk(message)) {
    if (!shouldAskedChime()) {
      // Cooldown — bot recently chimed. Acknowledge briefly without queueing
      // so the user knows it heard them.
      sendMessage(`@${login} just queued one a sec ago — let it cook.`);
      console.log(`[music:asked-cooldown] ${login} asked but cooldown active`);
      return true;
    }
    const apiKey = config.apiKey;
    if (!apiKey) {
      console.warn("[music] No LLM API key — can't pick a song");
      return false; // fall through to normal reply path
    }
    recordAskedChime(); // record BEFORE the LLM call so concurrent asks don't double-fire
    const result = await pickSongFromVibe({
      recentRequests: getRecentSrRequests(60 * 60 * 1000, /*excludeBotEmissions*/ false),
      abstractAskHint: message,
      apiKey,
    });
    if (!result.query) {
      console.log(`[music:asked-pick-empty] picker returned no song (raw: "${result.raw.slice(0, 80)}")`);
      sendMessage(`@${login} blanking on a pick — try again in a bit.`);
      return true;
    }
    // Send the !sr line. Don't @-tag — !sr is a command, not a reply.
    sendMessage(`!sr ${result.query}`);
    console.log(`[music:asked-fire] picked "${result.query}" for ${login}`);
    return true;
  }

  // Not a music ask — let normal reply path handle it
  void botName; // botName is reserved for future use (e.g. "play yourself")
  return false;
}

/**
 * Autonomous chime — runs after every chat message. The shouldAutonomousChime
 * gate handles cooldown / probability / cap / vibe-signal gating, so this
 * call is cheap when it isn't going to fire (returns synchronously after
 * a few cheap checks). When it DOES fire, the LLM picker runs and the
 * !sr is sent without any addressed-to-viewer text.
 */
async function maybeFireAutonomousChime(): Promise<void> {
  if (!config || !currentBundle) return;
  if (config.mode !== "live") return; // never autonomously chime in shadow / mentions_only modes
  if (!shouldAutonomousChime()) return;

  const apiKey = config.apiKey;
  if (!apiKey) {
    console.warn("[music:auto] No LLM API key — skipping autonomous chime");
    return;
  }

  recordAutonomousChime(); // record before the call so a concurrent message can't double-fire
  const result = await pickSongFromVibe({
    recentRequests: getRecentSrRequests(60 * 60 * 1000, /*excludeBotEmissions*/ true),
    apiKey,
  });
  if (!result.query) {
    console.log(`[music:auto-pick-empty] autonomous chime picked nothing (raw: "${result.raw.slice(0, 80)}")`);
    return;
  }
  sendMessage(`!sr ${result.query}`);
  console.log(`[music:auto-fire] autonomous chime picked "${result.query}"`);
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
