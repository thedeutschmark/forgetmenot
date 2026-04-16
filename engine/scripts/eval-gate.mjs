#!/usr/bin/env node
/**
 * Eval gate — pre-tag discipline for engine changes.
 *
 * Runs the eval harness against current source, compares to the committed
 * baseline in eval/baseline.json, exits non-zero if any fixture regressed
 * beyond the tolerance. The point isn't CI yet — it's making "run eval
 * before tagging" an actual ritual instead of an aspiration.
 *
 *   npm run eval:gate            # compare current run vs baseline
 *   npm run eval:gate -- --init  # write/overwrite baseline from current run
 *
 * Tolerances (intentionally strict; adjust if they become noise):
 *   - Overall score: regression > 5 percentage points → fail
 *   - Per-fixture any dimension (reply/action/policy): > 10pp → fail
 *   - Retrieval (recall, hit@k): > 15pp → fail
 *
 * Requires GEMINI_API_KEY (or BOT_LLM_API_KEY) in env. The eval hits real
 * LLMs, so costs a few cents per run.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, "..");
const BASELINE_PATH = path.join(PKG_ROOT, "eval", "baseline.json");

const INIT = process.argv.includes("--init");
const VERBOSE = process.argv.includes("--verbose");

const TOLERANCE = {
  overall: 0.05,          // 5pp
  perFixtureAccuracy: 0.10, // 10pp on reply/action/policy
  retrieval: 0.15,        // 15pp on hit@k / recall
};

/** Run the eval CLI, return the parsed report array. */
function runEval() {
  console.log("[gate] Running eval (this takes ~1 minute, hits live LLM)...\n");
  const result = spawnSync("npx", ["tsx", "src/eval/cli.ts", "--json"], {
    cwd: PKG_ROOT,
    env: process.env,
    encoding: "utf-8",
    shell: true,
    // 5 min cap — one fixture ~15s, we have 5 fixtures, large buffer
    timeout: 300_000,
  });
  if (result.status !== 0) {
    console.error("[gate] Eval CLI failed:");
    console.error(result.stderr || result.stdout);
    process.exit(2);
  }
  // --json mode prints JSON on stdout, but the runtime also emits
  // non-JSON logs like '[db] SQLite ready at ...' on the same stream, so
  // a naive indexOf('[') picks up the wrong bracket. The eval CLI uses
  // JSON.stringify(reports, null, 2) which reliably produces a top-level
  // array with '[\n  {' as its first three chars. Scan for that exact
  // sequence at the start of a line.
  const stdout = result.stdout || "";
  const match = stdout.match(/^\[\n {2}\{/m);
  if (!match || match.index === undefined) {
    console.error("[gate] Couldn't find JSON in eval output.");
    console.error(stdout.slice(-800));
    process.exit(2);
  }
  try {
    return JSON.parse(stdout.slice(match.index));
  } catch (err) {
    console.error("[gate] Found something that looked like JSON but couldn't parse:", err?.message);
    console.error(stdout.slice(match.index, match.index + 500));
    process.exit(2);
  }
}

/** Reduce a report array into a compact baseline record. */
function summarize(reports) {
  const fixtures = {};
  for (const r of reports) {
    fixtures[r.fixtureId] = {
      name: r.fixtureName,
      replyAccuracy: r.summary.replyAccuracy,
      actionAccuracy: r.summary.actionAccuracy,
      policyAccuracy: r.summary.policyAccuracy,
      retrievalHitAtK: r.summary.retrievalHitAtK,
      retrievalRecall: r.summary.retrievalRecall,
      overallScore: r.summary.overallScore,
    };
  }
  const scores = reports.map((r) => r.summary.overallScore).filter((s) => s !== null);
  const overall = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  return {
    overall,
    fixtures,
    generatedAt: new Date().toISOString(),
  };
}

/** Compare current to baseline. Returns { regressions, improvements }. */
function compare(baseline, current) {
  const regressions = [];
  const improvements = [];

  const dOverall = (current.overall ?? 0) - (baseline.overall ?? 0);
  if (Math.abs(dOverall) >= 0.01) {
    (dOverall < 0 ? regressions : improvements).push({
      kind: "overall",
      delta: dOverall,
      threshold: TOLERANCE.overall,
      hard: dOverall < -TOLERANCE.overall,
    });
  }

  // New fixtures present in current but not baseline — hard fail so a
  // freshly added fixture can't silently bypass the gate. Author accepts
  // it via `npm run eval:baseline` once the scores look right.
  for (const id of Object.keys(current.fixtures)) {
    if (!(id in baseline.fixtures)) {
      regressions.push({ kind: "fixture_unbaselined", id, hard: true });
    }
  }

  for (const [id, b] of Object.entries(baseline.fixtures)) {
    const c = current.fixtures[id];
    if (!c) {
      regressions.push({ kind: "fixture_missing", id, hard: true });
      continue;
    }
    const pairs = [
      ["replyAccuracy", TOLERANCE.perFixtureAccuracy],
      ["actionAccuracy", TOLERANCE.perFixtureAccuracy],
      ["policyAccuracy", TOLERANCE.perFixtureAccuracy],
      ["retrievalHitAtK", TOLERANCE.retrieval],
      ["retrievalRecall", TOLERANCE.retrieval],
      ["overallScore", TOLERANCE.overall],
    ];
    for (const [field, threshold] of pairs) {
      const bVal = b[field];
      const cVal = c[field];
      if (bVal === null || bVal === undefined) continue;
      if (cVal === null || cVal === undefined) {
        // Signal disappearance — baseline had a score, current run
        // couldn't compute one. Usually benign (e.g. policyAccuracy
        // goes null when the bot stops proposing actions the fixture
        // expected it to propose). Soft regression: print it so it's
        // visible, don't hard-fail.
        regressions.push({ kind: "null_score", id, field, hard: false });
        continue;
      }
      const delta = cVal - bVal;
      if (Math.abs(delta) < 0.005) continue;
      const entry = { kind: "fixture", id, field, delta, threshold, hard: delta < -threshold };
      (delta < 0 ? regressions : improvements).push(entry);
    }
  }

  return { regressions, improvements };
}

function pct(v) {
  return v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(0)}%`;
}
function dpct(v) {
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}pp`;
}

function printDiff({ regressions, improvements }, baseline, current) {
  console.log(`Overall: ${pct(baseline.overall)} → ${pct(current.overall)}`);
  console.log();

  if (improvements.length > 0) {
    console.log("Improvements:");
    for (const i of improvements) {
      if (i.kind === "overall") console.log(`  + overall score ${dpct(i.delta)}`);
      else console.log(`  + ${i.id} ${i.field} ${dpct(i.delta)}`);
    }
    console.log();
  }

  if (regressions.length > 0) {
    console.log("Regressions:");
    for (const r of regressions) {
      const marker = r.hard ? "✗" : "·";
      if (r.kind === "overall") console.log(`  ${marker} overall score ${dpct(r.delta)} (threshold -${(r.threshold * 100).toFixed(0)}pp)`);
      else if (r.kind === "fixture_missing") console.log(`  ${marker} fixture ${r.id} missing from current run`);
      else if (r.kind === "fixture_unbaselined") console.log(`  ${marker} new fixture ${r.id} not in baseline — accept with \`npm run eval:baseline\``);
      else if (r.kind === "null_score") console.log(`  ${marker} ${r.id} ${r.field} became null`);
      else console.log(`  ${marker} ${r.id} ${r.field} ${dpct(r.delta)} (threshold -${(r.threshold * 100).toFixed(0)}pp)`);
    }
  } else if (improvements.length === 0) {
    console.log("No meaningful change vs baseline.");
  }
}

// ── Main ──

const reports = runEval();
const current = summarize(reports);

if (INIT) {
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + "\n");
  console.log(`[gate] Baseline written: ${BASELINE_PATH}`);
  console.log(`  overall: ${pct(current.overall)}`);
  for (const [id, f] of Object.entries(current.fixtures)) {
    console.log(`  ${id}: overall=${pct(f.overallScore)} reply=${pct(f.replyAccuracy)} action=${pct(f.actionAccuracy)}`);
  }
  process.exit(0);
}

if (!fs.existsSync(BASELINE_PATH)) {
  console.error("[gate] No baseline at eval/baseline.json. Run with --init first:");
  console.error("  npm run eval:gate -- --init");
  process.exit(2);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8"));
const diff = compare(baseline, current);

if (VERBOSE) {
  console.log("Current vs baseline (all scores):");
  for (const [id, b] of Object.entries(baseline.fixtures)) {
    const c = current.fixtures[id] || {};
    console.log(`  ${id}: overall ${pct(b.overallScore)} → ${pct(c.overallScore)}`);
  }
  console.log();
}

printDiff(diff, baseline, current);

const hardRegressions = diff.regressions.filter((r) => r.hard);
if (hardRegressions.length > 0) {
  console.log();
  console.log(`[gate] ${hardRegressions.length} hard regression(s). Fix or accept new baseline with:`);
  console.log("  npm run eval:gate -- --init");
  process.exit(1);
}

console.log();
console.log("[gate] No hard regressions. Safe to tag.");
