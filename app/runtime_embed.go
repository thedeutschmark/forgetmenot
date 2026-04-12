package main

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
)

// embeddedRuntime contains the contents of forgetmenot.exe bundled at build time.
// build.bat copies the runtime into ./embedded/ before `go build` runs.
//
//go:embed embedded/forgetmenot.exe
var embeddedRuntime []byte

// extractedRuntimePath returns the path where the runtime should live on disk.
func extractedRuntimePath() string {
	dir := filepath.Join(os.Getenv("LOCALAPPDATA"), "ForgetMeNot", "runtime")
	return filepath.Join(dir, "forgetmenot.exe")
}

// extractRuntimeIfNeeded extracts the embedded runtime to disk on first run
// (or after an upgrade). Compares SHA-256 of embedded bytes vs on-disk file
// to skip extraction when they already match.
func extractRuntimeIfNeeded() (string, error) {
	dst := extractedRuntimePath()

	if existing, err := os.ReadFile(dst); err == nil {
		if sha256sum(existing) == sha256sum(embeddedRuntime) {
			return dst, nil // already up to date
		}
	}

	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return "", fmt.Errorf("create runtime dir: %w", err)
	}

	// Write to a temp file then rename atomically (avoids partial-write issues).
	tmp := dst + ".new"
	if err := os.WriteFile(tmp, embeddedRuntime, 0755); err != nil {
		return "", fmt.Errorf("write runtime: %w", err)
	}
	if err := os.Rename(tmp, dst); err != nil {
		return "", fmt.Errorf("rename runtime: %w", err)
	}
	return dst, nil
}

func sha256sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
