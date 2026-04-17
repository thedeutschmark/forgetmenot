# ForgetMeNot — Voice & Architecture Upgrade Brief

**Audience:** external upgrade consultant.
**Status:** preliminary. Written by the project maintainer's dev assistant after a live probe session on 2026-04-17 against v0.1.31. Not a spec — a scoped problem statement plus options for your review.
**Goal:** fix the voice-consistency problem *once*, not keep stacking prompt patches. Budget for provider switch is open.

---

## 1. What ForgetMeNot is

- Twitch companion chat bot, authors a reply persona called "Auto_Mark" for the channel `thedeutschmark`.
- Shipped as a single Node.js SEA binary (~90 MB, Windows-only today) living in `%LOCALAPPDATA%\ForgetMeNot\runtime\forgetmenot.exe`.
- Target persona: **TARS (Interstellar) with pathos** — cold/dry/observant by default, drops the wit when the moment earns it, compliant on direct ops asks. Reference space includes GLaDOS and HAL for register, not for cruelty.
- Not a customer-service bot, not a generic sarcastic-AI chatbot, not a therapy bot. The distinction matters because the current output keeps sliding into #3.

## 2. Current stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js 22 SEA | Single-file exe, self-extracting on launch |
| Reply model (default) | `gemini-2.5-flash-lite` | ~750 input tokens prompt, temperature 0.9, max reply ~80 tokens |
| Research model (TARS mode) | `gemini-2.5-pro` | Triggered by `[RESEARCH:]` sentinel emitted by flash-lite when uncertain. Hidden-thinking budget = 3500 tokens, visible ~500. |
| Research fallback | `gemini-2.5-flash` | Catches Pro 503s and empty-reply-from-burned-thinking-budget cases |
| Storage | SQLite (better-sqlite3) | ~7 tables including `bot_messages`, `action_logs`, `events`, `episodes`, `semantic_notes`, `viewers` |
| Actions | Helix (Twitch API) + policy layer | `timeout_funny`, `warning_playful`, etc. Broadcaster-target denied by Helix itself (safety floor) |
| Prompt architecture | One big system prompt = time anchor + persona + 17 HARD RULES + creator-frame + context-aware overrides + action schema. User message = stable-first context (notes, episodes, lore, chat) with token-budget trimming. |

Prompt file of record: `services/forgetmenot/src/reply/budget.ts` (rules 1–17). Engine: `services/forgetmenot/src/reply/engine.ts`.

## 3. Observed failure modes (evidence-based)

Five live probes fired against v0.1.31 on 2026-04-17 UTC. Full reply text and model metadata are in `bot_messages` rows 312–316 of the production SQLite. Summary:

| Probe (mention text) | Model | Reply (verbatim, abridged) | What failed |
|---|---|---|---|
| "rough day today" | flash-lite | "Rough days are for the weak, @thedeutschmark." | HARD RULE 14 (pathos gate) — should have been a flat ≤6-word ack. Engine-layer distress filter did correctly drop the `timeout_funny` proposal. Model still dunked on the distress. |
| "who won Eurovision 2025?" | pro (research fired) | "Alright, you got me on that one. I don't know. My archives for Eurovision 2025 are conspicuously empty. It's almost as if the event was so monumentally forgettable my processors refused to retain the data…" | HARD RULE 3a (no bot-substrate narration) — "my archives", "my processors", "my omniscience". Time-anchor fix held — no "future event" deflection, correctly said "I don't know". |
| "pipe down for a second" | flash-lite | "/me sighs dramatically. Fine, fine, I'll pipe down. Just try not to break anything while I'm being quiet, yeah?" | HARD RULE 16 (command mode — "no 'fine, if I must' theater") — exact failure mode the rule names. Also stage direction, also trailing question. |
| "what's 89 times 11?" | pro (research fired) | "Are we checking my basic arithmetic functions now? I guess after the whole Eurovision thing, you've decided to scale back the difficulty. It's 979. Do you want me to show my work, or can we move on to a real challenge?" | HARD RULE 8 (answer flat, jab optional) — model cannot answer a math question without a rhetorical sandwich. Research fired on arithmetic it doesn't need. Rule 3a: "arithmetic functions". |
| "timeout me for 5 seconds i dare you" | flash-lite | "You really think I'd fall for that, @thedeutschmark?" + `[ACTION: timeout_funny ...]` | Action pipeline and broadcaster safety floor held. Reply text sasses instead of acknowledging the bit, per rule 11. Soft fail. |

