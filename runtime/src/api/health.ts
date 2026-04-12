import http from "node:http";
import { getDb } from "../db/index.js";
import { handleReviewRequest } from "./review.js";
import { handleSetupRequest } from "./setup.js";
import { handlePairingRequest } from "./pairing.js";
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
}) {
  if (flags.authState !== undefined) _authState = flags.authState;
  if (flags.lastConfigFetch !== undefined) _lastConfigFetch = flags.lastConfigFetch;
  if (flags.configExpiresAt !== undefined) _configExpiresAt = flags.configExpiresAt;
  if (flags.twitchConnected !== undefined) _twitchConnected = flags.twitchConnected;
  if (flags.safeMode !== undefined) _safeMode = flags.safeMode;
  if (flags.llmHealthy !== undefined) _llmHealthy = flags.llmHealthy;
  if (flags.helixHealthy !== undefined) _helixHealthy = flags.helixHealthy;
  if (flags.compactionHealthy !== undefined) _compactionHealthy = flags.compactionHealthy;
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
