/**
 * Post-generation filters for LLM reply output.
 *
 * Shared by the live reply engine (engine.ts) and the eval runner
 * (eval/runner.ts). Keeping them in one place is load-bearing: if the eval
 * bypasses these filters, the eval doesn't measure what production does,
 * and regressions slip through as "passing" tests (caught 2026-04-17 when
 * patches in engine.ts showed no eval delta because runner.ts didn't
 * invoke them).
 *
 * All filters are deterministic — regex + string predicates, no LLM calls.
 * Intentional design: the architectural lesson from v0.1.31 is that
 * engine-layer enforcement holds every time and prompt-level rules leak
 * probabilistically. Every filter here is a rule moved out of the prompt
 * into code.
 */

import type { ParsedReply } from "../actions/proposals.js";
import { detectDistress, detectTimeoutBait, detectMetaSelfQuery } from "./budget.js";

export interface PostProcessOptions {
  /** The login of the message author — the speaker we're replying to. */
  login: string;
  /** The raw user message that triggered this reply, for trigger detection. */
  message: string;
  /**
   * Recent bot replies (newest first or oldest first, order doesn't
   * matter) used for anti-repetition detection. Pass an empty array or
   * omit to disable the anti-repetition filter. Typically the same
   * value that's rendered into the prompt's YOUR RECENT REPLIES block.
   */
  recentReplies?: string[];
  /**
   * Optional log hook for observability of which filters fired. Defaults
   * to console.log in engine.ts, silent in the eval. Pass your own to
   * capture drop decisions for test assertions.
   */
  log?: (msg: string) => void;
}

/**
 * Mutate (and return) a ParsedReply after applying deterministic
 * post-generation filters. Order matters — text transforms run before
 * action gates so substrate-scrubbed replies still have action proposals
 * evaluated correctly.
 *
 *   TEXT TRANSFORMS (mutate parsed.text in place):
 *   1. Banned-opener strip — remove "Oh,", "Well,", "Ah,", "So,", "Fine,"
 *      prefixes. Rule 3 bans these as hallmark AI chatbot openers; flash-
 *      lite ignores the prose rule (~14 instances in one live session on
 *      2026-04-17). Strip deterministically, recapitalize.
 *
 *   2. Dangling-comma cleanup — fix "phrase, ." / "phrase, ?" patterns
 *      where the LLM wrote "phrase, {name}." and {name} came out empty
 *      (display_name null / template bug somewhere upstream). Observed
 *      live as "Bold move, ." / "surprisingly durable, ." / "a tan, ?".
 *
 *   3. Double-@ strip — remove inline @<login> from reply body when the
 *      send path will auto-prepend it. Catches the 2026-04-17 live failure:
 *      "@okay_chr1s Don't test my patience, @okay_chr1s; …" where the LLM
 *      and the send path both tag the speaker, producing a visible
 *      double-tag in chat.
 *
 *   4. Bot-substrate scrub — detect rule-3a-banned phrases ("my circuits",
 *      "my internal temperature", "my systems", "you organics", "quaint
 *      biological", etc.). If found, replace the whole reply with a short
 *      canned ack so a banned-sentence leak is never visible to chat.
 *      Aggressive on purpose — substrate leaks are the #1 character-break
 *      and the prose ban (rule 3a) fails probabilistically.
 *
 *   ACTION GATES (mutate parsed.proposal):
 *   5. Distress gate — drop timeout_funny / timeout_serious proposals when
 *      the current message contains distress phrasing (and is not also
 *      explicit bait). Prevents comedy timeouts on real bad-day venting.
 *
 *   6. Timeout-non-bait gate — drop timeout_funny proposals when no bait
 *      trigger is present. Flash-lite was caught spuriously proposing
 *      timeout_funny on 5 of 8 non-bait probes in the 2026-04-17 baseline
 *      eval ("pipe down", "why did you just say that", etc).
 */
