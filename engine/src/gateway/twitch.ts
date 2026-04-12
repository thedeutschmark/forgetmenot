/**
 * Twitch chat gateway — ingest-first.
 *
 * Connects to Twitch chat via tmi.js using bot account credentials.
 * Persists incoming messages to the events table and upserts viewers.
 * Does NOT send replies — that's Phase 3 (reply engine).
 */

import tmi from "tmi.js";
import crypto from "node:crypto";
import { getDb } from "../db/index.js";
import { setHealthFlags } from "../api/health.js";
import { onChatMessage } from "../reply/engine.js";
import type { BotAccountCredentials } from "../runtime/config.js";

type TmiClient = InstanceType<typeof tmi.Client>;

interface GatewayUserstate {
  ["display-name"]?: string;
  ["user-id"]?: string;
  id?: string; // Twitch message UUID
  badges?: Record<string, string | undefined>;
  mod?: boolean;
  username?: string;
}

let client: TmiClient | null = null;
let currentChannel: string | null = null;

export interface GatewayConfig {
  botAccount: BotAccountCredentials;
  broadcasterLogin: string;
}

export function startGateway(config: GatewayConfig): void {
  if (client) {
    console.log("[twitch] Gateway already running, reconnecting...");
    stopGateway();
  }

  const channel = config.broadcasterLogin.toLowerCase();
  currentChannel = channel;

  client = new tmi.Client({
    options: { debug: false },
    identity: {
      username: config.botAccount.login,
      password: `oauth:${config.botAccount.accessToken}`,
    },
    channels: [channel],
    connection: {
      reconnect: true,
      secure: true,
    },
  });

  client.on("connected", (_addr: string, _port: number) => {
    console.log(`[twitch] Connected to #${channel} as ${config.botAccount.login}`);
    setHealthFlags({ twitchConnected: true });
  });

  client.on("disconnected", (reason: string) => {
    console.log(`[twitch] Disconnected: ${reason}`);
    setHealthFlags({ twitchConnected: false });
  });

  client.on("message", (_channel: string, userstate: GatewayUserstate, message: string, self: boolean) => {
    if (self) return; // Skip bot's own messages

    const twitchUserId = userstate["user-id"] || "";
    const login = userstate.username || "";
    const displayName = userstate["display-name"] || login;
    const isMod = userstate.mod || false;
    const isVip = userstate.badges?.vip === "1";

    // Persist event (idempotent via hash — survives reconnect replays)
    try {
      const db = getDb();
      // Use Twitch message UUID when available (best dedupe key).
      // Fallback: hash of user + content + 60s time bucket. The bucket catches
      // reconnect replay storms (which arrive within seconds) but lets a user
      // legitimately repeat the same message after a minute without collapsing.
      let eventHash: string;
      if (userstate.id) {
        eventHash = userstate.id;
      } else {
        const bucket = Math.floor(Date.now() / 60_000);
        eventHash = crypto.createHash("sha256")
          .update(`${twitchUserId}:${message}:${bucket}`)
          .digest("hex").slice(0, 16);
        console.warn("[twitch] Message missing userstate.id — using fallback hash");
      }

      const inserted = db.prepare(`
        INSERT OR IGNORE INTO events (event_type, twitch_user_id, message_text, source, importance_score, event_hash)
        VALUES ('chat_message', ?, ?, 'chat', 0.0, ?)
      `).run(twitchUserId, message, eventHash);

      // Skip if duplicate (reconnect replayed message)
      if (inserted.changes === 0) return;

      // Upsert viewer
      db.prepare(`
        INSERT INTO viewers (twitch_user_id, login, display_name, is_mod, is_vip, last_seen_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(twitch_user_id) DO UPDATE SET
          login = excluded.login,
          display_name = excluded.display_name,
          is_mod = excluded.is_mod,
          is_vip = excluded.is_vip,
          last_seen_at = datetime('now')
      `).run(twitchUserId, login, displayName, isMod ? 1 : 0, isVip ? 1 : 0);
    } catch (err) {
      console.error("[twitch] Failed to persist event:", err);
    }

    // Fire-and-forget reply engine evaluation
    void onChatMessage(login, twitchUserId, message);
  });

  client.on("join", (_channel: string, username: string, self: boolean) => {
    if (self) return;
    // Lightweight viewer tracking — just update last_seen
    try {
      getDb().prepare(`
        UPDATE viewers SET last_seen_at = datetime('now') WHERE login = ?
      `).run(username.toLowerCase());
    } catch { /* ignore */ }
  });

  client.connect().catch((err: unknown) => {
    console.error("[twitch] Connection failed:", err);
    setHealthFlags({ twitchConnected: false });
  });
}

export function stopGateway(): void {
  if (client) {
    client.disconnect().catch(() => {});
    client = null;
    currentChannel = null;
    setHealthFlags({ twitchConnected: false });
    console.log("[twitch] Gateway stopped.");
  }
}

export function sendMessage(text: string): void {
  if (!client || !currentChannel) {
    console.warn("[twitch] Cannot send — not connected.");
    return;
  }
  client.say(currentChannel, text).catch((err: unknown) => {
    console.error("[twitch] Failed to send message:", err);
  });
}

export function isConnected(): boolean {
  return client !== null && client.readyState() === "OPEN";
}
