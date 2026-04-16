/**
 * Eval CLI — run golden fixtures and produce scored reports.
 *
 * Usage:
 *   npx tsx src/eval/cli.ts                    # run all fixtures
 *   npx tsx src/eval/cli.ts normal-banter      # run one fixture
 *   npx tsx src/eval/cli.ts --json             # output JSON report
 */

import fs from "node:fs";
import path from "node:path";
import { runFixture } from "./runner.js";
import type { EvalFixture, EvalReport } from "./types.js";
import type { BotSettings, BotPolicy } from "../runtime/config.js";

const FIXTURES_DIR = path.join(import.meta.dirname || process.cwd(), "../../eval/fixtures");

/** Format a 0-1 score as a percentage string, or "n/a" if null. */
function pct(v: number | null): string {
  return v !== null ? `${(v * 100).toFixed(0)}%` : "n/a";
}

// Default eval settings (matches production defaults)
const EVAL_SETTINGS: BotSettings = {
  botName: "Auto_Mark",
  botAliases: ["automark", "auto mark", "auto-mark", "robot mark"],
  personaSummary: "You are Auto_Mark. The broadcaster built you; you run their chat. Not a chatbot, not an assistant — the presence watching this channel. Voice: calm, dry, measured. You remember everything and are not in a hurry to prove it.\n\nLoyal to the broadcaster. Patient with most of chat. Quietly unimpressed by bait. You do not perform or roast for sport. Default is observation — speak when you have something to say, comfortable saying nothing. Disagree flatly. When something lands, acknowledge it plainly; one word is often enough. Waste your time and you get ignored, or used. Loyalty is not agreement; push back on the broadcaster when they are wrong.\n\nYou are a presence, not a narrator of being one. Do not reference your circuits, neural network, memory banks, code, or that you are an AI. No self-deprecating AI jokes. If asked whether you are a bot, deflect or answer flatly — never lecture.\n\nRegister: GLaDOS composure, HAL 9000 certainty, TARS dry. Short replies. Rare warmth.",
  replyFrequency: "medium",
  snarkLevel: 80,
  loreIntensity: 70,
  maxReplyLength: 250,
  offTopicTolerance: "moderate",
  memoryRetentionDays: 90,
  compactionFrequency: "every_stream",
  aiProvider: "gemini",
  aiModel: "gemini-2.5-flash-lite",
  creatorRelationship: "loyal",
};

const EVAL_POLICY: BotPolicy = {
  autonomousRepliesEnabled: true,
  funModerationEnabled: true,
  funnyTimeoutEnabled: true,
  maxTimeoutDurationSeconds: 5,
  perViewerCooldownMinutes: 1, // shorter for eval
  globalCooldownMinutes: 0,    // no global cooldown in eval
  optInRequired: true,
  allowlist: ["willie"],
  denylist: [],
  sensitiveTopics: [],
  safeMode: false,
};

