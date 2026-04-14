import http from "node:http";
import { getDb } from "../db/index.js";
import { handleReviewRequest } from "./review.js";
import { handleSetupRequest } from "./setup.js";
import { handlePairingRequest, getPairingState } from "./pairing.js";
import { handleWizardRequest } from "./wizard.js";
import { applyCors, handlePreflight } from "./cors.js";
import { handleControlRequest } from "./control.js";
import { isPaused, getEngineMode } from "../reply/engine.js";
import type { LocalConfig } from "../runtime/config.js";

export interface HealthStatus {
  status: "ok" | "degraded" | "error";
  uptime: number;
  subsystems: {
    db: "healthy" | "unhealthy";
    auth: "authenticated" | "unauthenticated" | "expired";
    chat: "connected" | "disconnected";
    llm: "healthy" | "unhealthy" | "unknown";
    helix: "healthy" | "unhealthy" | "unknown";
    compaction: "healthy" | "stale" | "unknown";
  };
  configAge: number | null;
  safeMode: boolean;
  paused: boolean;
  engineMode: string | null;
  botConnected: boolean;
  /** Login of the connected bot account, null if none paired. Surfaced to the
   *  tray so users can confirm which Twitch account is speaking on their behalf. */
  botLogin: string | null;
  /** Display-name of the connected bot account (defaults to login when unset). */
  botDisplayName: string | null;
  /** True iff LocalConfig.llmApiKey is non-empty. Lets the tray decide
   *  whether first-run auto-open is still needed — a "ready" runtime means
   *  bot account connected AND LLM key present, not just one of them. */
  llmKeyConfigured: boolean;
  /** Reply mode from LocalConfig — toolkit uses this to render the runtime
   *  mode section and POST updates back via /setup. `null` when no config
   *  is registered yet (pre-pairing). */
  replyMode: string | null;
  /** Timeout mode from LocalConfig — same shape/contract as replyMode. */
  timeoutMode: string | null;
  version: string;
  issues: string[];
}

let startTime = Date.now();
let _authState: "authenticated" | "unauthenticated" | "expired" = "unauthenticated";
let _lastConfigFetch: number | null = null;
let _configExpiresAt: number | null = null;
let _twitchConnected = false;
let _safeMode = false;
let _llmHealthy: "healthy" | "unhealthy" | "unknown" = "unknown";
let _helixHealthy: "healthy" | "unhealthy" | "unknown" = "unknown";
let _compactionHealthy: "healthy" | "stale" | "unknown" = "unknown";
let _botConnected = false;
let _botLogin: string | null = null;
let _botDisplayName: string | null = null;
let _llmKeyConfigured = false;

const CONFIG_STALE_THRESHOLD_MS = 600_000;

export function setHealthFlags(flags: {
  authState?: "authenticated" | "unauthenticated" | "expired";
  lastConfigFetch?: number;
  configExpiresAt?: number;
  twitchConnected?: boolean;
  safeMode?: boolean;
  llmHealthy?: "healthy" | "unhealthy" | "unknown";
  helixHealthy?: "healthy" | "unhealthy" | "unknown";
  compactionHealthy?: "healthy" | "stale" | "unknown";
  botConnected?: boolean;
  /** Pass `null` explicitly to clear the bot account (disconnect). */
  botLogin?: string | null;
  botDisplayName?: string | null;
  llmKeyConfigured?: boolean;
}) {
  if (flags.authState !== undefined) _authState = flags.authState;
  if (flags.lastConfigFetch !== undefined) _lastConfigFetch = flags.lastConfigFetch;
  if (flags.configExpiresAt !== undefined) _configExpiresAt = flags.configExpiresAt;
  if (flags.twitchConnected !== undefined) _twitchConnected = flags.twitchConnected;
  if (flags.safeMode !== undefined) _safeMode = flags.safeMode;
  if (flags.llmHealthy !== undefined) _llmHealthy = flags.llmHealthy;
  if (flags.helixHealthy !== undefined) _helixHealthy = flags.helixHealthy;
  if (flags.compactionHealthy !== undefined) _compactionHealthy = flags.compactionHealthy;
  if (flags.botConnected !== undefined) _botConnected = flags.botConnected;
  if (flags.botLogin !== undefined) _botLogin = flags.botLogin;
  if (flags.botDisplayName !== undefined) _botDisplayName = flags.botDisplayName;
  if (flags.llmKeyConfigured !== undefined) _llmKeyConfigured = flags.llmKeyConfigured;
}

