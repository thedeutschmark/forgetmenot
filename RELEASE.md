# Release ritual

Before pushing a `forgetmenot-v*` tag, run the eval gate.

```bash
# from services/forgetmenot
npm run eval:gate
```

The gate runs the full fixture suite against the current source, compares
to the committed baseline in `eval/baseline.json`, and exits non-zero if
any fixture regressed beyond tolerance:

- Overall score: > 5 percentage points drop → hard fail
- Any per-fixture reply/action/policy accuracy: > 10pp drop → hard fail
- Retrieval hit@k or recall: > 15pp drop → hard fail

Requires `GEMINI_API_KEY` or `BOT_LLM_API_KEY` in env. Each run hits the
LLM — costs a few cents, takes ~1 minute.

## When eval legitimately regresses

Sometimes you intentionally shift behavior (persona rewrite, new rule,
action threshold change). The gate will fail. If the new scores are
expected and accepted, update the baseline:

```bash
npm run eval:baseline
```

This rewrites `eval/baseline.json` from the current run. Commit that
file alongside the change that moved the numbers so the next release
compares against the new accepted state.

## What the gate catches

- Persona changes that make the bot skip replies it used to make.
- Policy tweaks that cause the action pipeline to deny things it used to allow (or vice versa).
- Retrieval regressions — notes the bot used to surface that it no longer does.
- Fixture-level coverage gaps (a fixture being unintentionally removed).

## What it doesn't catch

- Subjective quality ("sounds generic", "uses trope phrases"). Those
  still require reading actual output.
- Anything in a fixture we haven't written. Add fixtures when you find
  a class of behavior regression that the gate missed.
- Live integration issues (Helix API changes, Twitch IRC quirks). Those
  fail in production; no fixture can simulate them.

The gate is a floor, not a ceiling. Passing eval does not mean the
change is good — it means the change didn't obviously break anything the
suite already tests.
