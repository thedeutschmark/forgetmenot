// ForgetMeNot tray — small Windows tray app that:
//   - spawns and supervises the forgetmenot.exe runtime
//   - polls /health every 10s, updates icon color
//   - menu: status, open dashboard, pause/resume replies, toggle safe mode,
//     restart runtime, quit
//
// Build:  go build -ldflags="-H windowsgui" -o forgetmenot.exe
package main

import (
	_ "embed"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/getlantern/systray"
	"golang.org/x/sys/windows"
)

const (
	healthURL    = "http://127.0.0.1:7331/health"
	pauseURL     = "http://127.0.0.1:7331/control/pause"
	resumeURL    = "http://127.0.0.1:7331/control/resume"
	safeModeURL  = "http://127.0.0.1:7331/control/safe-mode"
	dashboardURL = "https://toolkit.deutschmark.online/tools/chat-bot"
	pollInterval = 10 * time.Second
	mutexName    = "Global\\ForgetMeNotTraySingleInstance"
)

// Embedded flower icons (center color carries runtime status)
//
// Color semantics (as of the yellow-healthy remap):
//   loading  blue    — runtime starting or waiting on auth bundle
//   healthy  yellow  — all subsystems up
//   degraded orange  — partial degradation (NOT yellow — kept visually
//                      distinct from healthy so "mostly fine" doesn't
//                      read as "all fine" at a glance)
//   error    red     — runtime unreachable or hard failure
//   paused   gray    — engine shadowed by user (control surface)
//go:embed icons/loading.ico
var iconLoading []byte

//go:embed icons/healthy.ico
var iconHealthy []byte

//go:embed icons/degraded.ico
var iconDegraded []byte

//go:embed icons/error.ico
var iconError []byte

//go:embed icons/paused.ico
var iconPaused []byte

// ── Health response shape (matches services/forgetmenot health.ts) ──
type HealthStatus struct {
	Status           string   `json:"status"` // "ok" | "degraded" | "error"
	Uptime           int      `json:"uptime"`
	SafeMode         bool     `json:"safeMode"`
	Paused           bool     `json:"paused"`
	EngineMode       *string  `json:"engineMode"`
	BotConnected     bool     `json:"botConnected"`
	BotLogin         *string  `json:"botLogin"`
	BotDisplayName   *string  `json:"botDisplayName"`
	LlmKeyConfigured bool     `json:"llmKeyConfigured"`
	Issues           []string `json:"issues"`
}

// ── Module state (single tray instance, single runtime child) ──
var (
	runtimeCmd    *exec.Cmd
	runtimeMu     sync.Mutex
	currentHealth *HealthStatus
	healthMu      sync.RWMutex

	// Menu items (stored so we can update labels live)
	mStatus   *systray.MenuItem
	mPause    *systray.MenuItem
	mSafeMode *systray.MenuItem

	// One-shot: open the localhost landing automatically on the FIRST
	// health response after tray startup, but only when the runtime looks
	// not-yet-ready (no bot account connected, or explicit error state).
	// Once the bot is running healthy with a connected account, further
	// launches should be quiet — no browser pop-up every time.
	autoOpenedLanding bool
	autoOpenMu        sync.Mutex
)

func main() {
	// If a previous in-place upgrade left .old or .new files, clean them up
	// before doing anything else (must run before single-instance, since the
	// single-instance check would block a relaunched-after-update process).
	cleanupPriorSwap()

	// Single-instance: acquire a Windows mutex
	if !acquireSingleInstance() {
		// Another tray is running. Exit silently.
		return
	}

	// Set up Windows job object so the runtime is killed when the tray dies
	// (even on force-kill / log off / crash). Logged but non-fatal — fall back
	// to manual cleanup in stopRuntime if this fails.
	if err := initJobObject(); err != nil {
		fmt.Fprintf(os.Stderr, "warning: job object setup failed: %v\n", err)
	}

	systray.Run(onReady, onExit)
}

// ── Single instance ──
func acquireSingleInstance() bool {
	name, err := windows.UTF16PtrFromString(mutexName)
	if err != nil {
		return true // be permissive on conversion failure
	}
	_, err = windows.CreateMutex(nil, false, name)
	if err == windows.ERROR_ALREADY_EXISTS {
		return false
	}
	return true
}

