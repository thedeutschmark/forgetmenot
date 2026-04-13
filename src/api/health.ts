import http from "node:http";
import { getDb } from "../db/index.js";
import { handleReviewRequest } from "./review.js";
import { handleSetupRequest } from "./setup.js";
import { handlePairingRequest, getPairingState } from "./pairing.js";
import { handleWizardRequest } from "./wizard.js";
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
    version: "0.1.0",
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

function renderRootLanding(config: LocalConfig | null, health: HealthStatus): string {
  const paired = Boolean(config?.installationId && config?.installationSecret);
  const hasKey = Boolean(config?.llmApiKey);
  const pairing = getPairingState();

  // Status pill color/text mirrors the tray icon semantics so the local
  // and tray surfaces read the same story.
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
      ? `Bot account: <em>not connected</em> — link it in toolkit`
      : `Bot account: link in toolkit after pairing`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ForgetMeNot — local runtime</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0c;color:#e4e4e7;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#18181b;border:1px solid #27272a;border-radius:16px;padding:28px;max-width:520px;width:100%}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:4px}
  .brand h1{font-size:18px;font-weight:700;letter-spacing:-0.01em}
  .pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;color:#0a0a0c;text-transform:uppercase;letter-spacing:0.05em}
  .pill-dot{width:6px;height:6px;border-radius:50%;background:#0a0a0c;opacity:0.6}
  .sub{font-size:12px;color:#71717a;margin-top:4px;line-height:1.5}
  .section{margin-top:20px;padding-top:20px;border-top:1px solid #27272a}
  .section-title{font-size:11px;font-weight:700;color:#71717a;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px}
  .status-line{font-size:12px;color:#a1a1aa;margin-top:4px}
  .status-line strong{color:#fafafa}
  .status-line em{color:#f97316;font-style:normal}
  input{width:100%;padding:10px 14px;font-size:13px;background:#09090b;border:1px solid #27272a;border-radius:8px;color:#fafafa;outline:none;font-family:inherit}
  input:focus{border-color:#3f3f46}
  .row{display:flex;gap:10px;margin-top:10px}
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:10px 18px;font-size:13px;font-weight:600;border:none;border-radius:8px;cursor:pointer;text-decoration:none;transition:background 150ms}
  .btn-primary{background:#facc15;color:#0a0a0c}
  .btn-primary:hover{background:#eab308}
  .btn-primary:disabled{background:#27272a;color:#52525b;cursor:default}
  .btn-ghost{background:transparent;color:#a1a1aa;border:1px solid #27272a}
  .btn-ghost:hover{color:#fafafa;border-color:#3f3f46}
  .code{font-family:'SF Mono','Fira Code',monospace;font-size:20px;font-weight:700;letter-spacing:0.12em;color:#fafafa;padding:12px 16px;background:#09090b;border:1px solid #27272a;border-radius:8px;text-align:center}
  .note{font-size:11px;color:#52525b;margin-top:8px;line-height:1.5}
  .ok{color:#4ade80}
  .hint{font-size:11px;color:#71717a;margin-top:6px;line-height:1.5}
  .toolkit-cta{display:block;margin-top:14px;padding:12px 14px;border-radius:8px;background:#09090b;border:1px solid #27272a;color:#a1a1aa;font-size:12px;line-height:1.5;text-decoration:none;transition:border-color 150ms}
  .toolkit-cta:hover{border-color:#3f3f46;color:#fafafa}
  .toolkit-cta strong{color:#fafafa}
  .saved{color:#4ade80;font-size:11px;margin-left:8px}
</style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <h1>ForgetMeNot</h1>
      <span class="pill" style="background:${statusPill.bg}"><span class="pill-dot"></span>${statusPill.text}</span>
    </div>
    <p class="sub">This runtime is running on your machine. Finish setup at <a href="${TOOLKIT_URL}" style="color:#a1a1aa;text-decoration:underline">toolkit.deutschmark.online</a>.</p>

    ${paired ? "" : `
    <div class="section">
      <div class="section-title">Step 1 — pair</div>
      <div id="pairingBlock">
        ${pairing.pairingCode
          ? `<div class="code">${escapeHtml(pairing.pairingCode)}</div>
             <p class="note">Approve this code in the browser window that just opened. This page will update once pairing completes.</p>`
          : `<p class="hint">Click below to get a pairing code. Your broadcaster browser session will be asked to approve it.</p>
             <div class="row"><button class="btn btn-primary" onclick="startPair()">Start pairing</button></div>`
        }
      </div>
    </div>`}

    <div class="section">
      <div class="section-title">${paired ? "Status" : "Once paired"}</div>
      <div class="status-line">Runtime: <strong>${statusPill.text}</strong>${health.uptime ? ` (up ${formatUptime(health.uptime)})` : ""}</div>
      <div class="status-line">${botLine}</div>
      ${paired ? `<div class="status-line">Install: <strong>${escapeHtml(config?.installationId?.slice(0, 8) || "?")}...</strong></div>` : ""}
    </div>

    <div class="section">
      <div class="section-title">AI API key <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#52525b">— stays on this machine</span></div>
      <form id="aiKeyForm" onsubmit="return saveKey(event)">
        <input type="password" id="aiKey" placeholder="${hasKey ? "••••••••••• (already set — paste to replace)" : "sk-... or AI... (Gemini or OpenAI)"}" autocomplete="off">
        <div class="row">
          <button type="submit" class="btn btn-primary">${hasKey ? "Update key" : "Save key"}</button>
          <span id="keySaved" class="saved" style="display:none;align-self:center">✓ saved — the bot will pick it up shortly</span>
        </div>
        <p class="hint">Your Gemini or OpenAI API key never leaves this machine. That&apos;s deliberate — the key is yours, and the local-first posture is the point.</p>
      </form>
    </div>

    <a href="${TOOLKIT_URL}" class="toolkit-cta">
      <strong>Open toolkit to finish setup →</strong><br>
      Connect your bot account, pick rollout defaults, and tune personality.
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
