#!/usr/bin/env node
/**
 * Packages ForgetMeNot as a standalone Windows exe.
 *
 * Uses esbuild (bundle) + Node.js Single Executable Application (SEA).
 * SQLite is provided by Node's built-in node:sqlite — no native addons.
 *
 * Output: build/forgetmenot.exe (single file, no companion files needed)
 *
 * Usage:
 *   npm run build:exe
 */

import { build } from "esbuild";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BUILD_DIR = path.join(ROOT, "build");
const BUNDLE_PATH = path.join(BUILD_DIR, "forgetmenot.cjs");
const BLOB_PATH = path.join(BUILD_DIR, "sea-prep.blob");
const SEA_CONFIG_PATH = path.join(BUILD_DIR, "sea-config.json");
const EXE_PATH = path.join(BUILD_DIR, "forgetmenot.exe");

// ── Clean ────────────────────────────────────────────────────────────
console.log("[build] Cleaning build/...");

// On Windows, kill any running forgetmenot.exe so we can overwrite it.
if (process.platform === "win32" && fs.existsSync(EXE_PATH)) {
  try {
    execSync('taskkill /F /IM forgetmenot.exe', { stdio: "pipe" });
    console.log("[build] Killed running forgetmenot.exe");
  } catch {
    // No running instance — that's fine.
  }
}

// Try to delete with retries (Windows file locks release async).
function rmWithRetry(p, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
      return true;
    } catch (err) {
      if (i === attempts - 1) throw err;
      // Sleep ~200ms (sync) before retry
      const wait = Date.now() + 200;
      while (Date.now() < wait) { /* spin */ }
    }
  }
  return false;
}

try {
  rmWithRetry(BUILD_DIR);
} catch {
  // Last-resort: delete contents individually
  if (fs.existsSync(BUILD_DIR)) {
    for (const f of fs.readdirSync(BUILD_DIR)) {
      try { rmWithRetry(path.join(BUILD_DIR, f)); } catch (e) {
        console.error(`[build] Cannot delete ${f}: ${e.message}`);
        console.error("[build] Close any running forgetmenot.exe and try again.");
        process.exit(1);
      }
    }
  }
}
fs.mkdirSync(BUILD_DIR, { recursive: true });

// ── Step 1: Bundle with esbuild ──────────────────────────────────────
console.log("[build] Bundling with esbuild...");

await build({
  entryPoints: [path.join(ROOT, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: BUNDLE_PATH,
  // tmi.js ships as CJS — let esbuild handle it
  mainFields: ["main", "module"],
});

console.log(`[build] Bundle → ${path.relative(ROOT, BUNDLE_PATH)}`);

// ── Step 2: Generate SEA blob ────────────────────────────────────────
console.log("[build] Generating SEA blob...");

fs.writeFileSync(
  SEA_CONFIG_PATH,
  JSON.stringify({
    main: BUNDLE_PATH,
    output: BLOB_PATH,
    disableExperimentalSEAWarning: true,
    useCodeCache: true,
  }),
);

execFileSync(process.execPath, ["--experimental-sea-config", SEA_CONFIG_PATH], {
  stdio: "inherit",
  cwd: BUILD_DIR,
});

// ── Step 3: Build the exe ────────────────────────────────────────────
console.log("[build] Creating forgetmenot.exe...");

fs.copyFileSync(process.execPath, EXE_PATH);

// Try to strip the Authenticode signature (requires Windows SDK signtool).
// If signtool isn't available the exe will still work — it just won't be
// properly signed. postject's --overwrite handles the resource injection
// either way.
try {
  execSync(`signtool remove /s "${EXE_PATH}"`, { stdio: "pipe" });
  console.log("[build] Stripped existing PE signature.");
} catch {
  // No signtool or nothing to strip — fine.
}

// Inject SEA blob into the copied exe
execSync(
  [
    "npx",
    "postject",
    `"${EXE_PATH}"`,
    "NODE_SEA_BLOB",
    `"${BLOB_PATH}"`,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    "--overwrite",
  ].join(" "),
  { stdio: "inherit", cwd: ROOT },
);

// ── Step 4: Clean up intermediates ───────────────────────────────────
for (const f of [BUNDLE_PATH, BLOB_PATH, SEA_CONFIG_PATH]) {
  fs.rmSync(f, { force: true });
}

// ── Report ───────────────────────────────────────────────────────────
const exeMB = (fs.statSync(EXE_PATH).size / (1024 * 1024)).toFixed(1);

console.log("");
console.log("  Build complete:");
console.log(`    forgetmenot.exe    ${exeMB} MB`);
console.log("");
console.log("  Single file. Double-click to launch.");