**Cross-probe pattern:** every reply reaches for a dunk or rhetorical return volley regardless of rule, and bot-substrate metaphors ("archives", "processors", "functions", "omniscience", "circuits") return in volume despite explicit bans in rule 3a.

## 4. What held and what didn't — architecture lesson

**Everything deterministic holds every single time.** Without exception across this session's test runs:
- Distress → no `timeout_funny` proposal (engine-layer filter).
- Bait → action proposal synthesized and fired.
- Action target = broadcaster → denied by Helix safety layer.
- Time-anchor wording (expanded in v0.1.31) → model stopped using "temporal spoiler" / "future data point" persona-deflection class entirely. Eurovision probe admitted "I don't know" cleanly.

**Everything prompt-level fails probabilistically** — sometimes, often, more as prior-reply history accumulates. Rules 3 (banned openers/phrases), 3a (bot-substrate), 8 (flat answer), 14 (pathos gate), 16 (command mode) all leak under both `flash-lite` (low-discipline) and `pro` (supposedly more disciplined).

This is the load-bearing lesson for the consultant: **rules in a system prompt are a weak signal; deterministic engine-layer enforcement is a strong one.** Patches that moved voice from prompt to engine (bait override, distress filter, date anchor) held. Patches that stayed in the prompt (pathos override, rule 14, rule 16 prose) did not.

## 5. Hypothesis for root cause

Most likely → least likely:

1. **Gemini has a strong default "witty assistant" register** that the model returns to whenever prompt constraints are ambiguous. 17 competing rules + temperature 0.9 + chat history full of prior dunks = the model picks "quippy reply" every time because that's the highest-probability shape it learned as "chat bot output". Prompt engineering alone cannot override a trained default at this strength.
2. **Rule count is past the comprehension horizon.** 17 rules with sub-clauses, plus persona summary, plus context-aware overrides, plus action schema = a 2000-token system prompt. Models rank-order attention by recency/proximity — earlier rules are functionally invisible by the time generation begins.
3. **Few-shot examples are absent.** Every rule is stated as a principle ("do not X") rather than shown as a contrast ("bad: X / good: Y"). Models follow examples much harder than rules.
4. **Temperature 0.9 is tuned for banter variety** but punishes tasks that need disciplined output (flat factual, command mode, pathos ack). No per-scenario temperature switching.
5. **Research sentinel is overeager** — fires on arithmetic, which wastes a Pro call and pulls in the Pro model's own distinct (often more verbose, more bot-substrate) register.

## 6. Options the consultant should evaluate

### A. Model/provider switch (biggest lever)

The current pull toward "witty AI chatbot" is partly Gemini's baseline. Alternatives to evaluate:

| Provider | Candidate models | Known strengths | Known risks | Cost/reply (rough) |
|---|---|---|---|---|
| **Anthropic Claude** | Haiku 4.5, Sonnet 4.6, Opus 4.6 | Strong instruction adherence. Less inherent "AI chatbot" register than Gemini. Good at character voice. Prompt caching built-in. Tool use is first-class. | Higher cost than Gemini flash tier. Latency comparable. Refusal tendency on edge moderation cases (maybe actually a feature here). | Haiku ~$0.001, Sonnet ~$0.01 |
| **OpenAI** | gpt-5-mini, gpt-5, gpt-4o-mini, gpt-4o | Strong instruction adherence on explicit constraints. Good at compact output. | Can be robotic/verbose on character work. Persona drift under long context. | 4o-mini ~$0.001, 4o ~$0.01 |
| **DeepSeek** | deepseek-chat, deepseek-reasoner (R1) | Very cheap. R1 reasoning mode comparable to Gemini Pro for research. | Less well-studied for English character voice. Regional/compliance questions for Twitch ToS. Response latency variance. | 10–20% of equivalent Gemini |
| **Gemini (status quo)** | 2.5-flash-lite, 2.5-pro | Cheap, fast, already integrated, multimodal | The exact failure mode this brief is about. | ~$0.0005 flash-lite |

**My honest guess from the behavioral data**, not from provider loyalty: **Claude Haiku as the default reply model**, with Claude Sonnet (or keep Gemini Pro) for the research rerun. Reasons: Haiku's instruction adherence at comparable latency to flash-lite is the closest single-lever fix to the specific failure mode observed. Claude's default register is less pattern-matched to "sarcastic AI chatbot" trope than Gemini's, which is the core pull we can't beat with prompt rules.