// ── Tray lifecycle ──
func onReady() {
	systray.SetIcon(iconLoading) // "starting / waiting on bundle" state
	systray.SetTitle("ForgetMeNot")
	systray.SetTooltip("ForgetMeNot — loading...")

	// Status (disabled, used as a label)
	mStatus = systray.AddMenuItem("Starting...", "Runtime status")
	mStatus.Disable()

	systray.AddSeparator()

	mDashboard := systray.AddMenuItem("Open Review Dashboard", "Open toolkit dashboard in browser")
	mPause = systray.AddMenuItem("Pause Replies", "Stop the bot from sending replies (logs only)")
	mSafeMode = systray.AddMenuItem("Safe Mode", "Toggle safe mode (review all actions)")

	systray.AddSeparator()

	mRestart := systray.AddMenuItem("Restart Runtime", "Restart the bot runtime")
	mQuit := systray.AddMenuItem("Quit", "Stop the bot and exit")

	// Spawn runtime
	if err := startRuntime(); err != nil {
		showError(fmt.Sprintf("Failed to start runtime:\n%s\n\nLooked for forgetmenot.exe.", err))
		systray.Quit()
		return
	}

	// Start polling health
	go pollHealth()

	// Start the GitHub release update checker (explicit-consent only —
	// adds tray menu items when an update is available, never auto-applies)
	startUpdateChecker()

	// Handle menu clicks in a loop
	go func() {
		for {
			select {
			case <-mDashboard.ClickedCh:
				openBrowser(dashboardURL)
			case <-mPause.ClickedCh:
				togglePause()
			case <-mSafeMode.ClickedCh:
				toggleSafeMode()
			case <-mRestart.ClickedCh:
				restartRuntime()
			case <-mQuit.ClickedCh:
				systray.Quit()
				return
			}
		}
	}()

	// Handle Ctrl+C / SIGTERM (kills runtime before exit)
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
		<-sigCh
		systray.Quit()
	}()
}

func onExit() {
	stopRuntime()
}

// ── Runtime subprocess management ──

// runtimePath extracts the embedded runtime to disk if needed and returns its path.
// Always returns the same location: %LOCALAPPDATA%/ForgetMeNot/runtime/forgetmenot.exe
func runtimePath() (string, error) {
	return extractRuntimeIfNeeded()
}

func startRuntime() error {
	runtimeMu.Lock()
	defer runtimeMu.Unlock()

	if runtimeCmd != nil && runtimeCmd.ProcessState == nil {
		return nil // already running
	}

	path, err := runtimePath()
	if err != nil {
		return err
	}

	logPath := filepath.Join(os.Getenv("LOCALAPPDATA"), "ForgetMeNot", "runtime.log")
	_ = os.MkdirAll(filepath.Dir(logPath), 0755)
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		logFile = nil
	}

	cmd := exec.Command(path)
	if logFile != nil {
		cmd.Stdout = logFile
		cmd.Stderr = logFile
	}
	// Hide console window on Windows
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW

	if err := cmd.Start(); err != nil {
		return err
	}
	runtimeCmd = cmd

	// Assign to job object — runtime will be killed if tray dies for any reason
	if err := assignToJob(cmd.Process); err != nil {
		fmt.Fprintf(os.Stderr, "warning: failed to assign runtime to job: %v\n", err)
	}

	// Reap when it exits (so ProcessState gets populated)
	go func() {
		_ = cmd.Wait()
	}()

	return nil
}

