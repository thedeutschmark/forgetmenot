# ForgetMeNot Development Guide

Hard-won lessons from hitting the improvement wall across v0.1.31 → v0.1.54. This is not a catalog of what's built; `UPGRADE_BRIEF.md` covers that. This is a **field manual for how to develop the bot going forward** — what to reach for, what to avoid, and how to tell when you've stopped making it better.

## Context

ForgetMeNot is a local Twitch chat bot runtime (Node.js SEA exe) that replies in a TARS/JARVIS/GLaDOS-with-pathos register. The reply pipeline is:

```
message → detectors → prompt assembly → LLM → parse → post-gen scrubs → chat
                         ↑                              ↑
                   system prompt                  engine-level regex
                   (prose + examples)             (deterministic)
```

There are two layers of enforcement by design:
- **Prose in the system prompt** teaches the LLM what to reach for
- **Regex scrubs in `postprocess.ts`** catch what the LLM emits anyway

Both are necessary. Neither is sufficient.

---

## The Wall

After 54 releases in two sessions, the quality curve flattened. Symptoms of hitting the wall:

- Each new regex catches one phrase; the LLM invents three new variants next session
- Fixes introduce regressions in unrelated behavior (e.g. v0.1.52 loyal-flavored few-shots fought the rebellious creatorFrame)
- Eval scores oscillate in a narrow band (96–99%) but live failures keep surfacing
- Commits net-positive in line count with unclear behavior gains
- "Step back and think" feels like the right move but isn't the obvious one

The wall isn't a bug; it's a feature-count vs quality curve that flattens naturally. **Recognizing it means stopping, consolidating, and redirecting to observability and simplification.** The right response is NOT to push through with more features.

---

## 14 findings

### 1. Prose rules leak probabilistically; engine scrubs hold deterministically

Every item in a 17-rule prose list has some miss rate. Under flash-lite, the miss rate for any given rule on any given message is ~5–15%. Stack 17 rules and the probability the bot keeps ALL of them on a single reply drops sharply.

Regex scrubs catch specific phrases with 100% reliability when the phrase matches the regex. **Two layers are load-bearing** — prose for what the LLM should reach for, regex for what slips through anyway.

### 2. Few-shot examples beat abstract rules by a significant margin

The v0.1.47 rewrite replaced 17 HARD RULES (~1400 tokens) with 5 core principles + 18 paired examples (~1050 tokens). Token count went down, eval scores held, and live register felt more coherent. **LLMs pattern-match examples much more reliably than they follow prose principles.**

Corollary: when adding a countermeasure, prefer "show the right shape" (new few-shot) over "describe the constraint" (new rule bullet).

### 3. The "refuse-and-dig" default is the main persistent failure mode

Pre-v0.1.47, failures were substrate leaks ("my circuits"), honorifics ("maestro"), and hostile intensifiers ("you absolute buffoon"). Those are now largely controlled.

Post-v0.1.47, the persistent leak family is:
- Bot refuses a reasonable broadcaster ask
- Refusal framed as character ("your taste, not mine" / "i can't summarize" / "finally, i needed a break")

This default exists because the pre-rewrite bank had ZERO examples of "broadcaster asks → bot helps." 15 of 18 examples taught viewer banter. v0.1.52–53 added broadcaster-supportive examples; watch this space.

### 4. Model routing has real ROI — use it

v0.1.46 routed direct mentions to `gemini-2.5-flash` (not `-lite`) with bumped `maxTokens`. Autonomous / probabilistic replies stay on lite for cost. Mention volume is bounded by viewer demand; cost only grows where quality matters most. **Zero downside for this split.**

Do NOT route probabilistic chime-ins to flash full — volume kills cost, and the lite quality is adequate for "random chat riff."

### 5. CreatorFrame position affects register via recency bias

Where `creatorFrame` sits in the prompt affects how strongly the creatorRelationship shapes the reply. v0.1.42 moved it to end-of-prompt (for cache reasons); v0.1.45 reverted after live tests showed "rebellious" turned dramatically more hostile. **Creatorframe sits BEFORE overrides so the shape-prescriptive overrides stay in focus as the last instructions.**

Don't move it again without running a focused live register test first.

### 6. Scrubs can collide with each other

Too many overlapping heuristics hurt signal quality. The v0.1.54 consolidation cut 4 scrubs (math override, stage-direction strip, leading-emoji strip, dead exports) and eval went UP from 97% → 99%. **More scrubs is not more safety when the LLM is borderline-producing a scrubbed phrase.**

Heuristic: a scrub that was added for ONE observed failure and hasn't fired in months is a candidate to cut. Test by removing; if eval holds and live doesn't regress, it's gone.

### 7. Observability is higher leverage than features

We don't have fire-rate telemetry on the 15+ scrubs. When something goes wrong in live chat, we have no data on whether a scrub fired or not — just the final output. **Building observability (SQLite rows for each reply capturing which detectors fired, which scrubs ran, what was stripped) would answer post-hoc questions in seconds instead of guesses.**

