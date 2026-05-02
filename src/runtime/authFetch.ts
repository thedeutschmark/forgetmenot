import { VERSION } from "../version.js";

/**
 * Wrapper around fetch for auth-worker calls. Sets a `User-Agent:
 * ForgetMeNot/<version>` header so requests are identifiable in the auth
 * worker's logs and so any future Cloudflare bot heuristics see something
 * descriptive rather than the raw Node.js default ("node" or empty).
 *
 * Use this for every call to the auth worker. Local-only requests (the
 * loopback health/setup API) don't need it.
 *
 * History: v0.1.59 also rewrote `auth.deutschmark.online` URLs to the
 * workers.dev equivalent to bypass zone-level Cloudflare Bot Fight Mode.
 * Bot Fight Mode was disabled on the zone 2026-04-30 so the rewrite was
 * dropped — the custom domain is canonical. If CF ever re-enables an
 * equivalent feature and runtime auth calls start 403'ing with
 * "Just a moment..." pages again, restore the workers.dev rewrite.
 */
export function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", `ForgetMeNot/${VERSION}`);
  }
  return fetch(input, { ...init, headers });
}
