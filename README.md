# ForgetMeNot

A local-first Twitch chat bot that remembers your stream lore, learns your community, and stays in your control. Runs as a single Windows executable on your own machine — no servers to manage, no chat data leaving your computer.

## Download

Get the latest `forgetmenot.exe` from the [Releases page](https://github.com/thedeutschmark/forgetmenot/releases). One file. Double-click to run. First launch opens a browser tab to pair with your Twitch account.

## What it does

- Reads your Twitch chat in real time
- Stores chat history, viewer profiles, and "lore" in a local SQLite database
- Compresses long-term memory into episodes and durable facts
- Replies to mentions (or autonomously, your call) using Gemini or OpenAI — your API key, your billing
- Optional moderation actions (timeouts, etc.) gated by a deterministic safety policy you configure
- Pause / safe mode / status from a tiny system tray icon

Settings, personality templates, and review dashboards live at [toolkit.deutschmark.online](https://toolkit.deutschmark.online/tools/chat-bot).

## Repository layout

| Folder | What's inside |
|---|---|
| [`engine/`](engine/) | The bot engine — Twitch chat ingest, SQLite memory, LLM calls, action evaluation. Node.js, compiles to a standalone executable. |
| [`app/`](app/) | The Windows app — embeds the engine, manages it as a child process, shows the system tray icon. Go. Produces the `forgetmenot.exe` users download. |

## Build from source

Requires **Node.js 22+** and **Go 1.22+**.

```
cd engine
build-exe.bat          # produces engine/build/forgetmenot.exe

cd ../app
build.bat              # embeds the engine and produces app/forgetmenot.exe
```

The `app/forgetmenot.exe` is the single-file distributable.

## What ForgetMeNot does NOT do

- It does not stream your chat to any third-party service (the bot's LLM calls go directly from your machine to Gemini or OpenAI)
- It does not run unattended on your account — moderation actions require explicit policy opt-in
- It does not store credentials in plaintext on disk (Twitch tokens are encrypted in the auth worker, never written locally)

## License

[MIT](LICENSE)
