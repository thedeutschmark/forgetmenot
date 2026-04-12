/**
 * Pairing client — device-code flow against the auth worker.
 *
 * The setup page calls POST /setup/pair to start the flow.
 * This module:
 *   1. Calls POST {authUrl}/bot-pairing/start
 *   2. Opens the approval page in the user's browser
 *   3. Polls POST {authUrl}/bot-pairing/poll every 3 seconds
 *   4. On completion, saves config and fires the onComplete callback
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { saveConfig, type LocalConfig } from "../runtime/config.js";

export type PairingStatus = "idle" | "polling" | "complete" | "expired" | "error";

interface PairingState {
  status: PairingStatus;
  pairingCode: string | null;
  expiresAt: string | null;
  error: string | null;
}

let state: PairingState = { status: "idle", pairingCode: null, expiresAt: null, error: null };
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let onComplete: ((config: LocalConfig) => void) | null = null;

const POLL_INTERVAL_MS = 3000;

export function setPairingCallbacks(callbacks: { onComplete: (config: LocalConfig) => void }) {
  onComplete = callbacks.onComplete;
}

export function getPairingState(): PairingState {
  return { ...state };
}

export function handlePairingRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: LocalConfig,
): boolean {
  if (url.pathname === "/setup/pair" && req.method === "POST") {
    if (state.status === "polling") {
      json(res, 409, { error: "Pairing already in progress" });
      return true;
    }
    void startPairing(config);
    // Return immediately — the page polls /setup/pair/status
    json(res, 200, { ok: true, status: "starting" });
    return true;
  }

  if (url.pathname === "/setup/pair/status" && req.method === "GET") {
    json(res, 200, state);
    return true;
  }

  return false;
}

async function startPairing(config: LocalConfig) {
  state = { status: "polling", pairingCode: null, expiresAt: null, error: null };

  try {
    const startRes = await fetch(`${config.authUrl}/bot-pairing/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    if (!startRes.ok) {
      const body = await startRes.text().catch(() => "");
      state = { status: "error", pairingCode: null, expiresAt: null, error: `Auth worker returned ${startRes.status}: ${body.slice(0, 200)}` };
      return;
    }

    const data = (await startRes.json()) as { pairingCode: string; expiresAt: string };
    state = { status: "polling", pairingCode: data.pairingCode, expiresAt: data.expiresAt, error: null };

    // Open approval page in user's browser
    const approveUrl = `${config.authUrl}/bot-pairing/approve?code=${encodeURIComponent(data.pairingCode)}`;
    openBrowser(approveUrl);

    // Start polling
    schedulePoll(config, data.pairingCode, new Date(data.expiresAt).getTime());
  } catch (err) {
    state = { status: "error", pairingCode: null, expiresAt: null, error: `Failed to start pairing: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function schedulePoll(config: LocalConfig, code: string, expiresAtMs: number) {
  if (pollTimer) clearTimeout(pollTimer);

  pollTimer = setTimeout(async () => {
    // Check if expired client-side
    if (Date.now() > expiresAtMs) {
      state = { ...state, status: "expired", error: "Pairing code expired. Try again." };
      return;
    }

    try {
      const res = await fetch(`${config.authUrl}/bot-pairing/poll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairingCode: code }),
      });

      if (!res.ok) {
        state = { ...state, status: "error", error: `Poll failed: ${res.status}` };
        return;
      }

      const data = (await res.json()) as { status: string; installationId?: string; secret?: string };

      if (data.status === "pending") {
        schedulePoll(config, code, expiresAtMs);
        return;
      }

      if (data.status === "expired") {
        state = { ...state, status: "expired", error: "Pairing code expired. Try again." };
        return;
      }

      if (data.status === "complete" && data.installationId && data.secret) {
        const updatedConfig: LocalConfig = {
          ...config,
          installationId: data.installationId,
          installationSecret: data.secret,
        };
        saveConfig(updatedConfig);
        state = { status: "complete", pairingCode: code, expiresAt: state.expiresAt, error: null };
        console.log("[pairing] Paired successfully. Installation ID:", data.installationId);

        if (onComplete) {
          onComplete(updatedConfig);
        }
        return;
      }

      state = { ...state, status: "error", error: `Unexpected poll response: ${data.status}` };
    } catch (err) {
      // Network error — retry
      console.warn("[pairing] Poll error, retrying:", err instanceof Error ? err.message : err);
      schedulePoll(config, code, expiresAtMs);
    }
  }, POLL_INTERVAL_MS);
}

function openBrowser(url: string) {
  import("node:child_process").then(({ exec }) => {
    const cmd = process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }).catch(() => {});
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