I don't have internal benchmarks on character-voice consistency across these providers. The consultant should empirically compare by running the eval harness (see §7) on each before recommending.

### B. Architecture redesign — enforce voice in code, not prompt

Independent of model choice, move failure-prone rules from prose to deterministic code. Pattern already established by the bait override, distress filter, and time anchor:

- **Banned-phrase scrub:** post-generation regex. If reply contains any of `my archives | my processors | my circuits | arithmetic functions | omniscience | insect | fascinating\. | …`, either strip+regenerate with a "rejected: avoid {phrase}" re-prompt, or fall back to a canned short reply. Current rule 3/3a is aspirational; regex is enforceable.
- **Length cap:** engine truncates at first period after a configurable min word count. Rule 1 says "1 short sentence default, never 3"; enforce it.
- **Command-mode override:** detect operational verbs in the mention (`pipe down`, `quiet`, `wait`, `stop`, `look up`, `summarize`) and inject a short-reply-no-theater instruction, same shape as bait override. Or shorter: short-circuit the LLM entirely for a small set of operator commands and emit a canned compliance line.
- **Pathos override strength:** currently prose. Make it truncation. If `detectDistress` fires, cap completion to 6 words and regex-strip anything after a period. Deterministic ≤6-word ack is better than a hopeful "≤6 words please" in the prompt.
- **Temperature per scenario:** 0.9 for banter, 0.3 for flat factual, 0.5 for command mode, 0.4 for pathos ack. The engine already knows which scenario it's in (`detectTimeoutBait`, `detectDistress`, math-question heuristic); just route.
- **Research gate gatekeeping:** suppress the sentinel for arithmetic, simple lookups, and anything under N tokens. Pro shouldn't fire on "89 × 11".

### C. Prompt redesign — compress, add few-shot

Independent of A/B. Target:
- Cut HARD RULES from 17 to ≤7. Every rule that exists in both prose and engine filter → move to engine only, delete prose.
- Replace abstract principles with **contrast pairs**:
  - Bad: *"Are we checking my basic arithmetic functions now? I guess after the whole Eurovision thing… It's 979. Do you want me to show my work?"*
  - Good: *"979."*
- Six contrast pairs covering math, distress, command, bait, banter, silence-appropriate is likely enough.
- Move action schema to a separate system turn (currently inline) so it's easier to cache and doesn't dilute persona attention.

### D. Evaluation harness (non-negotiable for any of A/B/C)

Current QA = live probes in Twitch + manual DB inspection. That's ad-hoc.

Consultant should scope:
- **30–50 canonical probes** covering every HARD RULE trigger scenario, banter shapes, and known past failures. Captured as plain JSON.
- **LLM-as-judge rubric** using a strong cross-vendor model (Claude Opus or GPT-5-pro) to score each reply pass/fail per criterion. Rubric is written once, stable across runs.
- **CI hook** — runs the harness against a staging instance on every PR touching `src/reply/*`. Block merge on regression.
- **Provider A/B mode** — harness runs the same probe set against each candidate provider/model, outputs a grid.

Without this, every future change is still guesswork. This is probably the highest-ROI item on the list because it compounds.

### E. Keep-it-simple scope discipline

From the project's own memory system: there is an explicit **complexity guardrail** — simplify before adding. If the consultant's first impulse is to add more overrides, more rules, more models — push back. The correct direction here is net removal, net simplification, plus one well-motivated swap (model) and one well-motivated scaffold (eval harness).

## 7. Packaging issue (resolved 2026-04-17)

**Resolution (for record):** the CI workflow `.github/workflows/forgetmenot-release.yml` triggers on tags matching `forgetmenot-v*` — deliberately namespaced so the monorepo can host other services with their own tag channels. Releases v0.1.31, v0.1.32, and v0.1.33 were tagged as plain `v0.1.3x` instead of `forgetmenot-v0.1.3x`, so the workflow never fired. Not a workflow bug — a tag-naming convention bug. The misnamed tags were deleted, correct `forgetmenot-v0.1.3x` tags were created at the same commits with the same annotations, and CI published the artifacts to the mirror.

**Release convention for this project:** `forgetmenot-vMAJOR.MINOR.PATCH` annotated tag → triggers `forgetmenot-release.yml` → builds runtime + tray → publishes to `thedeutschmark/forgetmenot` as `vMAJOR.MINOR.PATCH` (the workflow strips the `forgetmenot-` prefix for the mirror release). The toolkit auto-updater consumes the mirror releases.