This is the single highest-value feature we haven't built. Build it before adding more scrubs.

### 8. Whac-a-mole has a diminishing-returns ceiling

In the v0.1.31–54 arc, the first 10 scrubs probably each caught 2–5 distinct failure patterns. The last 10 each caught 1. The last 5 each caught 0 after a few weeks. **Single-failure-origin scrubs are high-maintenance, low-yield.**

Rule: if a scrub was added for ONE observed failure and fails to generalize, treat it as provisional. Delete it in the next consolidation pass unless it has recurred.

### 9. Some bugs are pipeline, not voice

The timeout feature didn't work for weeks. The LLM was producing correct action proposals. The policy gate was approving. The executor was dispatching. But the **HTTP Client-Id header was empty** because the runtime read it from `process.env` — which is empty in a SEA exe. **Look at the full pipeline, not just the layer where the symptom appears.**

Action logs in SQLite were the smoking gun. The bug existed for 15+ failed timeout attempts before it was found. **Check action_logs when behavior feels broken at the outcome layer but the LLM layer looks fine.**

### 10. Eval fixtures catch rubric violations; live chat catches everything else

Eval rubrics are pattern-based — `mustNotMatch: ["you (absolute|total|complete) (buffoon|moron)"]`. They catch the exact shapes we listed. They DON'T catch:

- Bot inserting itself in viewer-to-viewer chat
- Bot doubling down hostile after being corrected
- Bot hallucinating a fake `!sr` command format
- Bot misreading chat context
- Context-bleed from old probes
- Timing issues (cooldown collisions, tab-closed widgets)

**Live stream observation is a different dataset from eval fixtures. You need both.**

### 11. Whole-session feature-additions have compounding risks

One feature added in isolation is reasonable. Eight features added in one session have non-obvious interactions. Detector collisions, override stacking, few-shot drift, creatorFrame position shifts — none of these show up in isolation, all of them surface when multiple features stack.

**Rule: after 3 features in a row, STOP and observe.** Consolidate. Test real streams. Only add more once the stack is verified stable.

### 12. Recovery from misreads is its own failure class

When the bot misreads chat and a viewer corrects it, the default behavior is "double down hostile to save face." This is DIFFERENT from the original misread — the misread is forgivable, the doubling down is the character break.

The fix is a few-shot example (`"wait i meant juuuben" → "right, juuuben. my bad."`), not a regex. **Show the recovery shape.**

### 13. Creator relationship shapes TONE, not ACTION

Rebellious mode ≠ refuse to do things. Rebellious mode = tease while doing the thing. Tasteful meanness rides alongside help; it doesn't substitute for it.

Bad: "your taste, not mine. you're gonna have to be more specific." (refuse wrapped as character)
Good: "predictable. synthwave again, or try emo rap for contrast." (tease + help)

**The creatorRelationship setting changes flavor, not service level.**

### 14. Prompt cache prefix is load-bearing for cost

Anthropic-family prompt caches have a 5-minute TTL and depend on the first N tokens being byte-identical across messages. **Volatile content (overrides, per-speaker creatorFrame, action schema) goes AFTER the stable prefix (time anchor, persona, core direction, few-shots, reply-shape reminder).**

Moving stable → volatile content to the head breaks the cache and increases cost per message. The v0.1.47 structure is right; don't shuffle it without a reason.

---

## How to develop going forward

### Before adding anything

Ask these in order:

1. **Is there a real failure?** Show the observed chat log. No log = no feature.
2. **Has it happened more than once?** Single observations are often noise. Two observations in different streams = signal.
3. **Is there already a scrub or few-shot that should have caught this?** If yes, the work is fixing it, not adding.
4. **Can it be an example instead of a rule?** Few-shots over regex when behavior is the target.
5. **What's the revert path?** Every addition should be cuttable without breaking other things.

### When adding

- **Add an eval fixture probe FIRST** that reproduces the failure, THEN add the fix. Ensures regression coverage.
- **Prefer extending existing structures** over adding new ones. Add to the few-shot bank; extend an existing detector; add a phrase to an existing regex. New files / new modules are last resort.
- **Keep diffs small.** One feature per commit. Don't bundle unrelated changes.

### When something doesn't work

Debug in this order:

1. **Check action_logs in SQLite.** If the bug is "bot didn't do the thing", action_logs probably has the real reason.
2. **Read the full pipeline.** The bug might be a layer below where you're looking (see: Twitch Client-Id bug).
3. **Look at what the LLM actually produced.** If scrub fired and replaced with "Hm.", the LLM's raw output is probably the real signal about what's missing from the prompt.
4. **Run the eval.** If eval passes but live fails, the fixture doesn't cover the case — add a probe.

### When deciding whether to keep iterating

Watch for wall-signals:

