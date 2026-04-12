/**
 * Control API — runtime mutations triggered by the tray app.
 *
 * Endpoints:
 *   POST /control/pause      — flip engine to shadow, remember previous mode
 *   POST /control/resume     — restore previous mode
 *   POST /control/safe-mode  — toggle safeMode in auth worker policy
 *
 * Pause/resume are in-memory only (no config write).
 * Safe-mode proxies to the auth worker via installation credentials.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { pause, resume, isPaused, getEngineMode } from "../reply/engine.js";
import { setHealthFlags } from "./health.js";
import type { LocalConfig } from "../runtime/config.js";

export function handleControlRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: LocalConfig,
): boolean {
  if (url.pathname === "/control/pause" && req.method === "POST") {
    const previousMode = pause();
    json(res, 200, { paused: isPaused(), previousMode });
    return true;
  }

  if (url.pathname === "/control/resume" && req.method === "POST") {
    const restoredMode = resume();
    json(res, 200, { paused: isPaused(), mode: restoredMode || getEngineMode() });
    return true;
  }

  if (url.pathname === "/control/safe-mode" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => { void handleSafeMode(res, body, config); });
    return true;
  }

  return false;
}

async function handleSafeMode(res: ServerResponse, rawBody: string, config: LocalConfig) {
  let payload: { enabled?: boolean };
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    json(res, 400, { error: "Invalid JSON" });
    return;
  }

  if (typeof payload.enabled !== "boolean") {
    json(res, 400, { error: "Missing 'enabled' boolean in body" });
    return;
  }

  if (!config.installationId || !config.installationSecret) {
    json(res, 400, { error: "Not paired — installation credentials missing" });
    return;
  }

  try {
    const r = await fetch(`${config.authUrl}/bot-runtime/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installationId: config.installationId,
        secret: config.installationSecret,
        policy: { safeMode: payload.enabled },
      }),
    });

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      json(res, 502, { error: `Auth worker returned ${r.status}`, details: body.slice(0, 200) });
      return;
    }

    // Mirror locally so /health reflects the change immediately
    setHealthFlags({ safeMode: payload.enabled });
    json(res, 200, { safeMode: payload.enabled });
  } catch (err) {
    json(res, 502, { error: "Failed to reach auth worker", details: String(err) });
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
