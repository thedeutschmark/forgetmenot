// Update checker — polls thedeutschmark/forgetmenot GitHub releases on
// startup. If a newer release is found, two tray menu items are added:
//
//	"Update available: vX.Y.Z — view changelog"  → opens the release page
//	"Install update & restart"                   → downloads + swaps + restarts
//
// Updates are NEVER applied silently. The user must click "Install" to apply.
//
// Swap mechanics on Windows: the running exe file can be renamed (Windows
// allows renaming a file in use). We rename current to .old, place the
// downloaded .new at the original path, spawn it detached, then quit the
// current tray. On the next clean startup, .old is deleted.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/getlantern/systray"
)

const (
	releasesAPIURL  = "https://api.github.com/repos/thedeutschmark/forgetmenot/releases/latest"
	updateUserAgent = "forgetmenot-tray-updater"
)

// Version is the version string for this build. Overridden at build time
// via -ldflags="-X main.Version=v0.1.0". "dev" means "running from a local
// build" — update checks still run but a missing 'v' prefix in the local
// version means everything from GitHub looks newer; we guard against that.
var Version = "dev"

// githubRelease is the slice of the GitHub Releases API response we care about.
type githubRelease struct {
	TagName string                `json:"tag_name"`
	HTMLURL string                `json:"html_url"`
	Body    string                `json:"body"`
	Assets  []githubReleaseAsset  `json:"assets"`
}

type githubReleaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

var (
	pendingUpdate     *githubRelease
	pendingUpdateMu   sync.RWMutex
	mUpdateChangelog  *systray.MenuItem
	mUpdateInstall    *systray.MenuItem
)

// startUpdateChecker runs the update check on startup, and again every 6h.
// Adds tray menu items lazily when an update is found.
func startUpdateChecker() {
	go func() {
		// Slight delay so tray UI is fully up before we mutate the menu
		time.Sleep(5 * time.Second)
		checkOnce()
		tick := time.NewTicker(6 * time.Hour)
		defer tick.Stop()
		for range tick.C {
			checkOnce()
		}
	}()
}

func checkOnce() {
	rel, err := fetchLatestRelease()
	if err != nil {
		// Network errors are non-fatal — we'll try again next tick
		fmt.Fprintf(os.Stderr, "[updater] check failed: %v\n", err)
		return
	}
	if rel == nil || !isNewer(rel.TagName, Version) {
		return
	}

	pendingUpdateMu.Lock()
	pendingUpdate = rel
	pendingUpdateMu.Unlock()

	addUpdateMenuItemsIfMissing(rel)
}

