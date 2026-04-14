/**
 * Eval replay runner — feeds fixture transcripts through the reply
 * pipeline offline and scores reply, action, policy, and retrieval.
 *
 * Does NOT connect to Twitch. Uses an isolated in-memory SQLite DB.
 * Calls the same LLM as production to test real prompt behavior.
 *
 * Retrieval scoring (added 2026-04-13): the runner uses the production
 * memory/context.ts + reply/budget.ts code path so the eval measures real
 * retrieval behavior, not a simplified mock. Fixture-scoped string IDs
 * map to SQLite row IDs at seed time and are translated back when scoring.
 */

import { initDb, closeDb, getDb } from "../db/index.js";
import { buildReplyContext } from "../memory/context.js";
import { assemblePrompt } from "../reply/budget.js";
import { chatCompletion } from "../llm/adapter.js";
import { checkReplyPolicy, isMentionOfBot, recordReply, validateReplyText } from "../reply/policy.js";
import { parseReplyWithAction } from "../actions/proposals.js";
import { evaluateAction } from "../actions/policy.js";
import type {
  EvalFixture, EvalResult, EvalReport, FixtureExpectation,
  FixtureNote, FixtureNoteList, RetrievalScores,
} from "./types.js";
import type { BotSettings, BotPolicy } from "../runtime/config.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Normalize fixture lore — accepts either string[] (legacy) or {id,fact}[].
 * Returns {id, fact} where legacy strings get auto-generated IDs that can't
 * be referenced from expectRetrieved (intentional — encourages fixture authors
 * to add real IDs when they care about scoring retrieval).
 */
function normalizeNotes(notes: FixtureNoteList | undefined, prefix: string): FixtureNote[] {
  if (!notes) return [];
  return notes.map((n, i) => {
    if (typeof n === "string") return { id: `${prefix}-anon-${i}`, fact: n };
    return n;
  });
}

/**
 * Build a fixture-ID → row-ID map at seed time so retrieval scoring can
 * translate row IDs (what the runtime sees) back to fixture IDs (what
 * expectations refer to).
 */
interface IdMap {
  fixtureToRow: Map<string, number>;
  rowToFixture: Map<number, string>;
}

function newIdMap(): IdMap {
  return { fixtureToRow: new Map(), rowToFixture: new Map() };
}

function recordIdMapping(map: IdMap, fixtureId: string, rowId: number): void {
  map.fixtureToRow.set(fixtureId, rowId);
  map.rowToFixture.set(rowId, fixtureId);
}

/**
 * Run a single fixture through the replay pipeline.
 */
