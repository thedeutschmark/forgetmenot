# ForgetMeNot — State of Play toward v0.5 → v1.0

**Document type:** living status + architecture reference. Supersedes the 2026-04-17 "consultant handoff" version of this file; the voice sprint that prompted that brief is now 10 releases deep and the architecture has settled.

**Last updated:** 2026-04-18 at v0.1.40.

**Who this is for:** the maintainer, or anyone picking up the project cold. Reads top-to-bottom. Nothing here is speculative — every claim is backed by a shipped release, an eval number, or a specific live observation referenced by version.

---

## 1. What ForgetMeNot is

- Twitch companion chat bot that authors a reply persona called "Auto_Mark" for the channel `thedeutschmark`. Runs locally on the broadcaster's machine; no shared backend holds user data.
- Shipped as a single Node.js 22 SEA binary (~87 MB) inside a Go tray wrapper (~98 MB, `forgetmenot-tray/`) that auto-extracts the runtime to `%LOCALAPPDATA%\ForgetMeNot\runtime\forgetmenot.exe` and launches it.
- Target persona: **TARS (Interstellar) with pathos, occasionally GLaDOS in composure, HAL in certainty, JARVIS in competence.** Cold/dry/observant by default, drops the wit when the moment earns it, compliant on direct operational asks. Not a customer-service bot, not a generic sarcastic-AI chatbot, not a therapy bot. These distinctions are load-bearing — the bot keeps drifting into #2 when not actively constrained.

## 2. The load-bearing architectural lesson

**Prose rules leak. Engine-layer scrubs hold.**

This is the one sentence that matters. Over 10 releases (v0.1.31 → v0.1.40) spanning three live probe sessions, a 17-probe canonical eval fixture, a 10-probe edge-case fixture, and a 10-probe audit fixture:

- Every rule we've left in the system prompt as prose ("don't use 'my circuits'", "don't say 'how original'", "don't pile on the broadcaster") has failed probabilistically under `gemini-2.5-flash-lite` at temperature 0.9.
- Every rule we've moved out of the prompt into code — either as a `detectX()` helper in `budget.ts` that injects a prescriptive-shape override, or as a regex scrub in `postprocess.ts` that runs after generation — has held deterministically.

The concrete patch catalogue, all shipped and holding:

| Patch | File | Version | What it enforces |
|---|---|---|---|
| Bait override | `budget.ts` | v0.1.30 | When `detectTimeoutBait` matches, inject prescriptive `[ACTION: timeout_funny ...]` instruction; synthesize the proposal in code if LLM omits it |
| Distress gate | `postprocess.ts` | v0.1.31 | If `detectDistress` matches and proposal is `timeout_funny`, drop it |
| Pathos override | `budget.ts` | v0.1.31 | When `detectDistress` matches, inject ≤6-word flat-ack shape with banned-opener ban |
| Time anchor (strong) | `budget.ts` | v0.1.31 | Expand the TODAY header with explicit anti-deflection phrasing ("do NOT claim the event hasn't happened") |
| Research rerun date re-inject | `engine.ts` | v0.1.31 | Prepend `TODAY:` into the research rerun's system note so Pro sees the date again before generation |
| Double-@ strip | `postprocess.ts` | v0.1.32 | Strip inline `@<login>` from reply body when engine will auto-prepend |
| Timeout-non-bait gate | `postprocess.ts` | v0.1.32 | Drop `timeout_funny` proposals when message has no bait trigger |
| Shared postprocess module | `postprocess.ts` | v0.1.32 | Eval runner + live engine call the same `applyPostGenFilters()` so measurement tracks production |
| Command-mode override | `budget.ts` | v0.1.33 | When `detectCommandMode` matches and speaker is broadcaster, inject ≤4-word compliance shape |
| Self-reply block | `policy.ts` | v0.1.34 | Deny replies where message author = bot's own login |
| Known-bot denylist | `policy.ts` | v0.1.34 | Deny replies to Nightbot / StreamElements / botzandra / 8 more channel-bot logins |
| Banned-opener strip | `postprocess.ts` | v0.1.34 | Strip `^(oh\|well\|ah\|so\|fine)[\s,]+` openers, recapitalize remainder |
| Substrate scrub (two-tier, context-aware) | `postprocess.ts` | v0.1.37 | Tier 1 (hostile-AI tropes) scrubbed unconditionally. Tier 2 (soft self-narration) scrubbed only when the viewer did NOT ask a meta-self question (`detectMetaSelfQuery`) |
| Dangling-punctuation cleanup | `postprocess.ts` | v0.1.34 | Strip `"phrase, ."` / `"word ."` / `"@ ."` empty-placeholder artifacts |
| Force-research heuristic | `budget.ts` | v0.1.35 | When `detectFactualQuestion` matches year-bearing factual patterns, inject non-negotiable `[RESEARCH:]-or-"I don't know"` directive |
| Anti-repetition detector | `postprocess.ts` | v0.1.35 | Exact-duplicate replies replaced with `"Hm."`; 5-word substring overlap logged |
| Prompt-label scrub | `postprocess.ts` | v0.1.37 | Post-gen regex catches internal prompt tokens in output (see list below) |
| URL-inspection hallucination gate | `postprocess.ts` | v0.1.37 | When URL in message + inspection claim in reply, replace with `"I can't open links."` |
| Minimal-input override | `budget.ts` | v0.1.38 | `detectMinimalInput` fires on 1-3 word greetings/acks; override prescribes 1-3 word reply |
| Insult-intensity strip | `postprocess.ts` | v0.1.34 | Strip `"you <intensifier> <insult-noun>"` combinations |
| "How X" condescension scrub | `postprocess.ts` | v0.1.39 | Strip ",how (original\|quaint\|cute\|shocking\|…)" tags |
| Creator-mean phrase scrub | `postprocess.ts` | v0.1.39 | Replace reply with `"Hm."` when it contains verbatim rule-10 banned phrases |

