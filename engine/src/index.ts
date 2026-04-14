/**
 * ForgetMeNot — local Twitch bot runtime, main entry point.
 *
 * Hardening principle (2026-04-14): the setup/pairing API is ALWAYS mounted,
 * regardless of credential state. The toolkit drives onboarding via these
 * endpoints; if they're not mounted, the user gets stuck at "ForgetMeNot
 * isn't running" forever even though the runtime is alive — that bug bit a
 * live demo.
 *
 * Two operating modes (transitions are seamless, no restart required):
 *   - setup: no creds OR stale creds → wizard endpoints active, no Twitch
 *   - operational: valid creds → config refresh loop + Twitch gateway
 *
 * Stale-cred recovery: if the auth worker says "Installation not found"
 * (record was deleted in toolkit, KV wiped, etc.), runtime clears local
 * creds, drops back to setup mode, and the toolkit's auto-pair driver
 * picks up from a clean slate.
 */

import { loadLocalConfig, saveConfig, startConfigRefreshLoop, type RuntimeBundle, type LocalConfig } from "./runtime/config.js";
import { initDb, closeDb, getDb } from "./db/index.js";
import { startHealthServer, setHealthFlags, setSetupContext } from "./api/health.js";
import { setPairingCallbacks } from "./api/pairing.js";
import { setWizardContext } from "./api/wizard.js";
import { startGateway, stopGateway } from "./gateway/twitch.js";
import { initEngine, updateBundle } from "./reply/engine.js";
import { setRuntimeContext } from "./actions/executor.js";
import { startCompaction, updateCompactionBundle, stopCompaction } from "./memory/compaction.js";
import type { TimeoutMode } from "./actions/helix.js";