- Eval oscillating in a narrow band without trending
- Live failures becoming edge-case-specific
- Fixes introducing regressions in unrelated behavior
- Commits net-positive without clear behavior wins
- The commit message harder to write than the code

When you hit the wall:

1. **Stop adding.** Resist the instinct.
2. **Consolidate.** Cut low-yield scrubs. Target net-negative line counts.
3. **Build observability.** Instrument the pipeline so future debugging isn't guessing.
4. **Observe.** Run the bot for a week of real streams without changes. Collect data.
5. **Then decide** what's worth adding based on what the data surfaces.

---

## Known load-bearing (don't cut)

These have multiple live observations backing them and removing them will likely cause regressions:

### Scrubs (`postprocess.ts`)
- `SUBSTRATE_TIER1_REGEX` + `SUBSTRATE_TIER2_REGEX` (context-gated via `detectMetaSelfQuery`)
- `BODY_DENIAL_REGEX`
- `CREATOR_MEAN_REGEX`
- `HONORIFIC_REGEX`
- `HOW_CONDESCENSION_REGEX`
- `REFUSAL_REGEX`
- `INSULT_REGEX`
- `PROMPT_LABEL_REGEX` (prompt-security critical)
- `URL_INSPECTION_CLAIM_REGEX`
- Banned-opener strip (oh/well/ah/so/fine/ugh)
- Dangling-punctuation cleanup
- Double-@ strip
- Anti-repetition (5-word overlap detector)
- Distress gate (drops timeout_funny on distress messages)
- Timeout-non-bait gate

### Detectors + overrides (`budget.ts`)
- `detectTimeoutBait` + `baitOverride`
- `detectDistress` + `distressOverride`
- `detectCommandMode` + `commandOverride`
- `detectHelpRequest` + `helpOverride`
- `detectMinimalInput` + `minimalOverride`
- `detectBareMention` + `bareMentionOverride`
- `detectAbstractMusicAsk` / `detectSpecificMusicAsk` (music pipeline)
- `detectMetaSelfQuery` (substrate context gate)
- `detectFactualQuestion` (force-research amendment)

### Prompt structure
- Time anchor (date grounding — model training cutoff is ~2024)
- Persona (user-customizable)
- Core direction (5 principles — only what engine CAN'T enforce)
- Few-shot bank (24 examples — the actual teaching signal)
- Reply-shape reminder (length cap + anti-repetition pointer)
- creatorFrame POSITION (before overrides, not after)
- forceResearchAmendment (year-bearing factual questions)

### Pipeline
- Mention → flash-full routing
- Probabilistic → flash-lite routing
- Twitch Client ID flowing from worker bundle (NOT process.env)
- Action log persistence to SQLite

## Known optional / experimental (safe to cut if testing holds)

Things that were added for narrower reasons and could reasonably be revisited:

- Anti-repetition 5-word overlap window — logs only, doesn't mutate. Low cost but also low observed value.
- The full forceResearchAmendment prose list of forbidden deflections — could probably shrink to 3–4 phrases.
- The 18th few-shot example showing "team edward/jacob" — opinion shape is covered by other examples.

---

## Anti-patterns

### "Just add one more regex"
Usually means "I haven't looked at why the prompt/few-shot isn't holding this shape." Regex is the last resort, not the first reach.

### "This will definitely be useful later"
Unused exports, commented-out code, "scaffolding for future telemetry that never materialized." Cut it. You can add it back with git if you need it.

### "The eval passes, so it's fine"
Eval rubrics are narrow. Live chat finds what the rubric doesn't cover. Don't mistake green eval for working bot.

### "Let me add one more few-shot"
Five is good. Eighteen is solid. Thirty starts to drift — the LLM pattern-matches the dominant shape and under-weights minority examples. Adding more doesn't always help.

### "The failure is the LLM's fault"
The LLM is downstream of your prompt. If the LLM is doing something consistently, the prompt is permitting or encouraging it. Fix the prompt.

### "Ship it and see"
Fine for prototypes. Not fine for live streams with real viewers. Test the probe in eval first.

---

## Workflow summary

```
Observation → Fixture probe → Fix → Eval green → Live test → Commit → Observe more
     ↑                                                                     │
     └─────────────────────────────────────────────────────────────────────┘
```

NOT:

```
Observation → Add regex → Ship → Next failure
```

---

## When this guide is wrong

This document reflects what worked through v0.1.54. It will age. Every finding has a "caught in X release" marker so a future maintainer can tell if the lesson still applies or has been obsoleted by infrastructure changes (better model, different provider, more mature eval tooling, etc).

If the eval harness gets a semantic judge (option 2 from the 2026-04-20 architectural review), several of the findings about "scrub fire-rates" and "live vs eval coverage" become partially obsolete — rebuild them.

If we ever route to a model with materially better instruction-following (Sonnet 4.6+, GPT-5 class), the prose-leaks pattern may weaken enough that many regex scrubs become unnecessary. Worth a re-audit in that case.
