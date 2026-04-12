/**
 * Review API — serves recent bot activity data for the toolkit review surface.
 *
 * All endpoints are read-only and served from local SQLite.
 * CORS is restricted to toolkit origins.
 *
 * Endpoints:
 *   GET /review/replies       — recent bot messages
 *   GET /review/actions       — recent action log entries
 *   GET /review/memory        — recent semantic note changes
 *   GET /review/episodes      — recent episode summaries
 *   GET /review/stats         — aggregate counts
 *   POST /review/safe-mode    — toggle safe mode
 *   POST /review/timeout-mode — switch timeout rollout mode
 */

import { getDb } from "../db/index.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const ALLOWED_ORIGINS = [
  "https://toolkit.deutschmark.online",
  "http://localhost:3000",
  "http://localhost:3001",
];

function cors(res: ServerResponse, origin: string | undefined): boolean {
  const allowed = origin && ALLOWED_ORIGINS.some((o) => origin.startsWith(o));
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin!);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  return !!allowed;
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function parseLimit(url: URL): number {
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);
  return Math.max(1, Math.min(200, limit));
}

export function handleReviewRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  if (!url.pathname.startsWith("/review")) return false;

  const origin = req.headers.origin;
  cors(res, origin);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  const db = getDb();
  const limit = parseLimit(url);
  const filter = url.searchParams.get("filter") || "";

  try {
    // ── Recent replies ──
    if (url.pathname === "/review/replies" && req.method === "GET") {
      let query = `
        SELECT id, occurred_at, reply_text, trigger_type, viewer_target_id, model_name, token_usage_json
        FROM bot_messages ORDER BY occurred_at DESC LIMIT ?
      `;
      const params: (string | number | null)[] = [limit];

      if (filter) {
        query = `
          SELECT id, occurred_at, reply_text, trigger_type, viewer_target_id, model_name, token_usage_json
          FROM bot_messages WHERE trigger_type = ? ORDER BY occurred_at DESC LIMIT ?
        `;
        params.unshift(filter);
      }

      const rows = db.prepare(query).all(...params);
      json(res, { replies: rows });
      return true;
    }

    // ── Recent actions ──
    if (url.pathname === "/review/actions" && req.method === "GET") {
      let query = `
        SELECT id, occurred_at, action_type, target_login, reason, policy_result, proposed_by, executed, execution_error
        FROM action_logs ORDER BY occurred_at DESC LIMIT ?
      `;
      const params: (string | number | null)[] = [limit];

      if (filter === "denied") {
        query = `
          SELECT id, occurred_at, action_type, target_login, reason, policy_result, proposed_by, executed, execution_error
          FROM action_logs WHERE policy_result = 'deny' ORDER BY occurred_at DESC LIMIT ?
        `;
      } else if (filter === "executed") {
        query = `
          SELECT id, occurred_at, action_type, target_login, reason, policy_result, proposed_by, executed, execution_error
          FROM action_logs WHERE executed = 1 ORDER BY occurred_at DESC LIMIT ?
        `;
      } else if (filter) {
        query = `
          SELECT id, occurred_at, action_type, target_login, reason, policy_result, proposed_by, executed, execution_error
          FROM action_logs WHERE action_type = ? ORDER BY occurred_at DESC LIMIT ?
        `;
        params.unshift(filter);
      }

      const rows = db.prepare(query).all(...params);
      json(res, { actions: rows });
      return true;
    }

    // ── Recent memory writes ──
    if (url.pathname === "/review/memory" && req.method === "GET") {
      let query = `
        SELECT id, scope, subject_type, subject_id, category, fact, confidence, status, first_observed_at, last_confirmed_at, superseded_by
        FROM semantic_notes ORDER BY first_observed_at DESC LIMIT ?
      `;
      const params: (string | number | null)[] = [limit];

      if (filter) {
        query = `
          SELECT id, scope, subject_type, subject_id, category, fact, confidence, status, first_observed_at, last_confirmed_at, superseded_by
          FROM semantic_notes WHERE scope = ? ORDER BY first_observed_at DESC LIMIT ?
        `;
        params.unshift(filter);
      }

      const rows = db.prepare(query).all(...params);
      json(res, { notes: rows });
      return true;
    }

    // ── Recent episodes ──
    if (url.pathname === "/review/episodes" && req.method === "GET") {
      const rows = db
        .prepare(`
          SELECT id, started_at, ended_at, topic, participants_json, summary, source_event_count, status
          FROM episodes ORDER BY started_at DESC LIMIT ?
        `)
        .all(limit);
      json(res, { episodes: rows });
      return true;
    }

    // ── Aggregate stats ──
    if (url.pathname === "/review/stats" && req.method === "GET") {
      const stats = {
        totalReplies: (db.prepare("SELECT COUNT(*) as c FROM bot_messages").get() as { c: number })?.c || 0,
        totalActions: (db.prepare("SELECT COUNT(*) as c FROM action_logs").get() as { c: number })?.c || 0,
        totalDenied: (db.prepare("SELECT COUNT(*) as c FROM action_logs WHERE policy_result = 'deny'").get() as { c: number })?.c || 0,
        totalExecuted: (db.prepare("SELECT COUNT(*) as c FROM action_logs WHERE executed = 1").get() as { c: number })?.c || 0,
        totalNotes: (db.prepare("SELECT COUNT(*) as c FROM semantic_notes WHERE status = 'active'").get() as { c: number })?.c || 0,
        totalEpisodes: (db.prepare("SELECT COUNT(*) as c FROM episodes").get() as { c: number })?.c || 0,
        totalViewers: (db.prepare("SELECT COUNT(*) as c FROM viewers").get() as { c: number })?.c || 0,
        totalEvents: (db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number })?.c || 0,
      };
      json(res, { stats });
      return true;
    }
  } catch (err) {
    json(res, { error: err instanceof Error ? err.message : "Internal error" }, 500);
    return true;
  }

  return false;
}