async function main() {
  console.log("[forgetmenot] ForgetMeNot v0.1.23");

  // 1. Load local config (CLI override: --data-dir "path")
  const dataDirArg = process.argv.find((a) => a.startsWith("--data-dir="))?.split("=")[1]
    || (process.argv.includes("--data-dir") ? process.argv[process.argv.indexOf("--data-dir") + 1] : undefined);
  let currentConfig = loadLocalConfig(dataDirArg);
  console.log(`[forgetmenot] Data dir: ${currentConfig.dataDir}`);

  // 2. Bootstrap SQLite
  initDb(currentConfig.dataDir);

  // 3. Start health API
  const healthPort = parseInt(process.env.BOT_HEALTH_PORT || "7331", 10);
  const server = startHealthServer(healthPort);

  // 4. Setup/pairing/wizard endpoints — always mounted, regardless of state.
  // The toolkit drives onboarding through these; refusing to mount them when
  // creds are present-but-stale leaves the user with no way out.
  let cleanupOperational: (() => void) | null = null;

  const onConfigChanged = (newConfig: LocalConfig) => {
    const dataDirChanged = newConfig.dataDir !== currentConfig.dataDir;
    currentConfig = newConfig;

    if (dataDirChanged) {
      console.log(`[forgetmenot] Data dir changed: rebooting db at ${newConfig.dataDir}`);
      closeDb();
      initDb(newConfig.dataDir);
    }

    setHealthFlags({
      llmKeyConfigured: Boolean(newConfig.llmApiKey || process.env.BOT_LLM_API_KEY),
    });

    // Re-wire setup endpoints with the new config so subsequent writes
    // operate on current state, not a captured snapshot.
    wireSetupEndpoints();

    // If creds were just established, transition into operational mode.
    const hasCreds = Boolean(newConfig.installationId && newConfig.installationSecret);
    if (hasCreds && !cleanupOperational) {
      console.log("[forgetmenot] Credentials present. Starting operational mode...");
      cleanupOperational = startOperationalMode(newConfig, dropToSetupMode);
    }
  };

  const dropToSetupMode = (reason: string) => {
    console.warn(`[forgetmenot] Dropping to setup mode: ${reason}`);
    if (cleanupOperational) {
      cleanupOperational();
      cleanupOperational = null;
    }
    // Clear stale creds so the toolkit's auto-pair flow can re-pair cleanly.
    const cleared: LocalConfig = {
      ...currentConfig,
      installationId: "",
      installationSecret: "",
      wizardCompleted: false,
    };
    saveConfig(cleared);
    currentConfig = cleared;
    setHealthFlags({
      authState: "unauthenticated",
      botConnected: false,
      botLogin: null,
      botDisplayName: null,
    });
    wireSetupEndpoints();
  };

  const wireSetupEndpoints = () => {
    setSetupContext(currentConfig, onConfigChanged);
    setWizardContext(currentConfig, onConfigChanged);
    setPairingCallbacks({ onComplete: onConfigChanged });
  };

  wireSetupEndpoints();

  // 5. Graceful shutdown
  const shutdown = () => {
    console.log("[forgetmenot] Shutting down...");
    if (cleanupOperational) cleanupOperational();
    server.close();
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 6. Mode decision
  const hasCreds = Boolean(currentConfig.installationId && currentConfig.installationSecret);

  if (hasCreds) {
    console.log("[forgetmenot] Credentials present. Starting operational mode...");
    cleanupOperational = startOperationalMode(currentConfig, dropToSetupMode);
  } else {
    console.log("[forgetmenot] No credentials. Waiting for toolkit to drive pairing.");
  }

  // Keep DB import alive (avoid tree-shake if engine never starts)
  void getDb;
}

/**
 * Start the full operational mode: config refresh loop, Twitch gateway,
 * reply engine, compaction. Returns a cleanup function.
 *
 * `onStaleCreds` fires when the auth worker says the installation no longer
 * exists — caller should clear local creds and drop back to setup mode.
 */
function startOperationalMode(localConfig: LocalConfig, onStaleCreds: (reason: string) => void): () => void {
  let currentBundle: RuntimeBundle | null = null;

  const refreshLoop = startConfigRefreshLoop(
    localConfig,
    (bundle) => {
      const isFirst = currentBundle === null;
      currentBundle = bundle;

      setHealthFlags({
        authState: "authenticated",
        lastConfigFetch: Date.now(),
        configExpiresAt: new Date(bundle.expiresAt).getTime(),
        safeMode: bundle.safeMode,
        botConnected: bundle.botAccount !== null,
        botLogin: bundle.botAccount?.login ?? null,
        botDisplayName: bundle.botAccount?.displayName ?? bundle.botAccount?.login ?? null,
        llmKeyConfigured: Boolean(localConfig.llmApiKey || process.env.BOT_LLM_API_KEY),
      });

      if (isFirst) {
        console.log(`[forgetmenot] Authenticated. Broadcaster: ${bundle.broadcasterLogin}`);
        console.log(`[forgetmenot] Bot name: ${bundle.settings.botName}`);
        console.log(`[forgetmenot] Safe mode: ${bundle.safeMode ? "ON" : "off"}`);
        console.log(`[forgetmenot] AI: ${bundle.settings.aiProvider} (${bundle.settings.aiModel})`);
      } else {
        console.log(`[forgetmenot] Config refreshed. Safe mode: ${bundle.safeMode ? "ON" : "off"}`);
      }

      const llmApiKey = localConfig.llmApiKey || process.env.BOT_LLM_API_KEY || "";
      const engineMode = localConfig.replyMode || (process.env.BOT_REPLY_MODE as "shadow" | "mentions_only" | "live") || "mentions_only";
      const twitchClientId = process.env.TWITCH_CLIENT_ID || "";
      const timeoutMode = localConfig.timeoutMode || (process.env.BOT_TIMEOUT_MODE as TimeoutMode) || "shadow";
      if (isFirst && llmApiKey) {
        initEngine({ mode: engineMode, apiKey: llmApiKey }, bundle);
      } else if (llmApiKey) {
        updateBundle(bundle);
      }
      if (!llmApiKey && isFirst) {
        console.log("[forgetmenot] No LLM API key — reply engine disabled.");
      }

      setRuntimeContext({
        botAccount: bundle.botAccount,
        broadcasterTwitchId: bundle.broadcasterTwitchId,
        clientId: twitchClientId,
        timeoutMode,
      });

      if (isFirst && llmApiKey) {
        startCompaction(bundle, llmApiKey, twitchClientId);
      } else {
        updateCompactionBundle(bundle);
      }

      if (bundle.botAccount) {
        startGateway({
          botAccount: bundle.botAccount,
          broadcasterLogin: bundle.broadcasterLogin,
        });
      } else {
        console.log("[forgetmenot] No bot account connected. Twitch gateway not started.");
      }
    },
    (error, staleCreds) => {
      console.warn(`[forgetmenot] Config refresh failed: ${error}`);
      setHealthFlags({
        authState: currentBundle ? "authenticated" : "unauthenticated",
        botConnected: currentBundle?.botAccount != null,
        botLogin: currentBundle?.botAccount?.login ?? null,
        botDisplayName: currentBundle?.botAccount?.displayName ?? currentBundle?.botAccount?.login ?? null,
      });
      if (staleCreds) {
        onStaleCreds("auth worker reports installation no longer exists");
      }
    },
  );

  console.log("[forgetmenot] Ready. Config refresh loop active.");

  return () => {
    refreshLoop.stop();
    stopCompaction();
    stopGateway();
  };
}

main().catch((err) => {
  console.error("[forgetmenot] Fatal error:", err);
  process.exit(1);
});