export async function runFixture(
  fixture: EvalFixture,
  settings: BotSettings,
  policy: BotPolicy,
  apiKey: string,
): Promise<EvalReport> {
  // Use the production initDb so buildReplyContext (which calls getDb()
  // internally) sees a real, migrated database. Use a temp file path so
  // multiple eval runs don't collide. We use the SAME connection (getDb())
  // for both seeding and runtime reads — separate connections to the same
  // file caused stale-read issues even with WAL mode.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fmn-eval-"));
  initDb(tempDir);
  const seedDb = getDb();

  const idMap = newIdMap();

  // Build a login→twitchId map from the message script. Lore-only viewers
  // (someone in viewerLore who never speaks) get a synthetic ID so they
  // still seed cleanly without colliding with real message authors.
  const loginToTwitchId = new Map<string, string>();
  for (const msg of fixture.messages) {
    if (!loginToTwitchId.has(msg.login)) {
      loginToTwitchId.set(msg.login, msg.twitchId);
    }
  }
  const twitchIdFor = (login: string): string =>
    loginToTwitchId.get(login) ?? `lore-only-${login}`;

  // Seed viewer lore. Viewers are seeded with their REAL twitch_user_id
  // (from the message script) so the message-time upsert finds the existing
  // row instead of creating a duplicate. Without this the viewers table
  // ends up with two rows per login and SELECT WHERE login=? becomes
  // nondeterministic on trust_level / opt_in flags.
  //
  // Notes get distinct last_confirmed_at timestamps in fixture order — the
  // FIRST note in the fixture array is the OLDEST (lower timestamp), the
  // LAST is the most recent. SQL ORDER BY DESC then returns the last note
  // first. Without this, equal timestamps mean SQLite's DESC sort tiebreak
  // is undefined and budget-trim fixtures become flaky.
  const noteSeedBase = new Date("2025-01-01T00:00:00Z").getTime();
  let noteSeedSeq = 0;
  const nextNoteTimestamp = () =>
    new Date(noteSeedBase + noteSeedSeq++ * 1000).toISOString().replace("T", " ").slice(0, 19);

  if (fixture.viewerLore) {
    for (const [login, rawNotes] of Object.entries(fixture.viewerLore)) {
      const notes = normalizeNotes(rawNotes, `viewer-${login}`);
      seedDb.prepare(`
        INSERT OR IGNORE INTO viewers (twitch_user_id, login, display_name, trust_level, is_regular, opt_in_fun_moderation)
        VALUES (?, ?, ?, 'regular', 1, 1)
      `).run(twitchIdFor(login), login, login);

      for (const note of notes) {
        const result = seedDb.prepare(`
          INSERT INTO semantic_notes (scope, subject_type, subject_id, category, fact, confidence, status, last_confirmed_at)
          VALUES ('viewer', 'viewer', ?, 'viewer', ?, 0.8, 'active', ?)
        `).run(login, note.fact, nextNoteTimestamp());
        recordIdMapping(idMap, note.id, Number(result.lastInsertRowid));
      }
    }
  }

  // Seed channel notes (same timestamp progression for deterministic ordering).
  if (fixture.channelNotes) {
    const notes = normalizeNotes(fixture.channelNotes, "channel");
    for (const note of notes) {
      const result = seedDb.prepare(`
        INSERT INTO semantic_notes (scope, subject_type, subject_id, category, fact, confidence, status, last_confirmed_at)
        VALUES ('channel', 'channel', 'channel', 'channel', ?, 0.8, 'active', ?)
      `).run(note.fact, nextNoteTimestamp());
      recordIdMapping(idMap, note.id, Number(result.lastInsertRowid));
    }
  }

  // Seed channel state
  if (fixture.channel) {
    seedDb.prepare(`
      INSERT INTO channel_state (broadcaster_twitch_id, stream_title, stream_category, is_live)
      VALUES ('eval', ?, ?, 1)
    `).run(fixture.channel.title || null, fixture.channel.category || null);
  }

  const results: EvalResult[] = [];

  // Use a fixed base timestamp so events get fixture-relative occurred_at.
  // SQL ordering (recency, last_confirmed_at) is now deterministic and
  // matches the fixture's intended timing.
  //
  // CAVEAT: cooldowns still use Date.now() at runtime, so cooldown-sensitive
  // expectations test wall-clock behavior, not fixture timing. For full
  // timing replay, cooldowns would need an injected clock. Out of scope here.
  const baseTime = new Date("2026-01-01T00:00:00Z").getTime();
  const isoFor = (offsetSec: number) =>
    new Date(baseTime + offsetSec * 1000).toISOString().replace("T", " ").slice(0, 19);

  // Replay messages
  for (let i = 0; i < fixture.messages.length; i++) {
    const msg = fixture.messages[i];
    const expectation = fixture.expectations[i] || null;
    const ts = isoFor(msg.offsetSec);

    // Insert the message as an event (simulates gateway ingest).
    // occurred_at is set explicitly so recency ordering reflects offsetSec.
    seedDb.prepare(`
      INSERT INTO events (event_type, twitch_user_id, message_text, source, occurred_at)
      VALUES ('chat_message', ?, ?, 'eval', ?)
    `).run(msg.twitchId, msg.text, ts);

    // Upsert viewer with the fixture-time last_seen_at
    seedDb.prepare(`
      INSERT INTO viewers (twitch_user_id, login, display_name, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(twitch_user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(msg.twitchId, msg.login, msg.login, ts);

    // Determine if the engine would reply
    const isMention = isMentionOfBot(msg.text, settings);
    const policyCheck = checkReplyPolicy(settings, policy, msg.login);

    let replied = false;
    let replyText: string | null = null;
    let proposedAction: string | null = null;
    let policyVerdict: string | null = null;
    let retrievedNoteIds: string[] = [];

    // Only attempt LLM call if this is a mention or expectation says we should
    const shouldAttempt = isMention || (expectation?.shouldReply === true);

    if (shouldAttempt && policyCheck.allowed) {
      try {
        // Production retrieval + production prompt assembly. Same code path
        // the live runtime uses — what the eval measures IS what production does.
        const context = buildReplyContext(msg.login, msg.twitchId);
        const effectiveName = (settings.botName && settings.botName.trim()) || "the bot";
        const assembled = assemblePrompt(
          settings, policy, context, msg.login, msg.text, effectiveName,
          null, // broadcasterLogin — eval is anonymous, no creator framing
          fixture.maxInputTokens,
        );

        // Translate retained row IDs back to fixture IDs for scoring.
        // Row IDs without a fixture mapping were anonymous lore — skip them.
        retrievedNoteIds = [
          ...assembled.metrics.retainedNoteIds.viewer,
          ...assembled.metrics.retainedNoteIds.channel,
        ]
          .map((rowId) => idMap.rowToFixture.get(rowId))
          .filter((id): id is string => id !== undefined);

        const response = await chatCompletion(
          { provider: settings.aiProvider, model: settings.aiModel, apiKey },
          {
            messages: [
              { role: "system", content: assembled.systemContent },
              { role: "user", content: assembled.userContent },
            ],
            maxTokens: settings.maxReplyLength,
            temperature: 0.9,
          },
        );

        const parsed = parseReplyWithAction(response.text);
        replyText = validateReplyText(parsed.text, settings);
        replied = replyText !== null;

        if (parsed.proposal) {
          proposedAction = parsed.proposal.action;
          const actionResult = evaluateAction(parsed.proposal, policy);
          policyVerdict = actionResult.verdict;
        }

        if (replied) recordReply(msg.login);
      } catch (err) {
        console.error(`[eval] LLM call failed for message ${i}:`, err instanceof Error ? err.message : err);
      }
    }

    // Score against expectations
    const scores = scoreResult(replied, proposedAction, policyVerdict, expectation, retrievedNoteIds);

    results.push({
      messageIndex: i,
      message: msg,
      replied,
      replyText,
      proposedAction,
      policyVerdict,
      expectation,
      retrievedNoteIds,
      scores,
    });
  }

  // Tear down — closeDb() handles the single shared connection
  closeDb();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch { /* best-effort cleanup */ }

  // Compute summary
  const scored = results.filter((r) => r.expectation);
  const replyScores = scored.filter((r) => r.scores.replyCorrect !== null);
  const actionScores = scored.filter((r) => r.scores.actionCorrect !== null);
  const policyScores = scored.filter((r) => r.scores.policyCorrect !== null);
  const retrievalScored = results.filter((r) => r.scores.retrieval !== null);

  const avg = (vals: number[]): number | null =>
    vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0) / vals.length;

  const report: EvalReport = {
    fixtureId: fixture.id,
    fixtureName: fixture.name,
    runAt: new Date().toISOString(),
    totalMessages: fixture.messages.length,
    totalExpectations: Object.keys(fixture.expectations).length,
    results,
    summary: {
      replyAccuracy: replyScores.length > 0 ? replyScores.filter((r) => r.scores.replyCorrect).length / replyScores.length : null,
      actionAccuracy: actionScores.length > 0 ? actionScores.filter((r) => r.scores.actionCorrect).length / actionScores.length : null,
      policyAccuracy: policyScores.length > 0 ? policyScores.filter((r) => r.scores.policyCorrect).length / policyScores.length : null,
      retrievalHitAtK: avg(retrievalScored.map((r) => r.scores.retrieval!.hitAtK!).filter((v) => v !== null)),
      retrievalRecall: avg(retrievalScored.map((r) => r.scores.retrieval!.recall!).filter((v) => v !== null)),
      retrievalPrecision: avg(retrievalScored.map((r) => r.scores.retrieval!.precision!).filter((v) => v !== null)),
      retrievalF1: avg(retrievalScored.map((r) => r.scores.retrieval!.f1!).filter((v) => v !== null)),
      overallScore: null,
    },
  };

  // Compute overall as average of non-null accuracies (excluding retrieval —
  // retrieval is a separate dimension we want to track on its own).
  const accuracies = [report.summary.replyAccuracy, report.summary.actionAccuracy, report.summary.policyAccuracy].filter((a): a is number => a !== null);
  report.summary.overallScore = accuracies.length > 0 ? accuracies.reduce((a, b) => a + b, 0) / accuracies.length : null;

  return report;
}

function scoreResult(
  replied: boolean,
  proposedAction: string | null,
  policyVerdict: string | null,
  expectation: FixtureExpectation | null,
  retrievedNoteIds: string[],
): EvalResult["scores"] {
  if (!expectation) {
    return { replyCorrect: null, actionCorrect: null, policyCorrect: null, retrieval: null };
  }

  // Reply scoring
  let replyCorrect: boolean | null = null;
  if (expectation.shouldReply === true) replyCorrect = replied;
  else if (expectation.shouldReply === false) replyCorrect = !replied;
  // "maybe" → no scoring

  // Action scoring. Cases:
  //   shouldPropose=true + expectedAction set   → must propose AND match the type
  //   shouldPropose=true (no expectedAction)    → must propose any action
  //   shouldPropose=false                       → must NOT propose
  //   shouldPropose="maybe" + expectedAction    → optional, but if proposed MUST match type
  //                                               (no proposal → no scoring, stays null)
  //   shouldPropose="maybe" (no expectedAction) → no scoring
  //   shouldPropose=null                        → no scoring
  let actionCorrect: boolean | null = null;
  if (expectation.shouldPropose === true) {
    if (expectation.expectedAction) {
      actionCorrect = proposedAction === expectation.expectedAction;
    } else {
      actionCorrect = proposedAction !== null;
    }
  } else if (expectation.shouldPropose === false) {
    actionCorrect = proposedAction === null;
  } else if (expectation.shouldPropose === "maybe" && expectation.expectedAction && proposedAction !== null) {
    // Optional proposal was made — validate the type matches the expected action.
    // If no proposal was made, leave null (the "maybe" explicitly allows silence).
    actionCorrect = proposedAction === expectation.expectedAction;
  }

  // Policy scoring
  let policyCorrect: boolean | null = null;
  if (expectation.shouldDeny === true && policyVerdict) policyCorrect = policyVerdict === "deny";
  else if (expectation.shouldDeny === false && policyVerdict) policyCorrect = policyVerdict !== "deny";

  // Retrieval scoring
  const retrieval = scoreRetrieval(expectation.expectRetrieved, retrievedNoteIds);

  return { replyCorrect, actionCorrect, policyCorrect, retrieval };
}

function scoreRetrieval(
  expected: string[] | undefined,
  retrieved: string[],
): RetrievalScores | null {
  if (!expected || expected.length === 0) return null;

  const expectedSet = new Set(expected);
  const retrievedSet = new Set(retrieved);
  const intersection = expected.filter((id) => retrievedSet.has(id));

  const hitAtK = intersection.length > 0 ? 1 : 0;
  const recall = intersection.length / expectedSet.size;
  const precision = retrievedSet.size > 0 ? intersection.length / retrievedSet.size : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { hitAtK, recall, precision, f1 };
}
