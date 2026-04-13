/**
 * First-run setup page — served on localhost when no config exists
 * or when installationId is empty.
 *
 * Primary action: "Connect with Twitch" (device-code pairing flow).
 * Advanced: manual credential entry for power users.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { saveConfig, type LocalConfig } from "../runtime/config.js";

export function handleSetupRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  currentConfig: LocalConfig,
  onConfigSaved: (config: LocalConfig) => void,
): boolean {
  if (url.pathname === "/setup" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderSetupPage(currentConfig));
    return true;
  }

  if (url.pathname === "/setup" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as Partial<LocalConfig>;
        const updated: LocalConfig = {
          authUrl: parsed.authUrl?.trim() || currentConfig.authUrl,
          installationId: parsed.installationId?.trim() || currentConfig.installationId,
          installationSecret: parsed.installationSecret?.trim() || currentConfig.installationSecret,
          dataDir: parsed.dataDir?.trim() || currentConfig.dataDir,
          llmApiKey: parsed.llmApiKey?.trim() || currentConfig.llmApiKey,
          replyMode: currentConfig.replyMode,
          timeoutMode: currentConfig.timeoutMode,
          wizardCompleted: currentConfig.wizardCompleted,
        };

        saveConfig(updated);
        onConfigSaved(updated);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, dataDir: updated.dataDir }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Invalid input" }));
      }
    });
    return true;
  }

  return false;
}

function renderSetupPage(config: LocalConfig): string {
  const isConfigured = !!(config.installationId && config.installationSecret);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ForgetMeNot Setup</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0c; color: #e4e4e7; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: #18181b; border: 1px solid #27272a; border-radius: 16px; padding: 32px; max-width: 520px; width: 100%; }
  h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
  .subtitle { font-size: 13px; color: #71717a; margin-bottom: 24px; }
  .section { margin-top: 24px; }
  .section-title { font-size: 12px; font-weight: 600; color: #71717a; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 12px; }
  label { display: block; font-size: 11px; font-weight: 600; color: #71717a; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; margin-top: 16px; }
  input, textarea { width: 100%; padding: 10px 14px; font-size: 13px; background: #09090b; border: 1px solid #27272a; border-radius: 8px; color: #fafafa; outline: none; font-family: inherit; }
  input:focus, textarea:focus { border-color: #3f3f46; }
  .hint { font-size: 10px; color: #52525b; margin-top: 4px; }
  .btn { display: inline-flex; align-items: center; gap: 8px; padding: 12px 24px; font-size: 14px; font-weight: 600; border: none; border-radius: 8px; cursor: pointer; transition: background 150ms; }
  .btn-twitch { background: #9146ff; color: #fff; width: 100%; justify-content: center; }
  .btn-twitch:hover { background: #7c3aed; }
  .btn-twitch:disabled { background: #27272a; color: #52525b; cursor: default; }
  .btn-primary { background: #22c55e; color: #000; }
  .btn-primary:hover { background: #16a34a; }
  .btn-primary:disabled { background: #27272a; color: #52525b; cursor: default; }
  .btn-sm { padding: 10px 20px; font-size: 13px; }
  .status { margin-top: 16px; padding: 10px 14px; border-radius: 8px; font-size: 12px; line-height: 1.5; }
  .status-ok { background: #052e16; border: 1px solid #166534; color: #4ade80; }
  .status-info { background: #172554; border: 1px solid #1e3a5f; color: #60a5fa; }
  .status-err { background: #450a0a; border: 1px solid #7f1d1d; color: #f87171; }
  .status-warn { background: #422006; border: 1px solid #854d0e; color: #fbbf24; }
  .pairing-code { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 18px; font-weight: 700; letter-spacing: 0.1em; color: #fafafa; }
  .configured { color: #4ade80; font-size: 11px; }
  .unconfigured { color: #f87171; font-size: 11px; }
  .divider { border: none; border-top: 1px solid #27272a; margin: 24px 0; }
  .advanced-toggle { background: none; border: none; color: #71717a; font-size: 12px; cursor: pointer; padding: 4px 0; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
  .advanced-toggle:hover { color: #a1a1aa; }
  .advanced-content { display: none; }
  .advanced-content.open { display: block; }
</style>
</head>
<body>
<div class="card">
  <h1>ForgetMeNot</h1>
  <p class="subtitle">
    ${isConfigured ? '<span class="configured">● Connected</span>' : '<span class="unconfigured">● Not connected</span>'}
  </p>

  <!-- Primary: Connect with Twitch -->
  <div id="pairingSection">
    <button class="btn btn-twitch" id="pairBtn" onclick="startPairing()" ${isConfigured ? 'style="display:none"' : ""}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 0L0 2.5V13.5H4V16L6.5 13.5H8.5L14 8V0H1.5ZM12.5 7.5L10 10H8L5.75 12.25V10H3V1.5H12.5V7.5Z"/><path d="M10.5 3.5H9V7.5H10.5V3.5Z"/><path d="M7.25 3.5H5.75V7.5H7.25V3.5Z"/></svg>
      Connect with Twitch
    </button>
    <div id="pairingStatus"></div>
  </div>

  <hr class="divider">

  <!-- Always visible: Data dir + LLM key -->
  <label>Data directory</label>
  <input type="text" id="dataDir" value="${escapeHtml(config.dataDir)}" placeholder="C:\\Users\\You\\AppData\\Local\\ForgetMeNot">
  <p class="hint">Where SQLite database, memory, and logs are stored.</p>

  <label>LLM API Key</label>
  <input type="password" id="llmApiKey" value="${escapeHtml(config.llmApiKey)}" placeholder="Gemini or OpenAI API key">
  <p class="hint">Your own key. Get one from <a href="https://aistudio.google.com/apikey" target="_blank" style="color: #60a5fa;">Google AI Studio</a> (free) or <a href="https://platform.openai.com/api-keys" target="_blank" style="color: #60a5fa;">OpenAI</a>.</p>

  <!-- Collapsible: Manual credentials -->
  <hr class="divider">
  <button class="advanced-toggle" onclick="toggleAdvanced()">&#9654; Advanced / Manual Setup</button>
  <div id="advancedContent" class="advanced-content">
    <label>Installation ID</label>
    <input type="text" id="installationId" value="${escapeHtml(config.installationId)}" placeholder="Paste from toolkit">

    <label>Installation Secret</label>
    <input type="password" id="installationSecret" value="${escapeHtml(config.installationSecret)}" placeholder="Paste from toolkit">
    <p class="hint">From the toolkit Chat Bot → Settings → ForgetMeNot connections.</p>

    <label>Auth URL</label>
    <input type="text" id="authUrl" value="${escapeHtml(config.authUrl)}" placeholder="https://auth.deutschmark.online">
    <p class="hint">Leave default unless you're self-hosting.</p>

    <button class="btn btn-primary btn-sm" id="saveBtn" onclick="saveConfig()" style="margin-top: 16px">Save</button>
  </div>

  <div id="saveStatus"></div>
</div>

<script>
let pairingPollTimer = null;

async function startPairing() {
  const btn = document.getElementById('pairBtn');
  const status = document.getElementById('pairingStatus');
  btn.disabled = true;
  btn.textContent = 'Starting...';

  try {
    const res = await fetch('/setup/pair', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start pairing');
    // Start polling for status
    pollPairingStatus();
  } catch (err) {
    status.className = 'status status-err';
    status.textContent = 'Error: ' + err.message;
    btn.disabled = false;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 0L0 2.5V13.5H4V16L6.5 13.5H8.5L14 8V0H1.5ZM12.5 7.5L10 10H8L5.75 12.25V10H3V1.5H12.5V7.5Z"/><path d="M10.5 3.5H9V7.5H10.5V3.5Z"/><path d="M7.25 3.5H5.75V7.5H7.25V3.5Z"/></svg> Connect with Twitch';
  }
}

function pollPairingStatus() {
  if (pairingPollTimer) clearInterval(pairingPollTimer);
  pairingPollTimer = setInterval(async () => {
    try {
      const res = await fetch('/setup/pair/status');
      const data = await res.json();
      const status = document.getElementById('pairingStatus');
      const btn = document.getElementById('pairBtn');

      if (data.status === 'polling' && data.pairingCode) {
        const expires = data.expiresAt ? new Date(data.expiresAt) : null;
        const secsLeft = expires ? Math.max(0, Math.round((expires.getTime() - Date.now()) / 1000)) : '?';
        const mins = Math.floor(secsLeft / 60);
        const secs = secsLeft % 60;
        status.className = 'status status-info';
        status.innerHTML = 'Waiting for Twitch login&hellip; <span class="pairing-code">' + data.pairingCode + '</span><br>Expires in ' + mins + 'm ' + secs + 's';
        btn.style.display = 'none';
      } else if (data.status === 'complete') {
        clearInterval(pairingPollTimer);
        status.className = 'status status-ok';
        status.textContent = 'Paired! ForgetMeNot is starting...';
        btn.style.display = 'none';
      } else if (data.status === 'expired') {
        clearInterval(pairingPollTimer);
        status.className = 'status status-warn';
        status.textContent = 'Pairing expired. Try again.';
        btn.disabled = false;
        btn.style.display = '';
        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 0L0 2.5V13.5H4V16L6.5 13.5H8.5L14 8V0H1.5ZM12.5 7.5L10 10H8L5.75 12.25V10H3V1.5H12.5V7.5Z"/><path d="M10.5 3.5H9V7.5H10.5V3.5Z"/><path d="M7.25 3.5H5.75V7.5H7.25V3.5Z"/></svg> Try Again';
      } else if (data.status === 'error') {
        clearInterval(pairingPollTimer);
        status.className = 'status status-err';
        status.textContent = 'Error: ' + (data.error || 'Unknown error');
        btn.disabled = false;
        btn.style.display = '';
        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 0L0 2.5V13.5H4V16L6.5 13.5H8.5L14 8V0H1.5ZM12.5 7.5L10 10H8L5.75 12.25V10H3V1.5H12.5V7.5Z"/><path d="M10.5 3.5H9V7.5H10.5V3.5Z"/><path d="M7.25 3.5H5.75V7.5H7.25V3.5Z"/></svg> Try Again';
      }
    } catch { /* network error, keep polling */ }
  }, 1500);
}

function toggleAdvanced() {
  const el = document.getElementById('advancedContent');
  const btn = el.previousElementSibling;
  const isOpen = el.classList.toggle('open');
  btn.innerHTML = (isOpen ? '&#9660;' : '&#9654;') + ' Advanced / Manual Setup';
}

async function saveConfig() {
  const btn = document.getElementById('saveBtn');
  const status = document.getElementById('saveStatus');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const res = await fetch('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dataDir: document.getElementById('dataDir').value,
        installationId: document.getElementById('installationId').value,
        installationSecret: document.getElementById('installationSecret').value,
        llmApiKey: document.getElementById('llmApiKey').value,
        authUrl: document.getElementById('authUrl').value,
      }),
    });

    const data = await res.json();
    if (data.ok) {
      status.className = 'status status-ok';
      status.textContent = 'Saved! ForgetMeNot is starting...';
      btn.textContent = 'Saved';
    } else {
      throw new Error(data.error || 'Save failed');
    }
  } catch (err) {
    status.className = 'status status-err';
    status.textContent = 'Error: ' + err.message;
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
