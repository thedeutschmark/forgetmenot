# ForgetMeNot Tray Shell

Source for `forgetmenot.exe` — the Windows tray shell for the ForgetMeNot bot runtime.

The runtime (Node SEA from `../runtime/`) is **embedded** inside this binary at build time and extracted on first launch. End users get a single file.

## What it does

- Extracts the embedded runtime to `%LOCALAPPDATA%\ForgetMeNot\runtime\forgetmenot.exe` on first launch (re-extracts only if SHA-256 differs)
- Spawns and supervises the runtime as a child process (Windows job object: runtime is killed if the tray dies for any reason)
- Polls `/health` every 10s, updates tray icon color
- Right-click menu:
  - Status (color indicator + label)
  - Open Review Dashboard (opens toolkit in browser)
  - Pause / Resume Replies (in-memory, no config write)
  - Safe Mode toggle (proxies to auth worker)
  - Restart Runtime
  - Quit

Anything richer (logs, stats, settings) lives in [toolkit.deutschmark.online](https://toolkit.deutschmark.online/tools/chat-bot).

## Build

Requires Go 1.22+. Install from <https://go.dev/dl/>.

The runtime exe must exist at `../runtime/build/forgetmenot.exe` first — build it with `cd ../runtime && build-exe.bat`.

Then:

```
build.bat
```

Output: `forgetmenot.exe` (~93 MB — runtime is embedded inside).

## Logs

Runtime stdout/stderr is captured to `%LOCALAPPDATA%\ForgetMeNot\runtime.log`.

## Single instance

Uses a Windows named mutex (`Global\ForgetMeNotTraySingleInstance`). Launching a second instance exits silently.
