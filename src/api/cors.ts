/**
 * Shared CORS helper for the localhost runtime API.
 *
 * Toolset (toolset.deutschmark.online, or localhost:3001 in dev) calls into
 * the runtime to drive setup, read review data, and persist secrets like the
 * AI key. The runtime stays local-first — only the toolset form lives
 * cross-origin; storage stays on disk.
 *
 * Threat model: any website the user visits could try to fetch the localhost
 * API. Two defenses, layered:
 *   1) Origin: exact-match allowlist. Reflecting an unvalidated origin with
 *      Allow-Credentials lets attackers read responses cross-site.
 *   2) Host: localhost-only allowlist. Closes the DNS-rebinding hole where
 *      `evil.com` resolves to 127.0.0.1 and the browser still sends the
 *      attacker's Host header. The Origin check alone won't catch a request
 *      with no Origin header (curl, fetch with no-cors), so we belt-and-
 *      suspenders.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export const ALLOWED_ORIGINS = [
  "https://toolset.deutschmark.online",
  "http://localhost:3000",
  "http://localhost:3001",
];

const ALLOWED_HOST_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** True iff the Host header points at this loopback server (not a rebound name). */
export function isLocalhostHost(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  // Strip optional port. IPv6 hosts arrive as "[::1]:7331".
  const hostname = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":")[0];
  return ALLOWED_HOST_HOSTNAMES.has(hostname);
}

/** Apply CORS headers if origin is allowed. Returns true if origin matched. */
export function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  // Exact match only. `startsWith` was a real bug — `https://toolset.
  // deutschmark.online.attacker.com` startsWith the allowed prefix and would
  // have been reflected with Allow-Credentials, letting any site exfil the
  // localhost API.
  const allowed = !!origin && ALLOWED_ORIGINS.includes(origin);
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  return allowed;
}

/** Handle an OPTIONS preflight by writing CORS headers + 204. Returns true if handled. */
export function handlePreflight(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "OPTIONS") return false;
  applyCors(req, res);
  res.writeHead(204);
  res.end();
  return true;
}
