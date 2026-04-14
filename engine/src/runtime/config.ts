import fs from "node:fs";
import path from "node:path";

export type ReplyMode = "shadow" | "mentions_only" | "live";
export type TimeoutMode = "shadow" | "dry_run" | "live";

export interface LocalConfig {
  authUrl: string;
  installationId: string;
  installationSecret: string;
  dataDir: string;
  llmApiKey: string;
  replyMode: ReplyMode;
  timeoutMode: TimeoutMode;
  wizardCompleted: boolean;
}

export interface BotSettings {
  botName: string;
  botAliases: string[];
  personaSummary: string;
  replyFrequency: "low" | "medium" | "high";
  snarkLevel: number;
  loreIntensity: number;
  maxReplyLength: number;
  offTopicTolerance: "strict" | "moderate" | "loose";
  memoryRetentionDays: number;
  compactionFrequency: "every_stream" | "daily" | "weekly";
  aiProvider: "gemini" | "openai";
  aiModel: string;
  /** How the bot sees the broadcaster — injected into prompt only when the
   *  current message author is the broadcaster login. See workers/auth
   *  BotSettings for authoritative docs. */
  creatorRelationship: "loyal" | "rebellious" | "human_delusion";
}

export interface BotPolicy {
  autonomousRepliesEnabled: boolean;
  funModerationEnabled: boolean;
  funnyTimeoutEnabled: boolean;
  maxTimeoutDurationSeconds: number;
  perViewerCooldownMinutes: number;
  globalCooldownMinutes: number;
  optInRequired: boolean;
  allowlist: string[];
  denylist: string[];
  sensitiveTopics: string[];
  safeMode: boolean;
}

export interface BotAccountCredentials {
  twitchId: string;
  login: string;
  displayName: string;
  accessToken: string;
}

export interface RuntimeBundle {
  installationId: string;
  broadcasterTwitchId: string;
  broadcasterLogin: string;
  settings: BotSettings;
  policy: BotPolicy;
  settingsVersion: string;
  policyVersion: string;
  safeMode: boolean;
  expiresAt: string;
  botAccount: BotAccountCredentials | null;
}

export interface RuntimeConfig {
  local: LocalConfig;
  bundle: RuntimeBundle | null;
  lastFetchedAt: number;
  fetchError: string | null;
}

const CONFIG_FILE = "config.json";

/** Platform-appropriate default data directory */
function getDefaultDataDir(): string {
  const platform = process.platform;
  const home = process.env.HOME || process.env.USERPROFILE || "";

  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return path.join(localAppData, "ForgetMeNot");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "ForgetMeNot");
  }
  // Linux / other
  return path.join(home, ".local", "share", "forgetmenot");
}
const MIN_REFRESH_MS = 30_000;       // 30s minimum between refreshes
const NORMAL_REFRESH_MS = 300_000;   // 5 min normal refresh interval
const MAX_BACKOFF_MS = 600_000;      // 10 min max backoff on failure

/**
 * Config file lives in a stable app-config directory per OS.
 * The dataDir INSIDE the config points to the user's chosen data location.
 * This separation means restart always finds the config, even if the
 * user picked a custom data path.
 *
 * Config location:
 *   Windows: %LOCALAPPDATA%/ForgetMeNot/config.json
 *   macOS:   ~/Library/Application Support/ForgetMeNot/config.json
 *   Linux:   ~/.local/share/forgetmenot/config.json
 *
 * Data location (user-selectable, defaults to same as config dir):
 *   config.dataDir → where SQLite, memory, logs live
 */
export function getConfigDir(): string {
  return getDefaultDataDir();
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), CONFIG_FILE);
}