func stopRuntime() {
	runtimeMu.Lock()
	defer runtimeMu.Unlock()

	if runtimeCmd == nil || runtimeCmd.Process == nil {
		return
	}

	// Try graceful first (Windows: just Kill — there's no SIGTERM equivalent for child processes)
	_ = runtimeCmd.Process.Kill()

	// Wait up to 5s for it to exit
	done := make(chan struct{})
	go func() {
		_, _ = runtimeCmd.Process.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
	runtimeCmd = nil
}

func restartRuntime() {
	stopRuntime()
	time.Sleep(500 * time.Millisecond) // let port :7331 release
	if err := startRuntime(); err != nil {
		showError("Failed to restart runtime: " + err.Error())
	}
}

// ── Health polling + UI updates ──

func pollHealth() {
	// Initial delay so runtime has time to start
	time.Sleep(2 * time.Second)
	tick := time.NewTicker(pollInterval)
	defer tick.Stop()
	fetchAndUpdate()
	for range tick.C {
		fetchAndUpdate()
	}
}

func fetchAndUpdate() {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(healthURL)
	if err != nil {
		setUnreachable()
		return
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		setUnreachable()
		return
	}

	var h HealthStatus
	if err := json.Unmarshal(body, &h); err != nil {
		setUnreachable()
		return
	}

	healthMu.Lock()
	currentHealth = &h
	healthMu.Unlock()

	updateUI(&h)

	// First-run auto-open: if this is the first health response we've
	// received AND the runtime looks not-ready (no bot account connected),
	// open the local landing so the user can finish setup without having
	// to remember the URL or hunt for the tray menu. After any first
	// successful open, this is skipped for the rest of this tray lifetime.
	maybeAutoOpenLanding(&h)
}

func maybeAutoOpenLanding(h *HealthStatus) {
	autoOpenMu.Lock()
	defer autoOpenMu.Unlock()
	if autoOpenedLanding {
		return
	}
	// "Fully ready" = bot account connected AND LLM API key present.
	// Either one missing means the runtime can't actually reply to chat,
	// so we open toolkit (the source of truth for setup) so the user can
	// finish setup there. Toolkit handles broadcaster login + install
	// state; localhost is only used for the AI-key step inside toolkit.
	fullyReady := h.BotConnected && h.LlmKeyConfigured
	autoOpenedLanding = true
	if !fullyReady {
		openBrowser(dashboardURL)
	}
}

func setUnreachable() {
	systray.SetIcon(iconError)
	systray.SetTooltip("ForgetMeNot — runtime not reachable")
	if mStatus != nil {
		mStatus.SetTitle("Runtime unreachable")
	}
}

func updateUI(h *HealthStatus) {
	// Icon
	switch {
	case h.Paused:
		systray.SetIcon(iconPaused)
	case h.Status == "error":
		systray.SetIcon(iconError)
	case h.Status == "degraded":
		systray.SetIcon(iconDegraded)
	default:
		systray.SetIcon(iconHealthy)
	}

	// Tooltip
	//   healthy:     "ForgetMeNot — Auto_Mark connected"
	//   no bot:      "ForgetMeNot — no bot account connected"
	//   degraded:    "ForgetMeNot — degraded · Auto_Mark connected"
	//   paused:      "ForgetMeNot — paused · Auto_Mark"
	base := "ForgetMeNot"
	var botTag string
	switch {
	case !h.BotConnected:
		botTag = "no bot account connected"
	case h.BotDisplayName != nil && *h.BotDisplayName != "":
		botTag = *h.BotDisplayName + " connected"
	case h.BotLogin != nil && *h.BotLogin != "":
		botTag = *h.BotLogin + " connected"
	default:
		// bot flagged connected but names missing — rare edge, still show something
		botTag = "bot connected"
	}

	var tip string
	switch {
	case h.Paused:
		tip = base + " — paused · " + botTag
	case h.Status == "ok":
		tip = base + " — " + botTag
	default:
		tip = base + " — " + h.Status + " · " + botTag
	}
	systray.SetTooltip(tip)

	// Status label
	if mStatus != nil {
		label := capitalize(h.Status)
		if len(h.Issues) > 0 {
			label = label + " — " + h.Issues[0]
		}
		if h.Paused {
			label = "Paused (was " + safeStr(h.EngineMode) + ")"
		}
		mStatus.SetTitle(label)
	}

	// Pause label
	if mPause != nil {
		if h.Paused {
			mPause.SetTitle("Resume Replies")
		} else {
			mPause.SetTitle("Pause Replies")
		}
	}

	// Safe mode checkbox
	if mSafeMode != nil {
		if h.SafeMode {
			mSafeMode.Check()
		} else {
			mSafeMode.Uncheck()
		}
	}
}

// ── Menu actions ──

func togglePause() {
	healthMu.RLock()
	paused := currentHealth != nil && currentHealth.Paused
	healthMu.RUnlock()

	url := pauseURL
	if paused {
		url = resumeURL
	}
	if _, err := postEmpty(url); err != nil {
		showError("Failed: " + err.Error())
		return
	}
	// Refresh status immediately
	go fetchAndUpdate()
}

func toggleSafeMode() {
	healthMu.RLock()
	enabled := currentHealth != nil && !currentHealth.SafeMode
	healthMu.RUnlock()

	body, _ := json.Marshal(map[string]bool{"enabled": enabled})
	if _, err := postJSON(safeModeURL, body); err != nil {
		showError("Failed to toggle safe mode: " + err.Error())
		return
	}
	go fetchAndUpdate()
}

// ── HTTP helpers ──

func postEmpty(url string) ([]byte, error) {
	return postJSON(url, []byte("{}"))
}

func postJSON(url string, body []byte) ([]byte, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Post(url, "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return respBody, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(respBody))
	}
	return respBody, nil
}

// ── Misc helpers ──

func openBrowser(url string) {
	_ = exec.Command("cmd", "/c", "start", "", url).Start()
}

func showError(msg string) {
	// Simple Windows MessageBox via PowerShell — adequate for rare error dialogs.
	_ = exec.Command("powershell", "-Command",
		fmt.Sprintf(`Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(%q, 'ForgetMeNot')`, msg),
	).Start()
}

func capitalize(s string) string {
	if s == "" {
		return s
	}
	return string(s[0]-32) + s[1:]
}

func safeStr(p *string) string {
	if p == nil {
		return "unknown"
	}
	return *p
}