function getHealth(): HealthStatus {
  const issues: string[] = [];

  // DB check
  let dbStatus: "healthy" | "unhealthy" = "unhealthy";
  try {
    getDb().prepare("SELECT 1").get();
    dbStatus = "healthy";
  } catch {
    issues.push("SQLite database unreachable");
  }

  // Auth check — flip to expired if bundle has passed its expiry
  if (_authState === "authenticated" && _configExpiresAt && Date.now() > _configExpiresAt) {
    _authState = "expired";
  }
  if (_authState === "unauthenticated") issues.push("Not authenticated with control plane");
  if (_authState === "expired") issues.push("Runtime session expired");

  // Config freshness
  const configAge = _lastConfigFetch ? Math.round((Date.now() - _lastConfigFetch) / 1000) : null;
  if (_lastConfigFetch && Date.now() - _lastConfigFetch > CONFIG_STALE_THRESHOLD_MS) {
    issues.push("Config is stale (last fetch > 10 min ago)");
  }

  // Subsystem checks
  if (!_twitchConnected) issues.push("Twitch chat not connected");
  if (_llmHealthy === "unhealthy") issues.push("LLM provider returning errors");
  if (_helixHealthy === "unhealthy") issues.push("Twitch Helix API returning errors");
  if (_compactionHealthy === "stale") issues.push("Compaction loop stale");

  // Overall status
  let status: "ok" | "degraded" | "error" = "ok";
  if (issues.length > 0) status = "degraded";
  if (dbStatus === "unhealthy" || _authState === "unauthenticated") status = "error";

  return {
    status,
    uptime: Math.round((Date.now() - startTime) / 1000),
    subsystems: {
      db: dbStatus,
      auth: _authState,
      chat: _twitchConnected ? "connected" : "disconnected",
      llm: _llmHealthy,
      helix: _helixHealthy,
      compaction: _compactionHealthy,
    },
    configAge,
    safeMode: _safeMode,
    paused: isPaused(),
    engineMode: getEngineMode(),
    botConnected: _botConnected,
    botLogin: _botLogin,
    botDisplayName: _botDisplayName,
    llmKeyConfigured: _llmKeyConfigured,
    replyMode: _localConfig?.replyMode ?? null,
    timeoutMode: _localConfig?.timeoutMode ?? null,
    version: "0.1.23",
    issues,
  };
}

let _localConfig: LocalConfig | null = null;
let _onConfigSaved: ((config: LocalConfig) => void) | null = null;

export function setSetupContext(config: LocalConfig, onSaved: (config: LocalConfig) => void): void {
  _localConfig = config;
  _onConfigSaved = onSaved;
}

export function startHealthServer(port: number = 7331): http.Server {
  startTime = Date.now();

  const server = http.createServer((req, res) => {
    // Apply CORS headers + handle OPTIONS preflight FIRST, before any route
    // handler can early-return. v0.1.1 had this below the /health, /status,
    // and / handlers, which meant the toolkit's auto-pair driver got a CORS
    // error on /health and never even reached the runtime check.
    applyCors(req, res);
    if (handlePreflight(req, res)) return;

    if (req.url === "/health" && req.method === "GET") {
      const health = getHealth();
      res.writeHead(health.status === "ok" ? 200 : health.status === "degraded" ? 200 : 503, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(health));
      return;
    }

    if (req.url === "/status" && req.method === "GET") {
      const health = getHealth();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health, null, 2));
      return;
    }

    // Root landing — the compact localhost-owned surface per the onboarding
    // shift locked 2026-04-13. Shows status, pairing code (if unpaired), and
    // the AI key field. Everything else (bot account, rollout, personality)
    // lives in toolkit. This replaces the old "/ → 404" behavior that made
    // the toolkit wizard's "open localhost:7331" instruction a dead end.
    if ((req.url === "/" || req.url === "") && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderRootLanding(_localConfig, getHealth()));
      return;
    }

    const parsedUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);

    // Wizard (onboarding flow)
    if (handleWizardRequest(req, res, parsedUrl)) return;

    // Pairing API (device-code flow)
    if (_localConfig && handlePairingRequest(req, res, parsedUrl, _localConfig)) return;

    // Control API (tray app: pause/resume/safe-mode)
    if (_localConfig && handleControlRequest(req, res, parsedUrl, _localConfig)) return;

    // Setup page (reconfigure)
    if (_localConfig && _onConfigSaved && handleSetupRequest(req, res, parsedUrl, _localConfig, _onConfigSaved)) return;

    // Review API
    if (handleReviewRequest(req, res, parsedUrl)) return;

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`[api] Health server listening on http://127.0.0.1:${port}/health`);
  });

  return server;
}