func fetchLatestRelease() (*githubRelease, error) {
	req, err := http.NewRequest("GET", releasesAPIURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", updateUserAgent)
	req.Header.Set("Accept", "application/vnd.github+json")

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("github API returned %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var rel githubRelease
	if err := json.Unmarshal(body, &rel); err != nil {
		return nil, err
	}
	return &rel, nil
}

// isNewer compares two version strings of the form "vX.Y.Z". Falls back
// to string comparison for non-conforming versions. Local "dev" builds
// never report as newer than tagged releases (so updates always offer).
func isNewer(latest, current string) bool {
	if current == "dev" {
		return true
	}
	latest = strings.TrimPrefix(latest, "v")
	current = strings.TrimPrefix(current, "v")
	la, lb, lc := parseSemver(latest)
	ca, cb, cc := parseSemver(current)
	if la != ca {
		return la > ca
	}
	if lb != cb {
		return lb > cb
	}
	return lc > cc
}

func parseSemver(s string) (int, int, int) {
	parts := strings.SplitN(s, ".", 3)
	get := func(i int) int {
		if i >= len(parts) {
			return 0
		}
		var n int
		fmt.Sscanf(parts[i], "%d", &n)
		return n
	}
	return get(0), get(1), get(2)
}

// addUpdateMenuItemsIfMissing inserts the two update menu items into the
// systray menu the first time an update is discovered. Subsequent checks
// just re-point at the latest release.
func addUpdateMenuItemsIfMissing(rel *githubRelease) {
	if mUpdateChangelog == nil {
		mUpdateChangelog = systray.AddMenuItem("", "Open the release notes for this update")
		mUpdateInstall = systray.AddMenuItem("Install update & restart", "Download the new build and restart")
		go handleUpdateClicks()
	}
	mUpdateChangelog.SetTitle(fmt.Sprintf("Update available: %s — view changelog", rel.TagName))
}

func handleUpdateClicks() {
	for {
		select {
		case <-mUpdateChangelog.ClickedCh:
			pendingUpdateMu.RLock()
			rel := pendingUpdate
			pendingUpdateMu.RUnlock()
			if rel != nil {
				openBrowser(rel.HTMLURL)
			}
		case <-mUpdateInstall.ClickedCh:
			pendingUpdateMu.RLock()
			rel := pendingUpdate
			pendingUpdateMu.RUnlock()
			if rel != nil {
				if err := downloadAndApplyUpdate(rel); err != nil {
					showError(fmt.Sprintf("Update failed:\n%s", err.Error()))
				}
			}
		}
	}
}

// downloadAndApplyUpdate downloads the tray exe asset, swaps it in for the
// running exe, spawns the new exe, and quits the current process. The new
// exe will clean up the .old file from a previous swap on its next startup.
func downloadAndApplyUpdate(rel *githubRelease) error {
	asset := pickTrayAsset(rel.Assets)
	if asset == nil {
		return fmt.Errorf("no tray exe asset found in release %s", rel.TagName)
	}

	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate current exe: %w", err)
	}
	newPath := exePath + ".new"

	if err := downloadTo(asset.BrowserDownloadURL, newPath); err != nil {
		return fmt.Errorf("download: %w", err)
	}

	// Sanity: downloaded size matches what GitHub reported
	info, err := os.Stat(newPath)
	if err != nil {
		return fmt.Errorf("stat downloaded file: %w", err)
	}
	if asset.Size > 0 && info.Size() != asset.Size {
		os.Remove(newPath)
		return fmt.Errorf("download size mismatch: expected %d, got %d", asset.Size, info.Size())
	}

	// Swap: rename current to .old, rename .new to current path
	oldPath := exePath + ".old"
	_ = os.Remove(oldPath)
	if err := os.Rename(exePath, oldPath); err != nil {
		os.Remove(newPath)
		return fmt.Errorf("rename current exe: %w", err)
	}
	if err := os.Rename(newPath, exePath); err != nil {
		// Try to recover the original
		os.Rename(oldPath, exePath)
		return fmt.Errorf("rename new exe: %w", err)
	}

	// Spawn the new tray process detached, then quit ours
	cmd := exec.Command(exePath)
	if err := cmd.Start(); err != nil {
		// Roll back if we can't launch the new one
		os.Remove(exePath)
		os.Rename(oldPath, exePath)
		return fmt.Errorf("launch new exe: %w", err)
	}

	// Stop the runtime child cleanly first, then quit the tray
	stopRuntime()
	systray.Quit()
	return nil
}

func pickTrayAsset(assets []githubReleaseAsset) *githubReleaseAsset {
	for i := range assets {
		name := strings.ToLower(assets[i].Name)
		if strings.HasSuffix(name, ".exe") {
			return &assets[i]
		}
	}
	return nil
}

func downloadTo(url, dst string) error {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", updateUserAgent)

	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("download HTTP %d", resp.StatusCode)
	}
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, resp.Body)
	return err
}

// cleanupPriorSwap deletes the .old file left over from a previous in-place
// upgrade. Called early in main() so the cleanup happens before anything
// else can touch the file.
func cleanupPriorSwap() {
	exePath, err := os.Executable()
	if err != nil {
		return
	}
	oldPath := exePath + ".old"
	if _, err := os.Stat(oldPath); err == nil {
		_ = os.Remove(oldPath)
	}
	// Also nuke any stray .new from an interrupted download
	newPath := exePath + ".new"
	if _, err := os.Stat(newPath); err == nil {
		_ = os.Remove(newPath)
	}
}
