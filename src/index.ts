/**
 * ForgetMeNot — local Twitch bot runtime, main entry point.
 *
 * Three startup states:
 *   1. No installationId        → wizard from Screen 1 (full onboarding)
 *   2. Has credentials, !wizard → wizard from Screen 3 (resume onboarding)
 *   3. wizardCompleted          → operational mode
 */

import { loadLocalConfig, startConfigRefreshLoop, type RuntimeBundle, type LocalConfig } from "./runtime/config.js";
import { initDb, closeDb, getDb } from "./db/index.js";
import { startHealthServer, setHealthFlags, setSetupContext } from "./api/health.js";
import { setPairingCallbacks } from "./api/pairing.js";
import { setWizardContext } from "./api/wizard.js";
import { startGateway, stopGateway } from "./gateway/twitch.js";
import { initEngine, updateBundle } from "./reply/engine.js";
import { setRuntimeContext } from "./actions/executor.js";
import { startCompaction, updateCompactionBundle, stopCompaction } from "./memory/compaction.js";
import type { TimeoutMode } from "./actions/helix.js";
import type http from "node:http";

async function main() {
  console.log("[forgetmenot] ForgetMeNot v0.1.0");

  // 1. Load local config (CLI override: --data-dir "path")
  const dataDirArg = process.argv.find((a) => a.startsWith("--data-dir="))?.split("=")[1]
    || (process.argv.includes("--data-dir") ? process.argv[process.argv.indexOf("--data-dir") + 1] : undefined);
  const localConfig = loadLocalConfig(dataDirArg);
  console.log(`[forgetmenot] Data dir: ${localConfig.dataDir}`);

  // 2. Bootstrap SQLite
  initDb(localConfig.dataDir);

  // 3. Start health API
  const healthPort = parseInt(process.env.BOT_HEALTH_PORT || "7331", 10);
  const server = startHealthServer(healthPort);

  // 4. Graceful shutdown (registered once, works in both modes)
  let cleanupFn: (() => void) | null = null;
  const shutdown = () => {
    console.log("[forgetmenot] Shutting down...");
    if (cleanupFn) cleanupFn();
    server.close();
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 5. Three-state startup
  const hasCreds = !!(localConfig.installationId && localConfig.installationSecret);

  if (hasCreds && localConfig.wizardCompleted) {
    // ── State 3: Fully configured → operational mode ──
    cleanupFn = startOperationalMode(localConfig, server);
  } else {
    // ── State 1 or 2: Need onboarding ──
    const isResume = hasCreds && !localConfig.wizardCompleted;
    console.log(isResume
      ? "[forgetmenot] Onboarding incomplete. Opening wizard..."
      : "[forgetmenot] No installation credentials. Opening wizard...");

    /** Reinitialize DB if dataDir changed, then start operational mode. */
    const transitionToOperational = (config: LocalConfig) => {
      if (config.dataDir !== localConfig.dataDir) {
        console.log(`[forgetmenot] Data dir changed: ${localConfig.dataDir} → ${config.dataDir}`);
        closeDb();
        initDb(config.dataDir);
      }
      cleanupFn = startOperationalMode(config, server);
    };

    // Wire wizard — finish callback transitions to operational mode
    setWizardContext(localConfig, (updatedConfig) => {
      console.log("[forgetmenot] Onboarding complete. Transitioning to operational mode...");
      transitionToOperational(updatedConfig);
    });

    // Wire pairing callback (used by Screen 1 of the wizard)
    setPairingCallbacks({
      onComplete: (newConfig) => {
        console.log("[forgetmenot] Pairing complete. Wizard will continue onboarding.");
        // Update the wizard's config reference so it can proxy settings writes
        setWizardContext(newConfig, (updatedConfig) => {
          console.log("[forgetmenot] Onboarding complete. Transitioning to operational mode...");
          transitionToOperational(updatedConfig);
        });
      },
    });

    // Also wire manual setup page (fallback/reconfigure)
    setSetupContext(localConfig, (newConfig) => {
      if (newConfig.installationId && newConfig.installationSecret) {
        setWizardContext(newConfig, (updatedConfig) => {
          console.log("[forgetmenot] Onboarding complete. Transitioning to operational mode...");
          transitionToOperational(updatedConfig);
        });
      }
    });

    const wizardUrl = `http://127.0.0.1:${healthPort}/wizard`;
    console.log(`[forgetmenot] Wizard: ${wizardUrl}`);

    import("node:child_process").then(({ exec }) => {
      const cmd = process.platform === "win32" ? `start ${wizardUrl}` : process.platform === "darwin" ? `open ${wizardUrl}` : `xdg-open ${wizardUrl}`;
      exec(cmd, () => {});
    }).catch(() => {});
  }
}

/**
 * Start the full operational mode: config refresh loop, Twitch gateway,
 * reply engine, compaction. Returns a cleanup function for shutdown.
 */
function startOperationalMode(localConfig: LocalConfig, _server: http.Server): () => void {
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
      });

      if (isFirst) {
        console.log(`[forgetmenot] Authenticated. Broadcaster: ${bundle.broadcasterLogin}`);
        console.log(`[forgetmenot] Bot name: ${bundle.settings.botName}`);
        console.log(`[forgetmenot] Safe mode: ${bundle.safeMode ? "ON" : "off"}`);
        console.log(`[forgetmenot] AI: ${bundle.settings.aiProvider} (${bundle.settings.aiModel})`);
      } else {
        console.log(`[forgetmenot] Config refreshed. Safe mode: ${bundle.safeMode ? "ON" : "off"}`);
      }

      // Runtime configuration (config takes precedence, env vars as fallback)
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

      // Set runtime context for action executor
      setRuntimeContext({
        botAccount: bundle.botAccount,
        broadcasterTwitchId: bundle.broadcasterTwitchId,
        clientId: twitchClientId,
        timeoutMode,
      });

      // Start or update compaction loop
      if (isFirst && llmApiKey) {
        startCompaction(bundle, llmApiKey, twitchClientId);
      } else {
        updateCompactionBundle(bundle);
      }

      // Start or restart Twitch gateway when we have bot credentials
      if (bundle.botAccount) {
        startGateway({
          botAccount: bundle.botAccount,
          broadcasterLogin: bundle.broadcasterLogin,
        });
      } else {
        console.log("[forgetmenot] No bot account connected. Twitch gateway not started.");
      }
    },
    (error) => {
      console.warn(`[forgetmenot] Config refresh failed: ${error}`);
      setHealthFlags({ authState: currentBundle ? "authenticated" : "unauthenticated" });
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
