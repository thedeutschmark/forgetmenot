# ForgetMeNot App

Source for `forgetmenot.exe` — the Windows app that wraps the ForgetMeNot engine.

The engine (Node SEA from `../engine/`) is **embedded** inside this binary at build time and extracted on first launch. End users get a single file.

## What it does

- Extracts the embedded engine to `%LOCALAPPDATA%\ForgetMeNot\runtime\forgetmenot.exe` on first launch (re-extracts only if SHA-256 differs)
- Spawns and supervises the engine as a child process (Windows job object: the engine is killed if the app dies for any reason)
- Polls `/health` every 10s, updates tray icon color
- Right-click menu:
  - Status (color indicator + label)
  - Open Review Dashboard (opens toolkit in browser)
  - Pause / Resume Replies (in-memory, no config write)
  - Safe Mode toggle (proxies to auth worker)
  - Restart Engine
  - Quit

Anything richer (logs, stats, settings) lives in [toolkit.deutschmark.online](https://toolkit.deutschmark.online/tools/chat-bot).

## Build

Requires Go 1.22+. Install from <https://go.dev/dl/>.

The engine exe must exist at `../engine/build/forgetmenot.exe` first — build it with `cd ../engine && build-exe.bat`.

Then:

```
build.bat
```

Output: `forgetmenot.exe` (~93 MB — engine is embedded inside).

## Logs

Engine stdout/stderr is captured to `%LOCALAPPDATA%\ForgetMeNot\runtime.log`.

## Single instance

Uses a Windows named mutex (`Global\ForgetMeNotTraySingleInstance`). Launching a second instance exits silently.
