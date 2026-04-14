/**
 * Shared CORS helper for the localhost runtime API.
 *
 * Toolkit (toolkit.deutschmark.online, or localhost:3001 in dev) calls into
 * the runtime to drive setup, read review data, and persist secrets like the
 * AI key. The runtime stays local-first — only the toolkit form lives
 * cross-origin; storage stays on disk.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export const ALLOWED_ORIGINS = [
  "https://toolkit.deutschmark.online",
  "http://localhost:3000",
  "http://localhost:3001",
];

/** Apply CORS headers if origin is allowed. Returns true if origin matched. */
export function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  const allowed = origin && ALLOWED_ORIGINS.some((o) => origin.startsWith(o));
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin!);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  return !!allowed;
}

/** Handle an OPTIONS preflight by writing CORS headers + 204. Returns true if handled. */
export function handlePreflight(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "OPTIONS") return false;
  applyCors(req, res);
  res.writeHead(204);
  res.end();
  return true;
}
