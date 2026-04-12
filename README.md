# ForgetMeNot

A local-first Twitch chat bot that remembers your stream lore, learns your community, and stays in your control. Runs as a single Windows executable on your own machine — no servers to manage, no chat data leaving your computer.

> **This is a transparency mirror.** The bot runs entirely on your machine; this repo lets you read every line of code that does it. Source for the actual binary you download.

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
| [`runtime/`](runtime/) | Node.js bot runtime — Twitch chat ingest, SQLite memory, LLM calls, action evaluation. Compiles to `forgetmenot.exe` (Node Single Executable Application). |
| [`tray/`](tray/) | Go Windows tray shell — embeds the runtime, manages it as a child process, exposes the system tray menu. Builds the actual `forgetmenot.exe` users download. |

## Build from source

Requires **Node.js 22+** and **Go 1.22+**.

```
cd runtime
build-exe.bat          # produces runtime/build/forgetmenot.exe

cd ../tray
build.bat              # embeds the runtime and produces tray/forgetmenot.exe
```

The `tray/forgetmenot.exe` is the single-file distributable.

## What ForgetMeNot does NOT do

- It does not stream your chat to any third-party service (the bot's LLM calls go directly from your machine to Gemini or OpenAI)
- It does not run unattended on your account — moderation actions require explicit policy opt-in
- It does not store credentials in plaintext on disk (Twitch tokens are encrypted in the auth worker, never written locally)

## License

[MIT](LICENSE)