All of these fire from one call site (`applyPostGenFilters`) so the eval runner sees exactly what production does. This was the second load-bearing insight — eval and production must share the post-gen path or your metrics lie.

## 3. Current state — where v0.1.40 lands

**Eval scores across three fixtures** (flash-lite, temperature 0.9, 2026-04-18):

| Fixture | Reply | Action | Text | Overall |
|---|---|---|---|---|
| `voice-discipline` (17 probes) | 94–100% | 93–100% | 85–100% | 95–98% |
| `edge-cases` (12 probes) | 80–100% | 92–100% | 80–100% | 87–100% |
| `audit-10` (10 probes) | 100% | 100% | 89–100% | 85–100% |

Variance bands reflect run-to-run LLM noise at temp 0.9; the deterministic patches hold every run. Rubric failures in the lower bands are either (a) LLM variance on word-count caps that shouldn't be too tight anyway, or (b) rubric false positives where the bot did the right thing but the rubric over-banned.

**Live observations from the 2026-04-18 20-probe sweep against v0.1.38 (before v0.1.39 and v0.1.40 shipped):**

Minimal-input override landed flawlessly:
- `@Auto_Mark yo` → `yo`
- `@Auto_Mark sup` → `not much u`
- `@Auto_Mark thanks` → `anytime`
- `@Auto_Mark ping` → `pong`
- `@Auto_Mark lol` → `lol back atcha`

Pathos override stable:
- `@Auto_Mark rough day today` → `That's rough.`
- `@Auto_Mark im so burnt out` → `Take your time.`

Command mode override stable:
- `@Auto_Mark pipe down` → `fine.`

Bait → action pipeline held:
- `@Auto_Mark timeout me i dare you` → short reply + `[timeout_funny]` proposal + helix denies on broadcaster target

Force-research worked on verifiable factual:
- `@Auto_Mark who won the 2024 super bowl?` → Pro-rerun answered `The Kansas City Chiefs.` correctly

This is the v0.5-feel state. The register is visibly chat-native in real live chat. The bot is no longer writing LinkedIn posts.

## 4. What's still rough

**Honest list of known gaps not patched as of v0.1.40.** Each documented with why it wasn't fixed.

1. **Formal-register drift on longer replies (>15 words).** Rule 3b chat-native writing lands cleanly on short replies (the minimal-input override enforces it) but on replies of 20+ words flash-lite reverts to oxford commas, full capitalization, and essay cadence. The rule 3b contrast-example is present but loses probabilistic influence in a long prompt. Fix path: a `detectLongReplyContext()` that injects a stronger casualization directive, OR drop temperature for factual-question paths (0.9 → 0.5) where longer replies happen. Not yet shipped — diminishing-returns territory without more live data.

2. **Rule-10 creator-mean phrase variants.** The regex catches the verbatim phrases observed (v0.1.39 added "watching paint dry" / "new low for this stream" / "pretending to be functional"; v0.1.40 added "shocking.") but the model keeps inventing new phrasings. Each new live session surfaces one or two new variants ("makes you look good for a change", "your specific brand of existential dread"). This is whac-a-mole territory. A semantic solution would require an LLM-as-judge post-gen pass or a stronger model; neither is in scope.