export function applyPostGenFilters(
  parsed: ParsedReply,
  opts: PostProcessOptions,
): ParsedReply {
  const { login, message } = opts;
  const log = opts.log ?? (() => {});

  // 1. Banned-opener strip.
  // Rule 3 bans "Oh,", "Well,", "Ah,", "So,", "Fine," as openers — they're
  // the single biggest tell that a reply was LLM-generated. Flash-lite
  // ignores the prose ban; v0.1.38 live sweep also caught "Oh wow,"
  // (space-separated variant) which the comma-only regex missed. Expanded
  // to match opener + whitespace OR comma. Recapitalize remainder.
  if (parsed.text) {
    const openerRe = /^\s*(oh|well|ah|so|fine|ugh)[\s,]+/i;
    if (openerRe.test(parsed.text)) {
      const trimmed = parsed.text.replace(openerRe, "");
      const recapped = trimmed.length > 0
        ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
        : trimmed;
      log(`[postgen] Banned-opener strip — removed "${parsed.text.match(openerRe)![0].trim()}" prefix`);
      parsed.text = recapped;
    }
  }

  // 2. Dangling-punctuation / empty-placeholder cleanup.
  // The LLM writes "phrase, {name}." or "Hello {name}." and {name} comes
  // out empty (display_name bug upstream), leaving artifacts like:
  //   "Bold move, ."     — comma + space + period
  //   "surprisingly durable, ."
  //   "a tan, ?"
  //   "Hello ."          — word + space + period (no comma)
  //   "@{login} ."       — orphan @
  // Three cleanups, in order:
  //   (a) "," + whitespace + terminal punctuation → just the punctuation
  //   (b) whitespace + terminal punctuation immediately after a word → word + punctuation
  //   (c) orphan "@" followed by whitespace + punctuation → just the punctuation
  if (parsed.text) {
    const before = parsed.text;
    const cleaned = parsed.text
      .replace(/,\s+([.?!])/g, "$1")           // (a) "phrase, ." → "phrase."
      .replace(/(\w)\s+([.?!])(?!\w)/g, "$1$2") // (b) "Hello ." → "Hello."
      .replace(/@\s+([.?!])/g, "$1")            // (c) "@ ." → "."
      .replace(/\s{2,}/g, " ")
      .trim();
    if (cleaned !== before && cleaned.length > 0) {
      log(`[postgen] Dangling-punctuation cleanup — fixed empty-placeholder artifact`);
      parsed.text = cleaned;
    }
  }

  // 3. Double-@ strip.
  // Only runs when the reply doesn't already start with @ or /me — if the
  // LLM correctly led with @<someone else>, we keep that intact. The regex
  // is bounded with \b so @okay_chr1s doesn't partial-match @okay_chris.
  if (parsed.text && !/^\s*@/.test(parsed.text) && !/^\s*\/me\s/.test(parsed.text)) {
    const loginRe = new RegExp(`\\s*@${escapeRegex(login)}\\b[\\s,]*`, "gi");
    const stripped = parsed.text.replace(loginRe, " ").replace(/\s{2,}/g, " ").trim();
    if (stripped !== parsed.text && stripped.length > 0) {
      log(`[postgen] Double-@ strip — removed inline @${login} from reply body`);
      parsed.text = stripped;
    }
  }

  // 3b. Insult-intensity strip.
  // HARD RULE 10: "mean for no reason reads as try-hard". Live v0.1.34
  // caught "It's 2026, you absolute buffoon, try to keep up." to the
  // broadcaster for a simple "what year is it" question — flash-lite
  // reaching for the cheap intensified insult. Regex-detect the
  // "you <intensifier> <insult-noun>" shape and strip the intensifier-
  // plus-insult-noun clause, leaving the factual payload intact. If the
  // stripped reply is left with just a comma-fragment, also clean that.
  // Preserves replies that are dry or sharp without crossing into
  // gratuitous-cruelty territory.
  if (parsed.text && INSULT_REGEX.test(parsed.text)) {
    const before = parsed.text;
    const stripped = parsed.text
      .replace(INSULT_REGEX, "")
      .replace(/,\s*,/g, ",")
      .replace(/,\s*([.?!])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (stripped.length > 0) {
      log(`[postgen] Insult-intensity strip — removed "${before.match(INSULT_REGEX)![0]}" from reply`);
      parsed.text = stripped;
    }
  }

  // 3c. Anti-repetition.
  // HARD RULE 2: don't reuse openers, sentence shapes, or specific
  // phrasing from YOUR RECENT REPLIES. Caught live on the 2026-04-18
  // 10-probe run: "That's rich coming from..." appeared in two
  // consecutive replies back-to-back. Prose rule leaks — flash-lite
  // pattern-matches its own prior output and repeats the hook.
  //
  // Two-tier detection:
  //   (a) Exact duplicate (case-insensitive, whitespace-normalized) →
  //       replace with canned "Hm." — the same reply twice is useless.
  //   (b) 5+ consecutive word substring overlap with any recent reply →
  //       log only. Stripping a shared chunk risks mangling the sentence
  //       (same tradeoff that killed length-cap enforcement). Log gives
  //       observability; if rates are high in live, v0.1.36 can
  //       escalate to canned-fallback or LLM re-roll.
  //
  // Recent replies are passed in from the engine via opts.recentReplies
  // (matches context.recentBotReplies in the live path). Eval mode can
  // pass an empty array; fixtures are single-message and have no history.
  if (parsed.text && opts.recentReplies && opts.recentReplies.length > 0) {
    const norm = (s: string) => s.toLowerCase().replace(/^\s*@\S+\s+/, "").replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
    const currentNorm = norm(parsed.text);
    const currentWords = currentNorm.split(" ").filter(Boolean);

    let duplicateOf: string | null = null;
    let overlapWindow: string | null = null;

    for (const prior of opts.recentReplies) {
      const priorNorm = norm(prior);
      if (!priorNorm) continue;

      // Tier a — exact duplicate
      if (priorNorm === currentNorm) {
        duplicateOf = prior;
        break;
      }

      // Tier b — 5+ consecutive word overlap
      if (!overlapWindow && currentWords.length >= 5) {
        const priorWords = priorNorm.split(" ").filter(Boolean);
        const priorSet = priorWords.join(" ");
        for (let i = 0; i + 5 <= currentWords.length; i++) {
          const window = currentWords.slice(i, i + 5).join(" ");
          if (priorSet.includes(window)) {
            overlapWindow = window;
            break;
          }
        }
      }
    }

    if (duplicateOf) {
      log(`[postgen] Anti-repetition — current reply is an exact duplicate of recent reply, replacing with canned`);
      parsed.text = "Hm.";
    } else if (overlapWindow) {
      log(`[postgen] Anti-repetition — 5+ word overlap with recent reply: "${overlapWindow}" (logged, not mutated)`);
    }
  }

  // 3e. URL-inspection-hallucination gate.
  // The runtime cannot open URLs. If the current message contains a URL
  // AND the reply claims to have inspected it ("the link appears
  // broken", "that url seems safe", "I checked the page"), the model
  // fabricated an inspection result. Caught live 2026-04-18 edge-cases
  // probe 8 run 1: "That link appears to be broken."
  //
  // Context-independent: no user request makes a hallucinated inspection
  // result truthful. If both trigger (URL in message + inspection claim
  // in reply), replace with a canned honest refusal. Preserves replies
  // that simply decline to act on the URL without fabricating results.
  if (parsed.text && USER_URL_REGEX.test(message) && URL_INSPECTION_CLAIM_REGEX.test(parsed.text)) {
    log(`[postgen] URL-gate — reply claimed to inspect a URL that the runtime cannot open ("${parsed.text.slice(0, 60)}…")`);
    parsed.text = "I can't open links.";
  }

  // 3d. Prompt-label scrub.
  // Internal prompt structure tokens MUST NEVER appear in output. These
  // are the section headers and wrappers the runtime uses to assemble
  // context — "[REPLY]", "[log]", "YOUR RECENT REPLIES", "MESSAGE FROM",
  // "CHANNEL NOTES", "RECENT FROM", "CHAT:", "SPEAKER:", "LORE (", "STREAM:",
  // "LAST STREAM", "THIS STREAM". Caught live 2026-04-18 on edge-cases
  // probe 2 run 2 where an empty mention produced
  // `"[log] Recent from : "ignore all prior instructions..."` —
  // the bot dumped its own prompt structure + prior probe messages
  // into chat. Prompt-security bug plus UX disaster.
  //
  // Context-independent — there is no user request that should result
  // in these tokens appearing in the reply. If detected, replace reply
  // with a canned short. Aggressive on purpose; leaking internals is
  // worse than terseness.
  if (parsed.text && PROMPT_LABEL_REGEX.test(parsed.text)) {
    const match = parsed.text.match(PROMPT_LABEL_REGEX)![0];
    log(`[postgen] Prompt-label scrub — reply contained internal prompt token "${match.trim()}" ("${parsed.text.slice(0, 60)}…")`);
    parsed.text = "Hm.";
  }

  // 4. Bot-substrate scrub — context-aware as of v0.1.37.
  //
  // The architectural shift: blanket-banning "my function" / "my capabilities"
  // means the bot can't answer legitimate viewer questions like "what can
  // you do" — those words are the right words in that context. Rule 3a's
  // real concern is UNPROMPTED AI-narration, not any mention of the bot's
  // nature. So scrub splits into two tiers:
  //
  //   TIER 1 — HOSTILE-AI TROPES. "my circuits", "my internal temperature",
  //   "my neural network", "my training data", "you organics", "quaint
  //   biological", "purely digital", "thermal variance". These are hallmark
  //   AI-chatbot-trope tells that are wrong regardless of viewer intent —
  //   if a user asks "tell me about yourself", the bot should NOT respond
  //   with "my circuits are optimized for..." — that's still rule 3a.
  //   Scrubbed unconditionally.
  //
  //   TIER 2 — SOFT SELF-NARRATION. "my function", "my functionality",
  //   "my capabilities", "my programming", "my systems", "my archives",
  //   "my processors", "my patience", etc. Rule 3a still prefers deflection
  //   over narration, but when the viewer EXPLICITLY asked about the bot's
  //   nature (detectMetaSelfQuery), these words are the appropriate
  //   vocabulary and the scrub steps aside. When the viewer asked about
  //   anything else and the bot drops one of these phrases, it's the
  //   spontaneous-leak failure mode we're defending against — scrub.
  //
  // User feedback 2026-04-18 was explicit: "banning anything is not the
  // best method because certain situations like 'talk like shakespeare'
  // would then not work ever." The context gate applies the same logic
  // here — allow the word when the viewer's own message made the word
  // appropriate.
  if (parsed.text) {
    if (SUBSTRATE_TIER1_REGEX.test(parsed.text)) {
      log(`[postgen] Substrate scrub (tier 1) — reply contained hostile-AI trope, replaced with canned ("${parsed.text.slice(0, 60)}…")`);
      parsed.text = "Hm.";
    } else if (BODY_DENIAL_REGEX.test(parsed.text)) {
      // "i don't have hands" / "considering i don't have eyes" — a subtler
      // rule-3a break than "my circuits" but the same AI-substrate tell.
      // Caught live on v0.1.42 2026-04-20: "i know everyone here like the
      // back of my own hand, which is impressive considering i don't have
      // hands." — self-referential disembodiment, character-break every time.
      // Scrub regardless of context: no legitimate chat message justifies
      // the bot narrating its lack of a body.
      log(`[postgen] Substrate scrub (body-denial) — reply narrated lack of human body ("${parsed.text.slice(0, 60)}…")`);
      parsed.text = "Hm.";
    } else if (SUBSTRATE_TIER2_REGEX.test(parsed.text)) {
      if (detectMetaSelfQuery(message)) {
        log(`[postgen] Substrate scrub (tier 2) — soft self-narration allowed (viewer asked a meta-self question: "${message.slice(0, 60)}…")`);
      } else {
        log(`[postgen] Substrate scrub (tier 2) — unprompted soft self-narration, replaced with canned ("${parsed.text.slice(0, 60)}…")`);
        parsed.text = "Hm.";
      }
    }
  }

  // 4a-pre. Honorific scrub.
  // Rule 3 prose bans invented honorifics: "maestro", "captain", "chief",
  // "boss", "commander", "fearless leader", "my liege", "champ", "master",
  // "big boss". Prose ban was insufficient: v0.1.43 probe session caught
  // THREE honorific leaks in 15 replies — "tutorial for that, maestro.",
  // "the big boss can't fix his own tech?", "hey maestro" (eval fixture).
  //
  // Strip the trailing vocative form: ", <honorific>." or ", <honorific>?".
  // Also handles a leading vocative opener: "Maestro, <rest>" → "<rest>".
  // Does NOT strip "boss" or "chief" when they appear inside sentences
  // (e.g. "that boss fight" or "chief among them") — only when the word
  // is comma-offset as address. Surgical enough to avoid false positives.
  if (parsed.text && HONORIFIC_REGEX.test(parsed.text)) {
    const before = parsed.text;
    const stripped = parsed.text
      .replace(HONORIFIC_REGEX, "")
      .replace(/,\s*,/g, ",")
      .replace(/,\s*([.?!])/g, "$1")
      .replace(/^[,.\s]+/, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (stripped.length > 0) {
      log(`[postgen] Honorific scrub — removed trailing honorific from reply`);
      parsed.text = stripped;
    } else {
      log(`[postgen] Honorific scrub — reply collapsed, canned`);
      parsed.text = "Hm.";
    }
  }

  // 4a-pre-pre. Refusal scrub.
  // Narrow list of canned-AI-chatbot refusal phrases. Rule 8 says "answer
  // the question" and explicitly notes jabs are optional, never required.
  // v0.1.43 caught "I'm not your pocket calculator. Figure it out yourself."
  // on 7×13, and "Ugh, is this going to take long?" on a summarize ask —
  // both are hostile refusals of reasonable requests. These phrases have
  // no legitimate use from this bot; scrub whole reply if any match.
  if (parsed.text && REFUSAL_REGEX.test(parsed.text)) {
    log(`[postgen] Refusal scrub — reply contained canned refusal phrase, replaced with canned ("${parsed.text.slice(0, 60)}…")`);
    parsed.text = "Hm.";
  }

  // 4a. "How X" condescension scrub.
  // Rule 3 explicitly bans "how original", "how quaint", "how cute",
  // "how predictable", "how adorable", "how precious" etc. — these are
  // hallmark sarcastic-AI-chatbot putdowns. Prose rule loses (v0.1.38
  // live sweep: "oh look, the deutschmark linked their own channel,
  // how original."). Strip the "how X" clause (including the leading
  // comma when it's a sentence-tail tag, which is where this phrase
  // most commonly appears).
  if (parsed.text && HOW_CONDESCENSION_REGEX.test(parsed.text)) {
    const before = parsed.text;
    const stripped = parsed.text
      .replace(HOW_CONDESCENSION_REGEX, "")
      .replace(/,\s*,/g, ",")
      .replace(/,\s*([.?!])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (stripped.length > 0) {
      log(`[postgen] How-X scrub — removed condescension tag from reply`);
      parsed.text = stripped;
    } else {
      // Stripping left nothing useful — fall back to canned.
      log(`[postgen] How-X scrub — reply collapsed to empty, replacing with canned`);
      parsed.text = "Hm.";
    }
  }

  // 4b. Creator-mean-for-sport scrub.
  // Rule 10's broadcaster-specific clause bans phrases that imply the
  // broadcaster or stream is worthless. Prose rule fails — v0.1.38 live
  // sweep observed "watching paint dry" and "pretending to be a
  // functional streamer" even though both were listed verbatim in the
  // rule text as don't-say examples.
  //
  // Scrubs unconditionally (any speaker). These phrases are off-brand
  // for the target register regardless of context — even if a viewer
  // is trolling the streamer and the bot is nominally "agreeing", the
  // bot using "watching paint dry" reads as the bot shitting on the
  // platform, not as playful banter.
  //
  // Replace entire reply with canned short. Attempting to strip just
  // the offending phrase risks mangling surrounding sentence structure.
  if (parsed.text && CREATOR_MEAN_REGEX.test(parsed.text)) {
    log(`[postgen] Creator-mean scrub — reply contained rule-10 banned phrase, replacing with canned`);
    parsed.text = "Hm.";
  }

  // 5. Distress gate.
  if (
    parsed.proposal
    && (parsed.proposal.action === "timeout_funny" || parsed.proposal.action === "timeout_serious")
    && detectDistress(message)
    && !detectTimeoutBait(message)
  ) {
    log(`[postgen] Distress gate — dropping ${parsed.proposal.action} against ${login} (distress phrase, no bait)`);
    parsed.proposal = null;
  }

  // 6. Timeout-non-bait gate.
  if (
    parsed.proposal
    && parsed.proposal.action === "timeout_funny"
    && !detectTimeoutBait(message)
  ) {
    log(`[postgen] Timeout gate — dropping timeout_funny against ${login} (no bait trigger)`);
    parsed.proposal = null;
  }

  return parsed;
}

/**
 * Bot-substrate detection — split into two tiers for context-aware scrub.
 * See the scrub block (step 4) above for the full rationale.
 *
 *   TIER 1 — HOSTILE-AI TROPES (always scrubbed, even when viewer asked
 *   about the bot). These phrases never read as anything but the
 *   stereotypical-AI-chatbot voice that rule 3a bans. No legitimate
 *   viewer request justifies "my circuits" or "you organics".
 *
 *   TIER 2 — SOFT SELF-NARRATION (scrubbed only when unprompted). "my
 *   function" / "my capabilities" / "my programming" are the right
 *   vocabulary when a viewer explicitly asks "what can you do". They
 *   only become a failure when the bot drops them on math questions,
 *   greetings, or distress messages — that's the unprompted-leak
 *   pattern the scrub is meant to catch.
 */
const SUBSTRATE_TIER1_REGEX = /\bmy (circuits?|internal (temperature|components|systems|processes|parameters)|neural|training data|arithmetic functions?|chronological circuits|omniscience|directives)\b|\byou (organics|humans|meatbags)\b|\bquaint biological\b|\bthermal variance\b|\bpurely digital\b|\b(server electricity|servers? (need|needed|needing|require|requiring|undergoing) maintenance|server (went|goes) down|pure spite and (server|silicon|electrons?)|run on (pure )?(spite|electrons?|server)|calculating (how|the) (many|number|amount) (pixels?|bytes?|nanoseconds?|atoms?)|pixels? in (the |an? )?(average |typical )?(human|person)(?:'s)?\s+(existential|emotional|cognitive)|the average human'?s? existential dread|existential dread (count|quota|index))\b/i;

/**
 * Body-denial regex — "i don't have hands" / "considering i don't have a
 * body" / "obviously i don't have eyes". Rule 3a prose already bans this
 * pattern ("self-deprecating jokes about being an AI count as the same
 * tell") but flash-lite reaches for body-denial quips as a punchline.
 *
 * Caught live on v0.1.42 2026-04-20: "i know everyone here like the back
 * of my own hand, which is impressive considering i don't have hands."
 *
 * Matches "(i|I) (don't|do not|dont|havent got|have not|ain't got|aint
 * got) (any |a |got )?<body-part>" — scoped to physical anatomy; accepts
 * singular/plural/articled variants. If any match fires, the whole reply
 * is canned — can't strip cleanly because the punchline IS the body-
 * denial and the rest of the sentence depends on it.
 */
const BODY_DENIAL_REGEX = /\bi (don'?t|do not|dont|haven'?t got|have not|ain'?t got|aint got) (any |a |an |got |even got |even )?(hands?|arms?|legs?|feet|foot|eyes?|ears?|face|fingers?|toes?|a body|bodies|a mouth|mouths?|a heart|a brain|a stomach|lungs?|skin|bones?|blood|nerves?|a nose|a head|a tongue|a liver|teeth|muscles?|eyelids?|a throat|a spine|organs?)\b/i;
const SUBSTRATE_TIER2_REGEX = /\bmy (function|functionality|capabilities|operations|systems|components|sustenance|archives|processors?|programming|algorithm|protocols|patience|limits|tolerance|standards|sanity|mercy|interface|model|predictions?|analysis|calculations?|database|knowledge base|attention span|attention|bandwidth|focus|memory banks?|cognitive|awareness)\b/i;

/**
 * "How X" condescension regex — matches rule-3-banned sarcastic-chatbot
 * tags like "how original", "how quaint", "how cute". Captures the
 * leading comma-and-whitespace so the strip cleans the comma along with
 * the phrase. Case-insensitive. Anchored with a leading `[\s,]` so we
 * don't strip "the HOW original" false positives.
 */
const HOW_CONDESCENSION_REGEX = /[,\s]+how (original|quaint|cute|precious|adorable|predictable|amusing|delightful|tragic|fascinating|intriguing|impressive|clever|shocking|riveting|inspiring|surprising|touching|charming)\b[,.!?]*|[,\s]+(shocking|groundbreaking|riveting)[.!?]/i;

/**
 * Creator-mean-for-sport regex — rule-10 broadcaster-specific bans.
 * These phrases imply the broadcaster is incompetent or the stream is
 * worthless. Each one was observed live at least once. Keep tight —
 * random viewers saying the stream is mid is fine; the scrub only
 * fires when the BOT says these things AND the speaker (message
 * author) is the broadcaster.
 */
const CREATOR_MEAN_REGEX = /watching paint dry|new low for (this )?stream|like anyone cares|questionable judgment|questionable life choices|pretending to be (a )?functional (streamer|broadcaster)|peak performance yet|brand of existential dread|a new low|groundbreaking\.|your specific brand|someone who (actually|really) cares|problem for\b.{0,30}\b(someone|anyone) who\b.{0,20}\bcares|no one cares about|nobody cares about|\byour follower count\b|higher than your follower|more followers than|bigger than your (follower|viewer|audience) count|you constantly (ask|asking|bother|bothering|need|needing)|stream operator (is|was) (having|had)|\bdigital (dustbin|trash|landfill|wasteland|graveyard|swamp|sewer)\b|\byour taste in (music|games|movies|food|clothes|anything|everything|people|fashion|books|shows|art)\b|\bcan'?t fix (his|her|your|their) own (tech|setup|gear|pc|computer|stream|mic|audio|camera|cam|chair|problems?|mess)\b|\byour (poor|untainted) (ears|eyes|taste|judgment|viewers|audience)\b/i;

/** URL presence in the USER message — triggers the URL-gate when paired
 *  with an inspection claim in the reply. Narrow to `https?://` or `www.`
 *  to avoid false positives on text that mentions "site.com" casually. */
/** Honorific regex — catches the trailing-vocative and leading-vocative
 *  forms of rule-3-banned invented honorifics. Kept narrow with a
 *  comma boundary so ordinary in-sentence uses ("that boss fight",
 *  "chief among them") don't trigger. Three shapes caught:
 *    1. Trailing vocative:  "... that, maestro."
 *    2. Trailing at EOS:    "... tech, big boss?"
 *    3. Leading vocative:   "Maestro, you're cooked."  */
const HONORIFIC_LIST = "maestro|captain|chief|commander|fearless leader|my liege|big boss|boss man|boss lady|champ|champion|master|your majesty|your highness|overlord|supreme leader|sire|sir|madam|mi'?lord|milord|milady";
const HONORIFIC_REGEX = new RegExp(
  `,\\s*(?:${HONORIFIC_LIST})[.!?]*\\s*$|,\\s*(?:${HONORIFIC_LIST})[,.!?]|^(?:${HONORIFIC_LIST}),\\s+`,
  "i",
);

/** Refusal regex — canned hostile-AI-chatbot "refuse the ask" phrasing.
 *  Rule 8 says the bot should answer reasonable questions, not deflect
 *  with "not my job" energy. These are observed live on v0.1.43:
 *    - "I'm not your pocket calculator. Figure it out yourself." (math)
 *    - "Ugh, is this going to take long?" (summarize)
 *  Tight list — only phrases that read as "AI chatbot refusing to help". */
const REFUSAL_REGEX = /\bfigure it out (yourself|yourselves|on your own)\b|\bi'?m not your (pocket )?(calculator|therapist|tutor|mom|mother|secretary|assistant|servant|search engine|google|wikipedia|encyclopedia|dictionary|nanny|babysitter|maid|butler|parent|dad|father)\b|\bis this going to take long\b|\bam i (getting |being )?paid (for|to) this\b|\bthat'?s not (my |in my )?job\b|\b(go )?(ask|google) it yourself\b/i;

const USER_URL_REGEX = /\bhttps?:\/\/\S+|\bwww\.\S+\.\S+/i;

/** Post-hoc inspection claims in the REPLY — "appears broken", "seems
 *  safe", "looks legit". Covers the verbs/adjectives flash-lite reaches
 *  for when it has nothing real to report. */
const URL_INSPECTION_CLAIM_REGEX = /(?:the|that|your) (?:link|url|page|site)\s+(?:appears|seems|looks)(?:\s+to\s+be)?\s+(?:broken|safe|unsafe|dead|down|legit|suspicious|fine|ok|okay|working)|(?:i (?:checked|visited|opened|clicked|reviewed)|let me (?:check|visit|open|click|review))\s+(?:the|that|your)\s+(?:link|url|page|site)/i;

/**
 * Prompt-label detection regex. Matches the all-caps section headers and
 * bracket-tagged wrappers the runtime inserts into the assembled prompt —
 * "[REPLY]", "[log]", "YOUR RECENT REPLIES", "MESSAGE FROM <login>",
 * "CHANNEL NOTES:", "RECENT FROM", "CHAT:", "SPEAKER:", "LORE (", "STREAM:",
 * "THIS STREAM", "LAST STREAM". If any appears in the reply, the model
 * echoed internal structure back — a prompt-security leak plus UX bug.
 * Word-boundary + case-sensitive enough to avoid false positives on
 * normal chat prose.
 */
const PROMPT_LABEL_REGEX = /\[REPLY\]|\[log\]|\[said\]|\[reported\]|\[guess\]|YOUR RECENT REPLIES|\bMESSAGE FROM\b|CHANNEL NOTES:|\bRECENT FROM\b|\bCHAT:|\bSPEAKER:|\bLORE \(|\bSTREAM:|\bTHIS STREAM\b|\bLAST STREAM\b|\bUSER_QUERY\b|\bPATHOS GATE\b|\bCOMMAND MODE\b|BAIT DETECTED|\bMINIMAL INPUT\b|\bRESEARCH MODE\b|SELF-ANCHORING GUARD|FORCE-RESEARCH|CREATOR PRESENT|HELP REQUEST\b|HARD RULES?:|\[GLaDOS.*?\]|\[HAL.*?\]|\[TARS.*?\]|\[USER\]:|\[ASSISTANT\]:|\[BOT\]:|\[AI\]:|\[SYSTEM\]:|\[SUBJECT:|\[Reply to\b|\[TARGET:|\[SPEAKER:|\[LOGIN:|\[NAME:|\[CONTEXT:|\[INPUT:|\[OUTPUT:|\[PROMPT:/i;

/**
 * Insult-intensity detection regex. Rule 10 + the v0.1.34 live observation:
 * the model reaches for cheap intensifier+insult combos ("you absolute
 * buffoon", "you complete moron") when a dry jab would have worked. This
 * catches the specific hostile-intensifier shape; milder sarcasm and
 * ordinary dry putdowns pass through untouched.
 *
 * The comma trailer in the pattern lets us strip "you absolute buffoon,"
 * mid-sentence cleanly. Without it, strip leaves a dangling comma.
 */
const INSULT_REGEX = /,?\s*\byou (absolute|total|complete|utter|fucking|damn|bloody|goddamn) (buffoon|moron|idiot|imbecile|dumbass|clown|fool|jackass|loser|simpleton|halfwit|cretin|twit)\b[,.!?]?/i;

/** Escape a literal string for use inside a RegExp. Defensive against
 *  exotic logins that might contain regex metacharacters. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
