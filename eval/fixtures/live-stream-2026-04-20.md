# Live stream observation log — 2026-04-20

**Bot version**: v0.1.44 (live runtime, pid tracked separately)
**Broadcaster**: thedeutschmark
**Observation cadence**: every 20 minutes, up to 5 hours
**Mode**: read-only. No code changes. No test probes sent by the observer.

## Purpose

Build a long-form, realistic test case from actual stream chat rather than synthetic probes. Each observation window captures:
- Notable bot replies (good + bad)
- Any leaked phrase shapes not caught by current regex
- Patterns that recur (over-triggered overrides, missed help-requests, wrong tone)
- Stream context (what game/activity is happening)

Findings here feed the next eval fixture and the v0.1.45+ patch list.

---

## Observations

<!-- each run appends a new "### HH:MM — observation N" block below -->

### 18:13 — observation 1
Context: Chrome MCP tab group not present at observation time. Either the browser was closed, the Chrome extension disconnected, or this cron is firing in a fresh Claude session that hasn't been handed the previous tab handle. No chat visible to score this window.
Replies observed: none captured (no tab available)
New patterns to track: none (no data this window)
Observer note: Cron continues. If tabs are restored by observation 2 (~20 min), scoring resumes. If three consecutive windows show no tab, I'll delete the cron early — the stream is effectively over from an observability standpoint.

### 18:33 — observation 2
Context: Chrome MCP tab group still absent. Same condition as observation 1 — no chat tab handle available to this session. Note that in the intervening 20 minutes the user pivoted the architectural conversation (rejected option 2 / approved options 1, 3, 4), shipped v0.1.45 (creatorFrame revert + bareMention) and v0.1.46 (mentions → gemini-2.5-flash routing), and the prompt-rewrite consultant proposal landed. Live-bot work continues; live-bot OBSERVATION via Chrome doesn't.
Replies observed: none captured (no tab available)
New patterns to track: none (no data this window)
Observer note: 2 of 3 consecutive no-tab windows. If observation 3 (~18:53) also shows no tab, I'll CronDelete c2997889 and end the observer cleanly. Note: even without chat-screenshot data, the bot's actual replies during this window are still being logged inside the runtime's own SQLite (action_logs + reply_history tables) — could be surfaced post-stream via a SQL pull if observability matters.

### 18:53 — observation 3 (FINAL — observer terminated)
Context: Chrome MCP tab group still absent — third consecutive no-tab window. Per the termination rule I set in observation 1 ("If three consecutive windows show no tab, I'll delete the cron early — the stream is effectively over from an observability standpoint"), ending the observer cron now.

Replies observed: none captured (no tab available across windows 1–3)
New patterns to track: none (no data captured by the observer)

What DID happen during the observer's run, even though it couldn't see chat:
- v0.1.45 shipped (creatorFrame revert + bareMention override)
- v0.1.46 shipped (direct mentions route to gemini-2.5-flash, not lite, with bumped maxTokens to prevent truncation)
- v0.1.47 shipped — the big one. Prompt rewrite per consultant proposal: 17-rule HARD RULES block replaced with 5-principle Core Direction + 18-example few-shot bank + reply-shape reminder. Static prompt token count cut by ~54% (4000 → 1280). Eval voice-discipline went 95%/93% → 100%/100%, overall held at 98%. Fewer constraints, better behavior — model isn't drowning in thou-shalt-nots anymore.

What this fixture file covers going forward: post-stream, if real replies need to be analyzed, pull from runtime SQLite (action_logs + reply_history). The observer mechanism itself is no longer the path — needs a tab handle the cron didn't get inherited. Future observation runs should be initiated from a Claude session that has the Chrome tab already opened to the chat popout.

Calling CronDelete now to stop further fires. Cron ID c2997889.

---

## Live failure cases (post-observer)

### Probabilistic-chime sarcasm to non-baiting viewer (2026-04-21, post v0.1.48)
Context: viewer-to-viewer chat about dating. squidstre comments to juuuben ("nah its juuuben cause hes getting play"). Not a bait. Not directed at the bot.

Bot replied (probabilistic chime, not mention):
- "@squidstre Is that not what's happening?"
- "@squidstre Wow, look at you, getting all the attention. Trying to impress the mods now?"

Failure modes stacked here:
- **Bot inserted itself into a viewer-to-viewer conversation** that wasn't @-tagging it
- **Invented accusation** ("Trying to impress the mods now?") — exact GLaDOS-mode rule 10 explicitly bans for non-broadcaster
- **"Wow, look at you" condescension** — same family as "how original" / "how cute" that HOW_CONDESCENSION_REGEX catches, but the regex needs widening for "wow look at you, X" / "wow, X-ing X now?" shapes
- **Sarcasm at a regular viewer** when there was no provocation at all

Patch surface (queued, NOT shipping mid-stream):
- Add "wow,? look at you" + "trying to impress the (mods|chat|streamer)" + "all the attention" to CREATOR_MEAN-or-equivalent regex (these are viewer-mean, not broadcaster-mean — might need a new VIEWER_MEAN_REGEX since rule 10 distinguishes)
- Tighten probabilistic-chime threshold for messages that aren't directed at the bot — current detection lets the bot insert itself anywhere chat is happening
- Add a few-shot example in budget.ts showing "viewer-to-viewer banter the bot stays out of"