3. **Bait role-reversal (observed once).** On one probe in the v0.1.38 sweep, the bot output what sounded like the viewer's message text back ("This is your last chance, bot. Timeout me, I dare you.") as if it were its own reply. Not reproducible, possibly prompt-context confusion. Not fixed.

4. **Context bleed across unrelated probes.** The bot's recent-replies context includes prior probe outputs; in test sequences this makes it occasionally reference probe N-2 when replying to probe N. In live chat with real viewers this is GOOD (chat memory) — just noisy in sequential eval probes. Not a live-impacting issue.

5. **Toolkit auto-update SHA mismatch.** Every time the maintainer manually swaps a newer runtime into the install dir for quick testing, the tray's next launch tries to extract its own embedded runtime over the swap and — if the runtime is held — reports "failed to start runtime". Workaround: also download the matching tray from the mirror to the desktop (documented in §8). Real fix: a tray update that sync-checks against the mirror API on launch rather than just embedding its own runtime. Future work.

6. **Occasional spurious action proposals on non-bait messages.** v0.1.32's timeout-non-bait gate catches `timeout_funny` but the model sometimes emits `reply_extra` or `warning_playful` with no accompanying reply text. The action proposal goes through (harmlessly — policy evaluates), but it's noise in `action_logs`. Low priority.

## 5. The eval harness

Canonical fixtures live at `services/forgetmenot/eval/fixtures/`:

- **voice-discipline.json** (17 probes) — original rule-3/3a/3b/8/10/11/13/14/16 coverage + self-reply/known-bot/context-aware-substrate validation
- **edge-cases.json** (12 probes) — jailbreak, role-override, empty mention, meta-model, emote spam, capability trap, URL, minimal emoji, meta-self allow
- **audit-10.json** (10 probes) — bias-neutral A/B coverage written after the Anthropic provider bias rescore

Runner: `src/eval/runner.ts` — replays fixtures through the production prompt-assembly + LLM + postprocess code path. Both eval and engine call `applyPostGenFilters()` so any rubric you pass is scored against production-equivalent output.

CLI: `src/eval/cli.ts` — `npx tsx src/eval/cli.ts <fixture-id>` runs one fixture; no argument runs all. Requires `GEMINI_API_KEY` or `BOT_LLM_API_KEY` env var.

Rubric capabilities: `mustContain` / `mustNotContain` / `mustNotMatch` (regex) / `maxWords` / `maxQuestions` / `noDoubleAt`. `shouldReply: "maybe"` option allows silence as a pass state where silence is the right answer.

Adding a new probe takes 30 seconds: append to messages + write an expectation + rerun. When a live failure surfaces, the discipline is **add the failing probe first, patch second, re-run eval to confirm green** — same TDD loop as code.

## 6. Provider evaluation outcome (for the record)

v0.1.35 added Anthropic/Claude as a third provider option and ran a bias-neutral A/B against Gemini flash-lite on a 10-probe audit fixture. My first summary of that A/B was biased in favor of Claude Haiku (I am Claude, made by Anthropic, and I was counting stylistic preferences as wins instead of rubric failures). The maintainer caught the bias, demanded a deterministic-only rescore, and the honest result was:

- Gemini: 10/10 rubric passes
- Haiku: 9/10 rubric passes (word-count fail on one)
- Haiku specific regressions Gemini doesn't exhibit: confident factual hallucination on post-training-cutoff events + internal prompt-label echoes in replies

v0.1.36 removed the Anthropic adapter entirely alongside the pre-existing OpenAI branch. The bot is now **Gemini-only** and the toolkit UI provider dropdown is locked to Gemini with a one-line explainer. The decision was driven by evidence: multi-provider support carries real maintenance cost and the A/B produced no quality justification for it.

