/**
 * Cross-origin auth gate for the localhost runtime API.
 *
 * Layered defenses already in place upstream:
 *   1) Host header allowlisted to loopback (DNS-rebinding guard)
 *   2) CORS origin allowlisted to exact toolset + dev URLs
 *
 * What this adds:
 *   3) For requests that arrive cross-origin (from the toolset), require
 *      Bearer <installationSecret>. Without this, any other native
 *      process on the same machine that can spoof an Origin header could
 *      poke the localhost runtime — the CORS check only governs what a
 *      browser will let JS read, not what a non-browser client can send.
 *
 * Same-origin requests (the runtime's own /setup and / pages) bypass the
 * Bearer check — those run from the runtime's own HTML, where there's no
 * place to safely store the secret. The Host header guard already proves
 * the request is loopback-targeted; trusting the loopback page itself is
 * the same trust we extend to the runtime process.
 *
 * Pre-pairing, installationSecret is empty. We fail closed on cross-origin
 * mutation in that state — pairing must complete before the toolset can
 * drive the runtime. The pairing handshake itself runs through endpoints
 * that are exempt from this gate (see callers).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { LocalConfig } from "../runtime/config.js";

/**
 * Returns true if the request originated from the runtime's own HTML
 * (Origin missing — typical for a browser navigating directly to
 * http://127.0.0.1:7331/setup) or from a loopback origin matching the
 * server itself. The Host header has already been validated by the
 * outer middleware (see cors.ts isLocalhostHost).
 */
function isSameOriginRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  // Browser-issued requests with same-origin to a loopback page set
  // Origin to `http://127.0.0.1:<port>` or `http://localhost:<port>`.
  // Anything else came from a different origin.
  try {
    const parsed = new URL(origin);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Constant-time string compare. Token check is dwarfed by HTTP overhead
 * but the cost of getting this wrong (timing oracle on the secret) is
 * far higher than the cost of a 32-byte loop.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Gate a mutating endpoint. Returns true if the request is authorized
 * (either same-origin or carrying the correct Bearer secret); writes a
 * 401 / 403 response and returns false otherwise.
 *
 * Caller should `if (!requireSetupAuth(req, res, config)) return true;`
 * to stop further routing — the response has already been written.
 */
export function requireSetupAuth(
  req: IncomingMessage,
  res: ServerResponse,
  config: LocalConfig,
): boolean {
  if (isSameOriginRequest(req)) return true;

  const authHeader = req.headers.authorization;
  const presented = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";

  if (!config.installationSecret) {
    // Cross-origin mutations require pairing first.
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_paired" }));
    return false;
  }

  if (!presented || !timingSafeEqual(presented, config.installationSecret)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_token" }));
    return false;
  }

  return true;
}
