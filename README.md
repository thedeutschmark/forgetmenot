# ForgetMeNot

Engine for a local-first Twitch chat bot. Reads chat in real time, remembers context in a local SQLite database, replies via Gemini or OpenAI using your own API key. Runs on the broadcaster's machine — no shared backend holds chat data.

This repository is the public mirror of the engine. The full distributable (Windows executable + system tray app) ships from [Releases](https://github.com/thedeutschmark/forgetmenot/releases). Configuration, personality templates, and review dashboards live at [toolkit.deutschmark.online](https://toolkit.deutschmark.online/tools/chat-bot).

## What's in here

| Path | What it is |
|---|---|
| `src/` | Engine source — Twitch chat ingest, SQLite memory, LLM calls, action evaluation, post-gen filters |
| `eval/` | Fixtures and rubric runner used to catch behavior regressions before release |
| `scripts/` | Build helpers — packages the engine into a single-file executable |

## Build

Requires Node.js 22+.

```
npm install
npm run build:exe
```

## What it does NOT do

- Stream chat to any third-party service. LLM calls go from your machine directly to Gemini or OpenAI.
- Run unattended without explicit policy opt-in. Moderation actions require configured allow-lists.
- Store credentials in plaintext on disk.

## License

[MIT](LICENSE)