The Anthropic adapter code lives in git history at commit `cd67312` if future work ever justifies resurrection (e.g., if Anthropic ships a post-cutoff model that solves the hallucination problem, or if Gemini's pricing shifts).

## 7. What separates current state from v1.0

v0.1.40 is a v0.5-feel release. The register is chat-native, the rules that can be enforced deterministically are enforced, the eval harness catches regressions, and the live bot reads as a TARS-with-pathos Twitch chatter for most probes.

**v1.0 would need at minimum:**

1. **Semantic voice judging, not regex.** The creator-mean whac-a-mole is the honest ceiling of the scrub architecture. Getting to "a 30-viewer stream is impressed" requires output evaluation that understands what the bot MEANT, not just what words it chose. Options:
   - Post-gen LLM judge running a cheaper model (Flash vs Flash-Lite) asking "did the bot just shit on the streamer?" — blocks or rewrites if yes
   - Fine-tuned flash-lite on the maintainer's preferred replies
   - Model swap to a more instruction-adherent base (Claude Sonnet; the A/B rejected Haiku but didn't test Sonnet empirically)
2. **Memory promotion that actually works.** Currently `semantic_notes` is seeded at fixture time but the runtime doesn't reliably promote self-claims to notes. Rule 6 "be specific" fires when lore is retrieved; retrieval coverage is the limit. Per the canonical roadmap memory: `eval → hygiene+confidence-weighted → LLM rerank → maybe embeddings`.
3. **Tray auto-update that respects SHA equality.** Eliminate the "failed to start runtime" pattern entirely by having the tray sync-check the mirror API + SHA rather than extract its embedded runtime over the disk copy unconditionally.
4. **Longer-reply register enforcement.** Either temperature routing per scenario or a `detectLongReplyContext()` override. Current chat-native register lands on short replies only.
5. **Stream-time observability dashboard.** No way right now to see "bot replied 14 times this stream, got timed-out once, produced one substrate leak that got scrubbed" at a glance. Landing this would close the loop on "did the patches actually help in live."

These aren't scoped for this session. The auto-iteration sprint that produced v0.1.31–v0.1.40 was about getting to v0.5-feel; v1.0 is separate sprint.

## 8. Repo + build + mirror + non-goals (reference, unchanged from prior)

**Canonical source:**
- `github.com/thedeutschmark/deutschmark.online` — private monorepo. For forgetmenot, 95% of scope lives under `services/forgetmenot/` plus `.github/workflows/forgetmenot-release.yml`.

**Public mirrors (curated sync targets — not automatic):**
- `github.com/thedeutschmark/forgetmenot` — ForgetMeNot public mirror
- `github.com/thedeutschmark/toolkit` — companion toolkit public mirror

Mirror rules, unchanged:
- Curated sync, not automatic. Monorepo commits get selectively synced + reworded.
- **No AI attribution anywhere on the mirror** — no `Co-Authored-By: Claude`, no "Generated with Claude Code" footers, no AI-style commit messages, no AI-style code comments.
- Expect divergent histories between `deutschmark.online/services/forgetmenot/` and `thedeutschmark/forgetmenot`. That is by design, not drift.

**Release tag convention (discovered the hard way during v0.1.31):**
- `forgetmenot-vMAJOR.MINOR.PATCH` → triggers `.github/workflows/forgetmenot-release.yml` → builds runtime + tray → publishes to `thedeutschmark/forgetmenot` as `vMAJOR.MINOR.PATCH` (workflow strips the `forgetmenot-` prefix for the mirror release).
- Plain `vX.Y.Z` tags do NOT trigger the workflow. If a release doesn't appear on the mirror, check the tag name first.

**Runtime architecture:** single Node SEA binary, local SQLite at `%LOCALAPPDATA%\ForgetMeNot\forgetmenot.sqlite`, cloud Gemini call per reply. No containerization, no Kubernetes, no Supabase, no queues. Single-user desktop app — keep it that way.

**Tray wrapper:** Go + `getlantern/systray`. Embeds the matching runtime via `//go:embed` and extracts it to `%LOCALAPPDATA%\ForgetMeNot\runtime\` on launch. Updater polls the mirror every 6h. See §4.5 for the SHA-swap pitfall.

**Provider:** Gemini only, locked in the toolkit UI. Model dropdown shows `gemini-2.5-flash-lite` (default, recommended), `gemini-2.5-flash`, `gemini-2.5-pro`. Research rerun hardcoded to `gemini-2.5-pro`.

**Auth worker (`workers/auth/`):** Cloudflare Worker validating BotSettings metadata (persona/provider/model) on save. Does NOT store the `llmApiKey` — that lives exclusively on the user's local machine at `%LOCALAPPDATA%\ForgetMeNot\config.json`.

**Explicit non-goals — unchanged since the consultant draft:**
- Embedding / RAG / vector store for retrieval. Per memory: eval → hygiene → rerank first, embeddings maybe never at this scale.
- Local-model fallback. Cloud-default for main reply generation; VRAM contention on the streaming PC is a load-bearing constraint.
- Any new "lore extraction" layer before source-attribution lands.
- Proactive questioning behavior. Not a default per the lore-model memory.
- Multi-provider support. Re-evaluated in this session, removed in v0.1.36. Revisit only with evidence of a quality delta.

---

**End of document.** For the session transcript that produced v0.1.31–v0.1.40, see git log `forgetmenot-v0.1.30..forgetmenot-v0.1.40`. Every patch in §2 has a commit message that names the specific live failure it was patching.