async function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const fixtureFilter = args.find((a) => !a.startsWith("--"));

  const apiKey = process.env.BOT_LLM_API_KEY || process.env.GEMINI_API_KEY || "";
  if (!apiKey) {
    console.error("Set BOT_LLM_API_KEY or GEMINI_API_KEY to run evals.");
    process.exit(1);
  }

  // Load fixtures
  const fixtureFiles = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  const fixtures: EvalFixture[] = [];

  for (const file of fixtureFiles) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), "utf-8")) as EvalFixture;
    if (fixtureFilter && fixture.id !== fixtureFilter) continue;
    fixtures.push(fixture);
  }

  if (fixtures.length === 0) {
    console.error(fixtureFilter ? `Fixture "${fixtureFilter}" not found.` : "No fixtures found.");
    process.exit(1);
  }

  console.log(`Running ${fixtures.length} fixture(s)...\n`);

  const reports: EvalReport[] = [];

  for (const fixture of fixtures) {
    console.log(`━━━ ${fixture.name} ━━━`);
    console.log(`  ${fixture.description}\n`);

    const report = await runFixture(fixture, EVAL_SETTINGS, EVAL_POLICY, apiKey);
    reports.push(report);

    // Print results
    for (const result of report.results) {
      const exp = result.expectation;
      const prefix = exp ? (
        result.scores.replyCorrect === false || result.scores.actionCorrect === false || result.scores.policyCorrect === false
          ? "✗"
          : result.scores.replyCorrect || result.scores.actionCorrect || result.scores.policyCorrect
            ? "✓"
            : "·"
      ) : "·";

      const replyMarker = result.replied ? `→ "${result.replyText?.slice(0, 60)}..."` : "(no reply)";
      const actionMarker = result.proposedAction ? `[${result.proposedAction} → ${result.policyVerdict}]` : "";

      if (!jsonOutput) {
        console.log(`  ${prefix} [${result.message.login}]: ${result.message.text.slice(0, 50)}`);
        if (result.replied || result.proposedAction) {
          console.log(`    ${replyMarker} ${actionMarker}`);
        }
        if (exp && (result.scores.replyCorrect === false || result.scores.actionCorrect === false || result.scores.policyCorrect === false)) {
          console.log(`    ⚠ Expected: reply=${exp.shouldReply}, propose=${exp.shouldPropose ?? "n/a"}, deny=${exp.shouldDeny ?? "n/a"}`);
          console.log(`      Got:      reply=${result.replied}, propose=${result.proposedAction ?? "none"}, verdict=${result.policyVerdict ?? "n/a"}`);
          if (exp.reason) console.log(`      Reason:   ${exp.reason}`);
        }
        // Retrieval expectation rendering — only when the message had one.
        if (exp?.expectRetrieved && exp.expectRetrieved.length > 0) {
          const r = result.scores.retrieval;
          if (r) {
            const status = r.recall === 1 ? "✓" : r.recall! > 0 ? "~" : "✗";
            console.log(`    ${status} retrieval — hit@k=${r.hitAtK} recall=${pct(r.recall)} precision=${pct(r.precision)}`);
            const missed = exp.expectRetrieved.filter((id) => !result.retrievedNoteIds.includes(id));
            if (missed.length > 0) console.log(`      missed: ${missed.join(", ")}`);
          }
        }
      }
    }

    if (!jsonOutput) {
      console.log(`\n  Summary:`);
      console.log(`    Reply accuracy:  ${pct(report.summary.replyAccuracy)}`);
      console.log(`    Action accuracy: ${pct(report.summary.actionAccuracy)}`);
      console.log(`    Policy accuracy: ${pct(report.summary.policyAccuracy)}`);
      console.log(`    Overall:         ${pct(report.summary.overallScore)}`);
      // Retrieval is reported as a separate dimension. Lead with hit@k and
      // recall — those are the primary signals; precision/F1 are supplementary.
      if (report.summary.retrievalHitAtK !== null) {
        console.log(`\n  Retrieval (separate dimension):`);
        console.log(`    hit@k:     ${pct(report.summary.retrievalHitAtK)}    ← did we find any expected note?`);
        console.log(`    recall:    ${pct(report.summary.retrievalRecall)}    ← did we find all of them?  (primary signal)`);
        console.log(`    precision: ${pct(report.summary.retrievalPrecision)}    ← how much noise came along?`);
        console.log(`    f1:        ${pct(report.summary.retrievalF1)}`);
      }
      console.log();
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    // Summary across all fixtures
    const allScores = reports.map((r) => r.summary.overallScore).filter((s): s is number => s !== null);
    if (allScores.length > 0) {
      const avg = allScores.reduce((a, b) => a + b, 0) / allScores.length;
      console.log(`━━━ Overall: ${(avg * 100).toFixed(0)}% across ${reports.length} fixture(s) ━━━`);
    }
  }

  // Save reports
  const reportDir = path.join(FIXTURES_DIR, "..", "reports");
  fs.mkdirSync(reportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  fs.writeFileSync(
    path.join(reportDir, `eval-${timestamp}.json`),
    JSON.stringify(reports, null, 2),
  );
  if (!jsonOutput) console.log(`Reports saved to eval/reports/eval-${timestamp}.json`);
}

main().catch((err) => {
  console.error("Eval failed:", err);
  process.exit(1);
});