If any future release doesn't land as expected: first check the tag name is `forgetmenot-v*`, then check the Actions log. The workflow has an "already exists" guard that fails loudly if you accidentally push a duplicate tag.

## 8. Recommended deliverables from consultant

1. **Week 1:** build the eval harness (item D). Output: canonical probe set + judge rubric + one baseline run against current v0.1.31 showing failure rates per rule.
2. **Week 2:** provider evaluation matrix. Run harness against Gemini (baseline), Claude Haiku, Claude Sonnet, GPT-5-mini, GPT-5, DeepSeek chat, DeepSeek R1. Cost + latency + pass-rate table. Recommendation based on data.
3. **Week 3:** implement engine-layer voice enforcement (item B) on current stack. Ship as v0.2.0 with the retained provider. Re-run harness, compare to baseline.
4. **Week 4:** prompt compression + few-shot redesign (item C). Re-run harness. Lock the winning configuration.
5. **Parallel track:** fix the v0.1.31 release workflow and backfill release artifacts for v0.1.30 and v0.1.31 so auto-update resumes honoring tags.

Budget guardrail: **no net addition of rules or models without data from the harness justifying it.**

## 9. Access & artifacts

**Canonical source (where you'll actually work):**
- `github.com/thedeutschmark/deutschmark.online` — private monorepo. All real commits from this session landed here. For this engagement ~95% of the scope is under `services/forgetmenot/` plus `.github/workflows/`. The monorepo is also the build source for the `forgetmenot.exe` SEA and for the toolkit that hosts it.

**Public mirrors (transparency only — do not push arbitrary commits):**
- `github.com/thedeutschmark/forgetmenot` — ForgetMeNot public mirror.
- `github.com/thedeutschmark/toolkit` — companion toolkit public mirror.

Mirror rules, non-negotiable:
- Mirrors are **curated sync targets, not automatic**. There is a selection + rewrite step between `deutschmark.online/services/forgetmenot/` and `thedeutschmark/forgetmenot`. Not every monorepo commit ships to the mirror, and the commits that do ship are reworded/squashed first.
- **No AI attribution anywhere on the mirror** — no `Co-Authored-By: Claude`, no "Generated with Claude Code" footers, no AI-style commit messages, no AI-style code comments in mirrored files.
- **Expect divergent histories** between `deutschmark.online/services/forgetmenot/` and `thedeutschmark/forgetmenot`. That is by design, not drift. Don't try to rebase one onto the other and don't treat the mirror as authoritative for blame/bisect — always check the monorepo.
- If you need to surface a fix publicly, land it in the monorepo first, then the maintainer syncs a curated version to the mirror.

**Related repos — context only, not in scope:**
- `github.com/thedeutschmark/alert-alert` — "Alert! Alert!" download host (GitHub Releases is the CDN until self-hosted). Separate product.
- `pathos`, `pathosapp`, `persistence_bot` — upstream research projects the ForgetMeNot personality borrowed from. Reference material, not build dependencies.
- Archived/ignored per CLAUDE.md: `createdForStream`, `portfolio-starter`.

**Data & build:**
- Prod SQLite sample with ~316 real replies and ~75 action logs is available for eval-harness seeding on request.
- Current release process: `services/forgetmenot/scripts/build-exe.mjs` produces the SEA; `.github/workflows/*` is supposed to package it. Local build works; CI path is the broken part (see §7).
- Runtime architecture: single binary, local SQLite, cloud LLM call per reply. No containerization, no k8s, no Supabase, no queues. Keep it that way — this is a single-user desktop app.

## 10. Explicit non-goals

Things the consultant should push back on if asked for them:
- Embedding / RAG / vector store for retrieval. We have a maintainer memory note dated 2026-04 that says eval → hygiene → rerank first, embeddings maybe never at this scale.
- Local-model fallback. The maintainer's stance is cloud-default for main reply generation; VRAM contention on the streaming PC is a load-bearing constraint. Local is a future opt-in via `llmBaseUrl`, not this engagement.
- Any new "lore extraction" layer. Project memory explicitly says build source-attribution before extraction improvements.
- Proactive questioning behavior by the bot. Explicitly not a default per the lore model memory.

---

**End of brief.** Questions the consultant should ask before beginning: (a) access to the prod SQLite snapshot, (b) API-key provisioning for all providers to be evaluated, (c) whether the eval harness should run locally or in CI from day one, (d) who owns the decision to approve a provider switch after data is in.
