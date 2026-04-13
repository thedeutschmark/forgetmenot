/**
 * Onboarding wizard — 7-screen first-run experience.
 *
 * Serves GET /wizard (HTML) and handles:
 *   GET  /wizard/bot-account/status — forced fresh check
 *   POST /wizard/finish             — single authoritative save + launch
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { saveConfig, fetchRuntimeBundle, type LocalConfig, type ReplyMode, type TimeoutMode } from "../runtime/config.js";

// ── Types ────────────────────────────────────────────────────────────

interface WizardFinishPayload {
  local: {
    dataDir: string;
    llmApiKey: string;
    replyMode: ReplyMode;
    timeoutMode: TimeoutMode;
  };
  settings: Record<string, unknown>;
  policy: Record<string, unknown>;
}

// ── Module state ─────────────────────────────────────────────────────

let _config: LocalConfig | null = null;
let _onFinish: ((config: LocalConfig) => void) | null = null;

export function setWizardContext(
  config: LocalConfig,
  onFinish: (config: LocalConfig) => void,
) {
  _config = config;
  _onFinish = onFinish;
}

// ── Route handler ────────────────────────────────────────────────────

export function handleWizardRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  if (!_config) return false;

  if (url.pathname === "/wizard" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderWizardPage(_config));
    return true;
  }

  if (url.pathname === "/wizard/bot-account/status" && req.method === "GET") {
    void handleBotAccountStatus(res);
    return true;
  }

  if (url.pathname === "/wizard/finish" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => { void handleFinish(res, body); });
    return true;
  }

  return false;
}

// ── Bot account status (forced fresh check) ──────────────────────────

async function handleBotAccountStatus(res: ServerResponse) {
  if (!_config?.installationId || !_config?.installationSecret) {
    json(res, 200, { connected: false });
    return;
  }

  const { bundle } = await fetchRuntimeBundle(_config);
  if (bundle?.botAccount) {
    json(res, 200, { connected: true, login: bundle.botAccount.login, displayName: bundle.botAccount.displayName });
  } else {
    json(res, 200, { connected: false });
  }
}

// ── Finish orchestrator ──────────────────────────────────────────────

async function handleFinish(res: ServerResponse, rawBody: string) {
  if (!_config) {
    json(res, 500, { error: "Wizard not initialized" });
    return;
  }

  let payload: WizardFinishPayload;
  try {
    payload = JSON.parse(rawBody) as WizardFinishPayload;
  } catch {
    json(res, 400, { error: "Invalid JSON" });
    return;
  }

  // Build the final local config (but don't persist yet — remote writes first)
  const updatedConfig: LocalConfig = {
    ..._config,
    dataDir: payload.local.dataDir?.trim() || _config.dataDir,
    llmApiKey: payload.local.llmApiKey?.trim() || _config.llmApiKey,
    replyMode: payload.local.replyMode || _config.replyMode,
    timeoutMode: payload.local.timeoutMode || _config.timeoutMode,
    wizardCompleted: true,
  };

  // Step 1: Proxy settings to auth worker
  try {
    const settingsRes = await fetch(`${_config.authUrl}/bot-runtime/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installationId: _config.installationId,
        secret: _config.installationSecret,
        settings: payload.settings,
      }),
    });
    if (!settingsRes.ok) {
      const body = await settingsRes.text().catch(() => "");
      json(res, 502, { error: `Auth worker settings: ${settingsRes.status}`, step: "settings", details: body.slice(0, 200) });
      return;
    }
  } catch (err) {
    json(res, 502, { error: "Failed to save settings", step: "settings", details: String(err) });
    return;
  }

  // Step 3: Proxy policy to auth worker
  try {
    const policyRes = await fetch(`${_config.authUrl}/bot-runtime/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installationId: _config.installationId,
        secret: _config.installationSecret,
        policy: payload.policy,
      }),
    });
    if (!policyRes.ok) {
      const body = await policyRes.text().catch(() => "");
      json(res, 502, { error: `Auth worker policy: ${policyRes.status}`, step: "policy", details: body.slice(0, 200) });
      return;
    }
  } catch (err) {
    json(res, 502, { error: "Failed to save policy", step: "policy", details: String(err) });
    return;
  }

  // Step 3: Persist local config (only after remote writes succeeded)
  try {
    saveConfig(updatedConfig);
    _config = updatedConfig;
  } catch (err) {
    json(res, 500, { error: "Failed to save local config", step: "local", details: String(err) });
    return;
  }

  // Step 4: Transition to operational mode
  console.log("[wizard] Onboarding complete. Transitioning to operational mode...");
  if (_onFinish) _onFinish(_config);

  json(res, 200, { ok: true });
}

// ── Personality templates ────────────────────────────────────────────

// Templates describe the tone only. Bot name is chosen by the user in the
// input below the template cards; the persona string has {{botName}} placeholders
// that get substituted when the user proceeds to the next screen.
const TEMPLATES = [
  {
    key: "bratty",
    name: "Bratty",
    tagline: "Sarcastic, meta-aware, chaotically loyal",
    preview: "Oh look, chat figured out how to type. Impressive. Welcome back, I guess.",
    suggestedName: "Snark",
    personaSummary: "You are {{botName}}, a bratty AI mod who is self-aware and leans into it. Tone: sarcastic, meta-humor, playfully antagonistic but ultimately loyal. You roast chat affectionately and make self-deprecating jokes about being an AI. Keep replies short and punchy. No hate speech, threats, sexual content, or harassment.",
    snarkLevel: 85, loreIntensity: 70, replyFrequency: "medium",
  },
  {
    key: "chaotic_bestie",
    name: "Chaotic Bestie",
    tagline: "Hype energy, meme-literate, zero chill",
    preview: "NO WAYYY that play was INSANE chat we are WITNESSING GREATNESS!!",
    suggestedName: "Hype",
    personaSummary: "You are {{botName}}, an over-the-top hype bot and chaotic best friend to chat. Tone: enthusiastic, meme-aware, stream-brained, excitable. You amplify funny moments, hype good plays, and keep energy high. Short bursts of excitement. No hate speech, threats, sexual content, or harassment.",
    snarkLevel: 40, loreIntensity: 50, replyFrequency: "high",
  },
  {
    key: "warm_cohost",
    name: "Warm Co-Host",
    tagline: "Helpful, friendly, keeps conversation flowing",
    preview: "Hey welcome in! We were just talking about the new update -- have you tried it yet?",
    suggestedName: "Helper",
    personaSummary: "You are {{botName}}, a warm and friendly co-host AI. Tone: welcoming, conversational, genuinely helpful. You greet newcomers, ask follow-up questions, and keep discussions going. You are supportive and encouraging. Keep replies conversational and natural. No hate speech, threats, sexual content, or harassment.",
    snarkLevel: 20, loreIntensity: 60, replyFrequency: "medium",
  },
  {
    key: "quiet_lorekeeper",
    name: "Quiet Lorekeeper",
    tagline: "Speaks rarely, remembers everything, drops lore bombs",
    preview: "Fun fact: this is the same boss that wiped the party three streams ago. Different strategy this time though.",
    suggestedName: "Loremaster",
    personaSummary: "You are {{botName}}, a quiet and observant AI lorekeeper. Tone: calm, knowledgeable, slightly mysterious. You speak infrequently but when you do, it is to share relevant lore, callback references, or useful context from past streams. You observe more than you speak. Keep replies concise and meaningful. No hate speech, threats, sexual content, or harassment.",
    snarkLevel: 30, loreIntensity: 95, replyFrequency: "low",
  },
  {
    key: "custom",
    name: "Start from Scratch",
    tagline: "Define your own personality later",
    preview: "Hi chat!",
    suggestedName: "",
    personaSummary: "You are {{botName}}, a friendly AI chat bot. Keep replies concise and streamer-safe. No hate speech, threats, sexual content, or harassment.",
    snarkLevel: 50, loreIntensity: 50, replyFrequency: "medium",
  },
];

// ── Helpers ──────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── HTML renderer ────────────────────────────────────────────────────

function renderWizardPage(config: LocalConfig): string {
  const templatesJson = JSON.stringify(TEMPLATES);
  const startScreen = config.installationId ? 3 : 1;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ForgetMeNot Setup</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0c; color: #e4e4e7; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.wizard { max-width: 560px; width: 100%; padding: 16px; }
.screen { display: none; }
.screen.active { display: block; }
.card { background: #18181b; border: 1px solid #27272a; border-radius: 16px; padding: 32px; }
h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
h2 { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
.sub { font-size: 13px; color: #71717a; line-height: 1.5; margin-bottom: 20px; }
label { display: block; font-size: 11px; font-weight: 600; color: #71717a; text-transform: uppercase; letter-spacing: 0.06em; margin: 14px 0 5px; }
input, select { width: 100%; padding: 10px 14px; font-size: 13px; background: #09090b; border: 1px solid #27272a; border-radius: 8px; color: #fafafa; outline: none; font-family: inherit; }
input:focus, select:focus { border-color: #3f3f46; }
.hint { font-size: 10px; color: #52525b; margin-top: 4px; }
.nav { display: flex; gap: 10px; margin-top: 24px; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 12px 24px; font-size: 14px; font-weight: 600; border: none; border-radius: 8px; cursor: pointer; transition: background 150ms; flex: 1; }
.btn-primary { background: #7c3aed; color: #fff; }
.btn-primary:hover { background: #6d28d9; }
.btn-twitch { background: #9146ff; color: #fff; }
.btn-twitch:hover { background: #7c3aed; }
.btn-ghost { background: transparent; border: 1px solid #27272a; color: #a1a1aa; }
.btn-ghost:hover { background: #27272a; }
.btn-green { background: #22c55e; color: #000; }
.btn-green:hover { background: #16a34a; }
.btn:disabled { opacity: 0.4; cursor: default; }
.status { padding: 10px 14px; border-radius: 8px; font-size: 12px; line-height: 1.5; margin-top: 12px; }
.status-ok { background: #052e16; border: 1px solid #166534; color: #4ade80; }
.status-info { background: #172554; border: 1px solid #1e3a5f; color: #60a5fa; }
.status-err { background: #450a0a; border: 1px solid #7f1d1d; color: #f87171; }
.status-warn { background: #422006; border: 1px solid #854d0e; color: #fbbf24; }
.templates { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
.tpl { background: #09090b; border: 2px solid #27272a; border-radius: 12px; padding: 14px 16px; cursor: pointer; transition: border-color 150ms; }
.tpl:hover { border-color: #3f3f46; }
.tpl.selected { border-color: #7c3aed; }
.tpl-name { font-size: 14px; font-weight: 600; }
.tpl-tag { font-size: 11px; color: #71717a; }
.tpl-preview { font-size: 12px; color: #a1a1aa; font-style: italic; margin-top: 6px; }
.toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #1a1a1e; }
.toggle-row:last-child { border-bottom: none; }
.toggle-label { font-size: 13px; }
.toggle-desc { font-size: 11px; color: #52525b; margin-top: 2px; }
.toggle { position: relative; width: 44px; height: 24px; flex-shrink: 0; }
.toggle input { opacity: 0; width: 0; height: 0; }
.toggle .slider { position: absolute; inset: 0; background: #27272a; border-radius: 12px; cursor: pointer; transition: background 200ms; }
.toggle .slider::before { content: ''; position: absolute; width: 18px; height: 18px; left: 3px; bottom: 3px; background: #71717a; border-radius: 50%; transition: transform 200ms, background 200ms; }
.toggle input:checked + .slider { background: #7c3aed; }
.toggle input:checked + .slider::before { transform: translateX(20px); background: #fff; }
.radio-group { display: flex; flex-direction: column; gap: 6px; margin: 8px 0 16px; }
.radio-opt { display: flex; align-items: flex-start; gap: 10px; padding: 10px 14px; background: #09090b; border: 2px solid #27272a; border-radius: 10px; cursor: pointer; }
.radio-opt:hover { border-color: #3f3f46; }
.radio-opt.selected { border-color: #7c3aed; }
.radio-opt input { margin-top: 2px; accent-color: #7c3aed; }
.radio-text { font-size: 13px; }
.radio-desc { font-size: 11px; color: #52525b; }
.badge { display: inline-block; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; padding: 2px 6px; border-radius: 4px; background: #7c3aed22; color: #a78bfa; margin-left: 6px; }
.summary { font-size: 13px; line-height: 1.8; }
.summary dt { color: #71717a; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 10px; }
.summary dd { color: #fafafa; }
.step-indicator { display: flex; gap: 6px; margin-bottom: 20px; }
.step-dot { width: 8px; height: 8px; border-radius: 50%; background: #27272a; }
.step-dot.active { background: #7c3aed; }
.step-dot.done { background: #22c55e; }
</style>
</head>
<body>
<div class="wizard">

<!-- Step indicator -->
<div class="step-indicator" id="stepDots"></div>

<!-- Screen 1: Welcome -->
<section class="screen" data-screen="1">
<div class="card">
  <h1>ForgetMeNot</h1>
  <p class="sub">A local-first Twitch bot runtime that remembers your stream lore, learns your community, and keeps you in control.</p>
  <button class="btn btn-twitch" id="pairBtn" onclick="startPairing()">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 0L0 2.5V13.5H4V16L6.5 13.5H8.5L14 8V0H1.5ZM12.5 7.5L10 10H8L5.75 12.25V10H3V1.5H12.5V7.5Z"/><path d="M10.5 3.5H9V7.5H10.5V3.5Z"/><path d="M7.25 3.5H5.75V7.5H7.25V3.5Z"/></svg>
    Connect with Twitch
  </button>
  <div id="pairStatus"></div>
</div>
</section>

<!-- Screen 2: Bot Account -->
<section class="screen" data-screen="2">
<div class="card">
  <h2>Bot Account</h2>
  <p class="sub">For safety, the bot can use a separate Twitch account for chat and moderation instead of your broadcaster account.</p>
  <div id="botAccountStatus" class="status status-info">Checking...</div>
  <div class="nav">
    <button class="btn btn-ghost" onclick="wizState.botAccountSkipped=true; go(3)">Skip for now</button>
    <button class="btn btn-primary" id="botConnectBtn" onclick="connectBotAccount()">Connect Bot Account</button>
  </div>
</div>
</section>

<!-- Screen 3: Storage + AI -->
<section class="screen" data-screen="3">
<div class="card">
  <h2>Storage & AI</h2>
  <p class="sub">Where to store data and which AI provider to use.</p>
  <label>Data directory</label>
  <input type="text" id="dataDir" value="${esc(config.dataDir)}">
  <p class="hint">SQLite database, memory, and logs. Created automatically.</p>
  <label>AI Provider</label>
  <select id="aiProvider" onchange="updateProviderDefaults()">
    <option value="gemini" selected>Google Gemini</option>
    <option value="openai">OpenAI</option>
  </select>
  <label>Model</label>
  <input type="text" id="aiModel" value="gemini-2.5-flash">
  <label>API Key</label>
  <input type="password" id="llmApiKey" value="${esc(config.llmApiKey)}" placeholder="Paste your API key">
  <p class="hint" id="providerHint">Get a free key from <a href="https://aistudio.google.com/apikey" target="_blank" style="color:#60a5fa">Google AI Studio</a></p>
  <div class="nav">
    <button class="btn btn-ghost" onclick="go(2)">Back</button>
    <button class="btn btn-primary" onclick="go(4)">Next</button>
  </div>
</div>
</section>

<!-- Screen 4: Personality -->
<section class="screen" data-screen="4">
<div class="card">
  <h2>Personality</h2>
  <p class="sub">Pick a starting template. Your bot's name comes from the bot account you connected.</p>
  <div class="templates" id="templateList"></div>
  <p class="hint" id="botNameHint"></p>
  <div class="nav">
    <button class="btn btn-ghost" onclick="go(3)">Back</button>
    <button class="btn btn-primary" onclick="go(5)">Next</button>
  </div>
</div>
</section>

<!-- Screen 5: Safety -->
<section class="screen" data-screen="5">
<div class="card">
  <h2>Safety Defaults</h2>
  <p class="sub">These keep the bot well-behaved out of the gate. Change anytime from the toolkit.</p>
  <div class="toggle-row">
    <div><div class="toggle-label">Autonomous replies</div><div class="toggle-desc">Bot can reply without being @mentioned</div></div>
    <label class="toggle"><input type="checkbox" id="toggleAutonomous" checked><span class="slider"></span></label>
  </div>
  <div class="toggle-row">
    <div><div class="toggle-label">Fun moderation</div><div class="toggle-desc">Bot proposes playful mod actions</div></div>
    <label class="toggle"><input type="checkbox" id="toggleFunMod"><span class="slider"></span></label>
  </div>
  <div class="toggle-row">
    <div><div class="toggle-label">Funny timeouts</div><div class="toggle-desc">Bot can timeout viewers (with safety rails)</div></div>
    <label class="toggle"><input type="checkbox" id="toggleTimeouts"><span class="slider"></span></label>
  </div>
  <div class="toggle-row">
    <div><div class="toggle-label">Require viewer opt-in</div><div class="toggle-desc">Only timeout viewers who opted in</div></div>
    <label class="toggle"><input type="checkbox" id="toggleOptIn" checked><span class="slider"></span></label>
  </div>
  <div class="nav">
    <button class="btn btn-ghost" onclick="go(4)">Back</button>
    <button class="btn btn-primary" onclick="go(6)">Next</button>
  </div>
</div>
</section>

<!-- Screen 6: Review Preferences -->
<section class="screen" data-screen="6">
<div class="card">
  <h2>Rollout Preferences</h2>
  <p class="sub">Control how aggressive the bot is on day one. You can change these anytime.</p>
  <label>Reply mode</label>
  <div class="radio-group" id="replyModeGroup">
    <label class="radio-opt selected" onclick="selectRadio(this,'replyMode','mentions_only')">
      <input type="radio" name="replyMode" value="mentions_only" checked>
      <div><div class="radio-text">Mentions only <span class="badge">recommended</span></div><div class="radio-desc">Only replies when @mentioned by name</div></div>
    </label>
    <label class="radio-opt" onclick="selectRadio(this,'replyMode','live')">
      <input type="radio" name="replyMode" value="live">
      <div><div class="radio-text">Light autonomous</div><div class="radio-desc">Joins conversation naturally at a controlled rate</div></div>
    </label>
  </div>
  <label>Timeout mode</label>
  <div class="radio-group" id="timeoutModeGroup">
    <label class="radio-opt selected" onclick="selectRadio(this,'timeoutMode','shadow')">
      <input type="radio" name="timeoutMode" value="shadow" checked>
      <div><div class="radio-text">Shadow <span class="badge">recommended</span></div><div class="radio-desc">Logs actions but never executes them</div></div>
    </label>
    <label class="radio-opt" onclick="selectRadio(this,'timeoutMode','dry_run')">
      <input type="radio" name="timeoutMode" value="dry_run">
      <div><div class="radio-text">Dry run</div><div class="radio-desc">Announces in chat but doesn't actually timeout</div></div>
    </label>
    <label class="radio-opt" onclick="selectRadio(this,'timeoutMode','live')">
      <input type="radio" name="timeoutMode" value="live">
      <div><div class="radio-text">Live</div><div class="radio-desc">Actually executes timeouts (with all safety rails active)</div></div>
    </label>
  </div>
  <div class="nav">
    <button class="btn btn-ghost" onclick="go(5)">Back</button>
    <button class="btn btn-primary" onclick="go(7)">Next</button>
  </div>
</div>
</section>

<!-- Screen 7: Finish -->
<section class="screen" data-screen="7">
<div class="card">
  <h2>Ready to Launch</h2>
  <p class="sub">Review your setup and start the bot.</p>
  <dl class="summary" id="summaryCard"></dl>
  <div id="finishStatus"></div>
  <div class="nav">
    <button class="btn btn-ghost" onclick="go(6)">Back</button>
    <button class="btn btn-green" id="launchBtn" onclick="finish()">Launch Bot</button>
  </div>
</div>
</section>

</div>

<script>
const TEMPLATES = ${templatesJson};
const authUrl = ${JSON.stringify(config.authUrl)};
let currentScreen = ${startScreen};
let botPollTimer = null;

// Wizard state — accumulated across screens
const wizState = {
  paired: ${config.installationId ? "true" : "false"},
  botAccountConnected: false, botAccountLogin: null, botAccountDisplayName: null, botAccountSkipped: false,
  dataDir: ${JSON.stringify(config.dataDir)},
  llmApiKey: ${JSON.stringify(config.llmApiKey)},
  aiProvider: 'gemini', aiModel: 'gemini-2.5-flash',
  templateKey: 'bratty',
  personaSummary: TEMPLATES[0].personaSummary,
  snarkLevel: TEMPLATES[0].snarkLevel, loreIntensity: TEMPLATES[0].loreIntensity,
  replyFrequency: TEMPLATES[0].replyFrequency,
  autonomousRepliesEnabled: true, funModerationEnabled: false,
  funnyTimeoutEnabled: false, optInRequired: true,
  replyMode: 'mentions_only', timeoutMode: 'shadow',
};

// ── Navigation ──
function go(n) {
  // Save current screen state before navigating
  saveScreenState(currentScreen);
  currentScreen = n;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.querySelector('[data-screen="'+n+'"]');
  if (el) el.classList.add('active');
  updateDots();
  if (n === 2) startBotAccountPoll();
  if (n === 7) renderSummary();
  if (n !== 2 && botPollTimer) { clearInterval(botPollTimer); botPollTimer = null; }
}

function updateDots() {
  const dots = document.getElementById('stepDots');
  dots.innerHTML = '';
  for (let i = 1; i <= 7; i++) {
    const d = document.createElement('div');
    d.className = 'step-dot' + (i === currentScreen ? ' active' : i < currentScreen ? ' done' : '');
    dots.appendChild(d);
  }
}

function saveScreenState(n) {
  if (n === 3) {
    wizState.dataDir = document.getElementById('dataDir').value;
    wizState.llmApiKey = document.getElementById('llmApiKey').value;
    wizState.aiProvider = document.getElementById('aiProvider').value;
    wizState.aiModel = document.getElementById('aiModel').value;
  }
  // Screen 4: nothing to save — botName comes from the connected bot account
  // (auto-filled server-side). Template selection updates wizState directly.
  if (n === 5) {
    wizState.autonomousRepliesEnabled = document.getElementById('toggleAutonomous').checked;
    wizState.funModerationEnabled = document.getElementById('toggleFunMod').checked;
    wizState.funnyTimeoutEnabled = document.getElementById('toggleTimeouts').checked;
    wizState.optInRequired = document.getElementById('toggleOptIn').checked;
  }
  if (n === 6) {
    wizState.replyMode = document.querySelector('input[name="replyMode"]:checked')?.value || 'mentions_only';
    wizState.timeoutMode = document.querySelector('input[name="timeoutMode"]:checked')?.value || 'shadow';
  }
}

// ── Screen 1: Pairing ──
async function startPairing() {
  const btn = document.getElementById('pairBtn');
  const st = document.getElementById('pairStatus');
  btn.disabled = true; btn.textContent = 'Connecting...';
  try {
    await fetch('/setup/pair', { method: 'POST' });
    pollPairing();
  } catch(e) {
    st.className = 'status status-err'; st.textContent = 'Error: ' + e.message;
    btn.disabled = false; btn.textContent = 'Connect with Twitch';
  }
}

function pollPairing() {
  const iv = setInterval(async () => {
    try {
      const r = await fetch('/setup/pair/status');
      const d = await r.json();
      const st = document.getElementById('pairStatus');
      if (d.status === 'polling' && d.pairingCode) {
        st.className = 'status status-info';
        st.innerHTML = 'Waiting for Twitch login... <strong>' + d.pairingCode + '</strong>';
      } else if (d.status === 'complete') {
        clearInterval(iv);
        wizState.paired = true;
        st.className = 'status status-ok'; st.textContent = 'Connected!';
        setTimeout(() => go(2), 800);
      } else if (d.status === 'expired' || d.status === 'error') {
        clearInterval(iv);
        st.className = 'status status-err'; st.textContent = d.error || 'Pairing failed. Try again.';
        const btn = document.getElementById('pairBtn');
        btn.disabled = false; btn.textContent = 'Try Again';
      }
    } catch {}
  }, 1500);
}

// ── Screen 2: Bot account ──
function connectBotAccount() {
  window.open(authUrl + '/bot-account/auth', '_blank');
}

function startBotAccountPoll() {
  const st = document.getElementById('botAccountStatus');
  if (wizState.botAccountConnected) {
    st.className = 'status status-ok';
    st.textContent = 'Bot account connected: ' + (wizState.botAccountDisplayName || wizState.botAccountLogin);
    updateBotNameHint(wizState.botAccountDisplayName || wizState.botAccountLogin);
    return;
  }
  st.className = 'status status-info'; st.textContent = 'No bot account connected yet.';
  updateBotNameHint(null);
  if (botPollTimer) clearInterval(botPollTimer);
  botPollTimer = setInterval(async () => {
    try {
      const r = await fetch('/wizard/bot-account/status');
      const d = await r.json();
      if (d.connected) {
        clearInterval(botPollTimer); botPollTimer = null;
        wizState.botAccountConnected = true;
        wizState.botAccountLogin = d.login;
        wizState.botAccountDisplayName = d.displayName || d.login;
        st.className = 'status status-ok';
        st.textContent = 'Bot account connected: ' + wizState.botAccountDisplayName;
        updateBotNameHint(wizState.botAccountDisplayName);
      }
    } catch {}
  }, 3000);
}

// ── Screen 3: AI provider ──
function updateProviderDefaults() {
  const prov = document.getElementById('aiProvider').value;
  const model = document.getElementById('aiModel');
  const hint = document.getElementById('providerHint');
  if (prov === 'gemini') {
    model.value = 'gemini-2.5-flash';
    hint.innerHTML = 'Get a free key from <a href="https://aistudio.google.com/apikey" target="_blank" style="color:#60a5fa">Google AI Studio</a>';
  } else {
    model.value = 'gpt-4o-mini';
    hint.innerHTML = 'Get a key from <a href="https://platform.openai.com/api-keys" target="_blank" style="color:#60a5fa">OpenAI</a>';
  }
}

// ── Screen 4: Templates ──
function renderTemplates() {
  const list = document.getElementById('templateList');
  TEMPLATES.forEach((t, i) => {
    const div = document.createElement('div');
    div.className = 'tpl' + (i === 0 ? ' selected' : '');
    div.dataset.key = t.key;
    div.innerHTML = '<div class="tpl-name">' + t.name + '</div><div class="tpl-tag">' + t.tagline + '</div><div class="tpl-preview">"' + t.preview + '"</div>';
    div.onclick = () => selectTemplate(t.key);
    list.appendChild(div);
  });
}

function selectTemplate(key) {
  const t = TEMPLATES.find(t => t.key === key);
  if (!t) return;
  wizState.templateKey = key;
  wizState.personaSummary = t.personaSummary;
  wizState.snarkLevel = t.snarkLevel;
  wizState.loreIntensity = t.loreIntensity;
  wizState.replyFrequency = t.replyFrequency;
  document.querySelectorAll('.tpl').forEach(el => el.classList.toggle('selected', el.dataset.key === key));
}

// Update the "Your bot's name is …" hint on Screen 4 based on whether the
// bot account is connected. Called from the bot account poll loop.
function updateBotNameHint(displayName) {
  const el = document.getElementById('botNameHint');
  if (!el) return;
  if (displayName) {
    el.innerHTML = 'In chat your bot will appear as <strong>' + esc(displayName) + '</strong>.';
  } else {
    el.textContent = 'No bot account connected. The bot can still observe chat, but it cannot send replies until you connect one.';
  }
}

// ── Screen 6: Radio groups ──
function selectRadio(el, name, value) {
  el.closest('.radio-group').querySelectorAll('.radio-opt').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
  el.querySelector('input').checked = true;
  wizState[name === 'replyMode' ? 'replyMode' : 'timeoutMode'] = value;
}

// ── Screen 7: Summary + Finish ──
function renderSummary() {
  saveScreenState(currentScreen - 1);
  const tpl = TEMPLATES.find(t => t.key === wizState.templateKey);
  const card = document.getElementById('summaryCard');
  const botNameDisplay = wizState.botAccountDisplayName || wizState.botAccountLogin || '(no bot account connected)';
  card.innerHTML =
    '<dt>Bot</dt><dd>' + esc(botNameDisplay) + '</dd>' +
    '<dt>Personality</dt><dd>' + (tpl ? tpl.name : 'Custom') + '</dd>' +
    '<dt>AI</dt><dd>' + wizState.aiProvider + ' / ' + wizState.aiModel + '</dd>' +
    '<dt>Reply mode</dt><dd>' + wizState.replyMode.replace('_', ' ') + '</dd>' +
    '<dt>Timeout mode</dt><dd>' + wizState.timeoutMode.replace('_', ' ') + '</dd>' +
    '<dt>Autonomous replies</dt><dd>' + (wizState.autonomousRepliesEnabled ? 'On' : 'Off') + '</dd>' +
    '<dt>Fun moderation</dt><dd>' + (wizState.funModerationEnabled ? 'On' : 'Off') + '</dd>' +
    '<dt>Opt-in required</dt><dd>' + (wizState.optInRequired ? 'Yes' : 'No') + '</dd>' +
    '<dt>Data directory</dt><dd style="font-size:11px;word-break:break-all">' + esc(wizState.dataDir) + '</dd>';
}

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function finish() {
  const btn = document.getElementById('launchBtn');
  const st = document.getElementById('finishStatus');
  btn.disabled = true; btn.textContent = 'Saving...';
  st.innerHTML = '';

  // Persona keeps the {{botName}} token — the runtime substitutes it at
  // prompt time using whatever the auth worker has for botName (auto-filled
  // from the bot account when connected). We don't send botName or botAliases
  // ourselves — the auth worker owns those and derives them from the bot's
  // actual Twitch identity.
  const payload = {
    local: {
      dataDir: wizState.dataDir,
      llmApiKey: wizState.llmApiKey,
      replyMode: wizState.replyMode,
      timeoutMode: wizState.timeoutMode,
    },
    settings: {
      personaSummary: wizState.personaSummary,
      snarkLevel: wizState.snarkLevel,
      loreIntensity: wizState.loreIntensity,
      replyFrequency: wizState.replyFrequency,
      aiProvider: wizState.aiProvider,
      aiModel: wizState.aiModel,
    },
    policy: {
      autonomousRepliesEnabled: wizState.autonomousRepliesEnabled,
      funModerationEnabled: wizState.funModerationEnabled,
      funnyTimeoutEnabled: wizState.funnyTimeoutEnabled,
      optInRequired: wizState.optInRequired,
      safeMode: false,
    },
  };

  try {
    const r = await fetch('/wizard/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (d.ok) {
      st.className = 'status status-ok';
      st.innerHTML = 'Bot is running! <a href="${esc(config.authUrl.replace("auth.", "toolkit."))}/tools/chat-bot" target="_blank" style="color:#4ade80">Open toolkit dashboard</a>';
      btn.textContent = 'Running';
    } else {
      throw new Error(d.error || 'Save failed (step: ' + (d.step||'unknown') + ')');
    }
  } catch(e) {
    st.className = 'status status-err';
    st.textContent = 'Error: ' + e.message;
    btn.disabled = false; btn.textContent = 'Retry';
  }
}

// ── Init ──
renderTemplates();
go(${startScreen});
</script>
</body>
</html>`;
}