/* ─── Root landing page ──────────────────────────────────────────────
 *
 * Compact landing served at `/`. Per the locked onboarding boundary:
 *   localhost owns  pairing code + AI key + local runtime status
 *   toolkit   owns  bot account + rollout + settings + policy + review
 *
 * Any time this page wants to grow into a "wizard" — that's a smell.
 * Forms that aren't pairing or AI key belong in the toolkit.
 */

const TOOLKIT_URL = "https://toolkit.deutschmark.online/tools/chat-bot";

// Inline base64 of services/forgetmenot-tray/icons/flower.png so the brand
// mark renders without a second HTTP roundtrip and without coupling the
// runtime to an asset file path. ~2.4KB embedded — kept inline to avoid
// adding a static-asset handler for one image.
const FLOWER_PNG_BASE64 =
  "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";

function renderRootLanding(config: LocalConfig | null, health: HealthStatus): string {
  const paired = Boolean(config?.installationId && config?.installationSecret);
  const hasKey = Boolean(config?.llmApiKey);
  const pairing = getPairingState();

  // Status pill mirrors the tray icon semantics (yellow=healthy etc).
  const statusPill = health.paused
    ? { bg: "#71717a", text: "paused" }
    : health.status === "ok"
      ? { bg: "#facc15", text: "healthy" }
      : health.status === "degraded"
        ? { bg: "#f97316", text: "degraded" }
        : { bg: "#ef4444", text: "error" };

  const botLine = health.botConnected && (health.botDisplayName || health.botLogin)
    ? `Bot account: <strong>${escapeHtml(health.botDisplayName || health.botLogin || "")}</strong> connected`
    : paired
      ? `Bot account: <em>not connected</em> — link in toolkit`
      : `Bot account: link in toolkit after pairing`;

  // Design tokens copied 1:1 from apps/toolkit/app/globals.css so the
  // localhost surface reads as the same product as the toolkit landing,
  // not a separate utility page. Only delta is the brand mark — flower
  // here, "dm" rack-light there.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ForgetMeNot — local runtime</title>
<style>
  :root{
    --tk-bg-page:#09090b;--tk-bg-panel:#0f0f11;--tk-bg-elevated:#131316;
    --tk-bg-subtle:#18181b;--tk-bg-hover:#202024;
    --tk-border:#1c1c1f;--tk-border-strong:#27272a;--tk-border-hover:#3f3f46;
    --tk-text-strong:#fafafa;--tk-text:#e4e4e7;--tk-text-muted:#a1a1aa;--tk-text-dim:#71717a;
    --tk-accent:#7aa2f7;--tk-accent-rgb:122,162,247;
    --tk-success:#22c55e;
    --tk-radius-sm:10px;--tk-radius-md:14px;--tk-radius-lg:18px;
    --tk-shadow-sm:0 8px 24px rgba(0,0,0,.22);--tk-shadow-md:0 18px 46px rgba(0,0,0,.3);
  }
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
    background:var(--tk-bg-page);color:var(--tk-text);
    min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px 24px;
  }
  .shell{max-width:520px;width:100%;display:flex;flex-direction:column;align-items:center}
  .hero{
    width:min(160px,38vw);margin-bottom:18px;padding:18px;
    border-radius:32px;
    background:radial-gradient(circle at 50% 32%,rgba(122,162,247,.18),transparent 38%),
               radial-gradient(circle at 50% 60%,rgba(255,255,255,.05),transparent 62%);
    filter:drop-shadow(0 20px 44px rgba(0,0,0,.46));
  }
  .hero img{width:100%;height:auto;display:block;image-rendering:auto;
            filter:drop-shadow(0 12px 28px rgba(0,0,0,.42))}
  .eyebrow{
    font-size:11px;font-weight:700;letter-spacing:.26em;text-transform:uppercase;
    color:var(--tk-text-dim);margin:0 0 14px;text-align:center;
  }
  h1{
    font-size:clamp(1.6rem,4.5vw,2.2rem);font-weight:800;letter-spacing:-.04em;
    line-height:1.1;color:var(--tk-text-strong);margin:0 0 8px;text-align:center;
  }
  .tagline{
    font-size:14px;line-height:1.6;color:var(--tk-text-muted);
    text-align:center;margin:0 0 28px;max-width:380px;
  }
  .card{
    width:100%;background:linear-gradient(180deg,rgba(255,255,255,.015),rgba(255,255,255,0)),var(--tk-bg-panel);
    border:1px solid var(--tk-border);border-radius:var(--tk-radius-lg);
    box-shadow:var(--tk-shadow-sm);padding:24px;margin-bottom:14px;
  }
  .card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
  .card-title{
    font-size:11px;font-weight:700;color:var(--tk-text-dim);
    text-transform:uppercase;letter-spacing:.08em;
  }
  .pill{
    display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;
    font-size:10px;font-weight:700;color:#0a0a0c;text-transform:uppercase;letter-spacing:.05em;
  }
  .pill-dot{width:6px;height:6px;border-radius:50%;background:#0a0a0c;opacity:.6}
  .row{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap}
  .status-line{font-size:13px;color:var(--tk-text-muted);margin-top:6px;line-height:1.5}
  .status-line strong{color:var(--tk-text-strong);font-weight:600}
  .status-line em{color:#f97316;font-style:normal}
  input{
    width:100%;padding:11px 14px;font-size:13px;
    background:var(--tk-bg-subtle);border:1px solid var(--tk-border-strong);
    border-radius:var(--tk-radius-sm);color:var(--tk-text-strong);outline:none;font-family:inherit;
    transition:border-color .15s;
  }
  input:focus{border-color:var(--tk-border-hover)}
  .btn{
    display:inline-flex;align-items:center;justify-content:center;gap:8px;
    height:40px;padding:0 18px;font-size:13px;font-weight:600;
    border-radius:var(--tk-radius-sm);cursor:pointer;text-decoration:none;
    transition:filter .15s,border-color .15s;font-family:inherit;
  }
  .btn-primary{
    border:1px solid rgba(var(--tk-accent-rgb),.28);
    background:linear-gradient(180deg,rgba(var(--tk-accent-rgb),.18),rgba(var(--tk-accent-rgb),.11));
    color:var(--tk-text-strong);
  }
  .btn-primary:hover{filter:brightness(1.15)}
  .btn-primary:disabled{opacity:.5;cursor:default}
  .btn-ghost{
    background:transparent;color:var(--tk-text-muted);border:1px solid var(--tk-border-strong);
  }
  .btn-ghost:hover{color:var(--tk-text-strong);border-color:var(--tk-border-hover)}
  .code{
    font-family:'SF Mono','JetBrains Mono','Fira Code',monospace;
    font-size:22px;font-weight:700;letter-spacing:.14em;color:var(--tk-text-strong);
    padding:14px 16px;background:var(--tk-bg-subtle);border:1px solid var(--tk-border-strong);
    border-radius:var(--tk-radius-sm);text-align:center;
  }
  .note{font-size:11px;color:var(--tk-text-dim);margin-top:10px;line-height:1.5}
  .hint{font-size:11px;color:var(--tk-text-dim);margin-top:8px;line-height:1.5}
  .saved{color:var(--tk-success);font-size:11px}
  .toolkit-cta{
    display:flex;align-items:center;justify-content:space-between;gap:14px;
    width:100%;padding:14px 16px;border-radius:var(--tk-radius-md);
    background:var(--tk-bg-panel);border:1px solid var(--tk-border);
    color:var(--tk-text);font-size:13px;line-height:1.5;text-decoration:none;
    transition:border-color .15s;
  }
  .toolkit-cta:hover{border-color:var(--tk-border-hover)}
  .toolkit-cta strong{color:var(--tk-text-strong);font-weight:600;display:block}
  .toolkit-cta .arrow{color:var(--tk-text-dim);font-size:18px}
  a{color:var(--tk-accent)}
  a:hover{color:#a8c2fa}
</style>
</head>
<body>
  <div class="shell">
    <div class="hero" aria-hidden="true">
      <img alt="ForgetMeNot" src="data:image/png;base64,${FLOWER_PNG_BASE64}">
    </div>
    <p class="eyebrow">deutschmark · forgetmenot</p>
    <h1>Local runtime is alive.</h1>
    <p class="tagline">Two things stay on this machine: your AI key and the pairing handshake. Everything else runs in the toolkit.</p>

    ${paired ? "" : `
    <div class="card">
      <div class="card-head">
        <span class="card-title">Step 1 · pair runtime</span>
      </div>
      ${pairing.pairingCode
        ? `<div class="code">${escapeHtml(pairing.pairingCode)}</div>
           <p class="note">Approve this code in the browser window that just opened. This page updates once pairing completes.</p>`
        : `<p class="hint">Generate a pairing code. Your broadcaster session will be asked to approve it.</p>
           <div class="row"><button class="btn btn-primary" onclick="startPair()">Start pairing</button></div>`
      }
    </div>`}

    <div class="card">
      <div class="card-head">
        <span class="card-title">${paired ? "Status" : "Once paired"}</span>
        <span class="pill" style="background:${statusPill.bg}"><span class="pill-dot"></span>${statusPill.text}</span>
      </div>
      <div class="status-line">Runtime: <strong>${statusPill.text}</strong>${health.uptime ? ` <span style="color:var(--tk-text-dim)">· up ${formatUptime(health.uptime)}</span>` : ""}</div>
      <div class="status-line">${botLine}</div>
      ${paired ? `<div class="status-line">Install: <strong>${escapeHtml(config?.installationId?.slice(0, 8) || "?")}…</strong></div>` : ""}
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title">AI API key</span>
        <span style="font-size:11px;color:var(--tk-text-dim)">stays on this machine</span>
      </div>
      <form id="aiKeyForm" onsubmit="return saveKey(event)">
        <input type="password" id="aiKey" placeholder="${hasKey ? "••••••••••• already set — paste to replace" : "sk-… or AI… (Gemini or OpenAI)"}" autocomplete="off">
        <div class="row">
          <button type="submit" class="btn btn-primary">${hasKey ? "Update key" : "Save key"}</button>
          <span id="keySaved" class="saved" style="display:none">✓ saved — runtime will pick it up shortly</span>
        </div>
        <p class="hint">Your Gemini or OpenAI key never leaves this machine. That&apos;s deliberate — local-first is the point.</p>
      </form>
    </div>

    <a href="${TOOLKIT_URL}" class="toolkit-cta">
      <div>
        <strong>Open toolkit</strong>
        <span style="color:var(--tk-text-muted);font-size:12px">Connect bot account, rollout defaults, personality.</span>
      </div>
      <span class="arrow">→</span>
    </a>
  </div>

<script>
  async function startPair() {
    const btn = event.target;
    btn.disabled = true;
    btn.textContent = "Starting...";
    try {
      const r = await fetch("/setup/pair", { method: "POST" });
      if (r.ok) {
        setTimeout(() => location.reload(), 1500);
      } else {
        btn.textContent = "Failed — retry";
        btn.disabled = false;
      }
    } catch {
      btn.textContent = "Failed — retry";
      btn.disabled = false;
    }
  }

  async function saveKey(e) {
    e.preventDefault();
    const key = document.getElementById("aiKey").value.trim();
    if (!key) return false;
    const r = await fetch("/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llmApiKey: key }),
    });
    if (r.ok) {
      document.getElementById("keySaved").style.display = "inline";
      document.getElementById("aiKey").value = "";
      setTimeout(() => { document.getElementById("keySaved").style.display = "none"; }, 3000);
    }
    return false;
  }

  // If unpaired and pairing is polling, refresh periodically to pick up the
  // pairing code and eventual completion without manual reload.
  ${!paired ? `setInterval(() => { location.reload(); }, 5000);` : ``}
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
