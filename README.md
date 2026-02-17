# Auto_Mark (Streamer.bot C# Implementation)

This repo contains two **copy/paste-ready** C# scripts for Streamer.bot's **Execute C# Code** sub-action:

- `Listener_ChatLogger.cs` (chat logger / short-term memory)
- `Brain_PerpetualResponse.cs` (AI response generator)

Default personality and naming are now set for **Auto_Mark** (resident AI mod / robotic co-host persona).

## 1) Listener Action (Chat Logger)

1. In Streamer.bot, create Action: `Auto_Mark - Listener`.
2. Add sub-action: **Execute C# Code**.
3. Paste code from `Listener_ChatLogger.cs`.
4. Add Trigger: **Twitch > Chat Message**.

What it does:
- Reads Global Var `chat_buffer`.
- Appends each incoming message as `[User]: Message`.
- Trims buffer to ~1000 chars.
- Saves back to Global Var `chat_buffer`.
- Skips self-logging when the sender matches `perpetual_bot_name`.

## 2) Brain Action (AI Reply)

1. Create Action: `Auto_Mark - Brain`.
2. Add sub-action: **Execute C# Code**.
3. Paste code from `Brain_PerpetualResponse.cs`.
4. Add Trigger:
   - **Command Trigger**: e.g. `!auto_mark` (recommended), OR
   - **Chat Message Trigger** with your chosen keyword logic.

What it does:
- Pulls `chat_buffer`, current user name, and current message.
- Pulls User Var `perpetual_lore` for that user.
- Builds the model prompt using configurable bot name + system prompt.
- Sends prompt to **Gemini OpenAI-compatible endpoint** by default.
- Parses and posts model response to chat.
- Logs API errors via `CPH.LogInfo`.

## 3) Settings You Can Change in Streamer.bot

Set these in **Global Variables**:

- `perpetual_bot_name` = default `Auto_Mark`
- `ai_api_key` = your Gemini API key (preferred)
- `ai_endpoint` = default `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`
- `ai_model` = default `gemini-2.0-flash`
- `perpetual_system_prompt` = full Auto_Mark persona prompt
- `chat_buffer` = empty string initially

Backward compatibility:
- If `ai_api_key` is missing, script falls back to `openai_api_key`.

Optional per-user variable:
- `perpetual_lore` (User Variable), e.g. `Fumbles every platform jump.`

## 4) Default Auto_Mark Persona Included

The default system prompt implements this behavior:
- resident AI mod and robotic co-host in TheDeutschMark universe
- self-aware bot created/coded by Mark
- witty, meta-humor, sarcastic, but useful for moderation/help
- recurring Botzandra obsession lore joke
- references to channel identity (TheDeutschMark, Jacob & Willie) when relevant
- concise, streamer-safe replies

## 5) Publish/Share Extension Checklist

1. Create both actions and paste scripts.
2. Create triggers:
   - `Auto_Mark - Listener` -> Twitch Chat Message
   - `Auto_Mark - Brain` -> `!auto_mark` command
3. Pre-create global variables listed above with defaults.
4. Export as a Streamer.bot extension package.
5. In your shared README/changelog include:
   - required Streamer.bot version
   - required Twitch account auth state
   - variable table from section 3
   - first-run instructions to set `ai_api_key`
6. Test import on a clean Streamer.bot profile before publishing.

## 6) What You Need To Do Right Now

1. Paste both scripts into their corresponding Streamer.bot actions.
2. Set `ai_api_key`.
3. Confirm globals use defaults (or customize name/model/prompt).
4. Send test chat messages to populate `chat_buffer`.
5. Run `!auto_mark roast me`.