export function loadLocalConfig(dataDirOverride?: string): LocalConfig {
  const configDir = dataDirOverride || process.env.BOT_DATA_DIR || getConfigDir();
  const configPath = path.join(configDir, CONFIG_FILE);

  // Also check the stable config dir if the override path doesn't have a config
  const stableConfigPath = getConfigPath();
  const effectiveConfigPath = fs.existsSync(configPath) ? configPath
    : fs.existsSync(stableConfigPath) ? stableConfigPath
    : null;

  if (!effectiveConfigPath) {
    const defaultDataDir = getDefaultDataDir();
    const defaults: LocalConfig = {
      authUrl: process.env.BOT_AUTH_URL || "https://auth.deutschmark.online",
      installationId: process.env.BOT_INSTALLATION_ID || "",
      installationSecret: process.env.BOT_INSTALLATION_SECRET || "",
      dataDir: dataDirOverride || defaultDataDir,
      llmApiKey: process.env.BOT_LLM_API_KEY || "",
      replyMode: "mentions_only",
      timeoutMode: "shadow",
      wizardCompleted: false,
    };

    // Write config to the stable config dir (not the data dir)
    const stableDir = getConfigDir();
    fs.mkdirSync(stableDir, { recursive: true });
    fs.writeFileSync(stableConfigPath, JSON.stringify(defaults, null, 2));
    console.log(`[config] Created default config at ${stableConfigPath}`);

    // Also create data dir if different
    if (defaults.dataDir !== stableDir) {
      fs.mkdirSync(defaults.dataDir, { recursive: true });
    }

    return defaults;
  }

  const raw = fs.readFileSync(effectiveConfigPath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<LocalConfig>;

  const config: LocalConfig = {
    authUrl: parsed.authUrl || "https://auth.deutschmark.online",
    installationId: parsed.installationId || "",
    installationSecret: parsed.installationSecret || "",
    dataDir: dataDirOverride || parsed.dataDir || getDefaultDataDir(),
    llmApiKey: parsed.llmApiKey || process.env.BOT_LLM_API_KEY || "",
    replyMode: parsed.replyMode || (process.env.BOT_REPLY_MODE as ReplyMode) || "mentions_only",
    timeoutMode: parsed.timeoutMode || (process.env.BOT_TIMEOUT_MODE as TimeoutMode) || "shadow",
    wizardCompleted: parsed.wizardCompleted ?? false,
  };

  // Ensure data dir exists
  fs.mkdirSync(config.dataDir, { recursive: true });

  return config;
}

/**
 * Save config to the stable config directory.
 * Always writes to the same predictable OS path.
 */
export function saveConfig(config: LocalConfig): void {
  const stableDir = getConfigDir();
  fs.mkdirSync(stableDir, { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));

  // Also create data dir if different from config dir
  if (config.dataDir !== stableDir) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }
}

/**
 * Fetch a runtime bundle from the auth worker.
 * Sends installationId + secret, gets back settings/policy/credentials.
 */
export async function fetchRuntimeBundle(local: LocalConfig): Promise<{ bundle: RuntimeBundle | null; error: string | null; staleCreds?: boolean }> {
  if (!local.installationId || !local.installationSecret) {
    return { bundle: null, error: "No installation credentials configured." };
  }

  try {
    const res = await fetch(`${local.authUrl}/bot-runtime/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installationId: local.installationId,
        secret: local.installationSecret,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      // Auth worker returns 401 + "Installation not found" when the install
      // record is gone (deleted in toolkit, or KV wiped). Surface this as a
      // typed signal so the runtime can self-heal by clearing stale creds
      // instead of looping forever in operational mode against a dead install.
      const isStaleCreds = res.status === 401 && body.includes("Installation not found");
      return {
        bundle: null,
        error: `Auth worker returned ${res.status}: ${body.slice(0, 200)}`,
        staleCreds: isStaleCreds,
      };
    }

    const data = (await res.json()) as { bundle: RuntimeBundle };
    return { bundle: data.bundle, error: null };
  } catch (err) {
    return { bundle: null, error: `Fetch failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Config refresh loop with exponential backoff on failure.
 * Calls onUpdate whenever new config is successfully fetched.
 */
export function startConfigRefreshLoop(
  local: LocalConfig,
  onUpdate: (bundle: RuntimeBundle) => void,
  onError: (error: string, staleCreds: boolean) => void,
): { stop: () => void } {
  let consecutiveFailures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function tick() {
    if (stopped) return;

    const { bundle, error, staleCreds } = await fetchRuntimeBundle(local);

    if (bundle) {
      consecutiveFailures = 0;
      onUpdate(bundle);
    } else if (error) {
      consecutiveFailures++;
      onError(error, Boolean(staleCreds));
    }

    // Schedule next refresh with backoff
    const delay = bundle
      ? NORMAL_REFRESH_MS
      : Math.min(MAX_BACKOFF_MS, MIN_REFRESH_MS * Math.pow(2, consecutiveFailures - 1));

    timer = setTimeout(tick, delay);
  }

  // Start first fetch
  tick();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
