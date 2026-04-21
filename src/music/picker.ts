/**
 * Music picker — single LLM call that suggests ONE song based on the
 * recent !sr requests in chat. Used by both autonomous chime and the
 * abstract-music-ask handler.
 *
 * Output is a free-form "Title - Artist" string that gets shipped as
 * `!sr <output>` through the chat send path. The widget's existing
 * !sr handler then queues it via Spotify's search → queue API exactly
 * as if a viewer typed it.
 *
 * Uses gemini-2.5-flash-lite for cost. Picking music well doesn't need
 * the full flash; vibe matching is a small task and cheap creativity
 * (high temperature) beats careful instruction following here.
 */

import { chatCompletion } from "../llm/adapter.js";
import type { SrRequest } from "./sr-tracker.js";

const PICKER_MODEL = "gemini-2.5-flash-lite";

export interface PickerInput {
  /** Recent !sr requests from the buffer, oldest first works fine. */
  recentRequests: SrRequest[];
  /** Optional hint when the chime fired in response to an abstract ask
   *  ("play something chill", "drop a banger"). The hint is the viewer's
   *  raw message — keeps tone fluid without a parsing step. */
  abstractAskHint?: string;
  apiKey: string;
}

export interface PickerResult {
  /** The song the LLM picked, formatted "Title - Artist" or similar.
   *  Suitable to splice directly into `!sr <pick>`. Null when the LLM
   *  declined or returned nothing usable. */
  query: string | null;
  /** Raw LLM output before cleanup, for logging. */
  raw: string;
  /** finish_reason from the model. "length" means we capped it. */
  finishReason: string | null;
}

/**
 * Ask the model for one song that fits the vibe. The function does
 * its own light cleanup — strips quotes, drops common preambles
 * ("I'd suggest:", "Try:"), trims to a reasonable length. If the
 * model returns multiple lines, takes the first non-empty one.
 *
 * Returns `query: null` when the model returned nothing usable; caller
 * should silently skip rather than send an empty `!sr `.
 */
export async function pickSongFromVibe(input: PickerInput): Promise<PickerResult> {
  const { recentRequests, abstractAskHint, apiKey } = input;

  // Take the most recent 15 distinct queries — older ones drift off
  // the vibe. De-dupe on the query string so a viewer spamming the
  // same !sr 5 times doesn't dominate the signal.
  const seen = new Set<string>();
  const distinctRecent: string[] = [];
  for (const r of recentRequests.slice().reverse()) {
    const key = r.query.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    distinctRecent.push(r.query);
    if (distinctRecent.length >= 15) break;
  }

  const requestsBlock = distinctRecent.length > 0
    ? distinctRecent.map((q) => `- ${q}`).join("\n")
    : "(no recent requests in chat — pick something universally good)";

  const askHintBlock = abstractAskHint
    ? `\nA viewer just asked you to add a song with this vibe:\n"${abstractAskHint.trim().slice(0, 240)}"\n`
    : "";

  const systemContent = [
    "You suggest ONE song that fits the vibe of recent chat song requests.",
    "REQUIRED OUTPUT FORMAT: `<Title> - <Artist>` on ONE LINE. The dash with spaces is required — Spotify's search treats it as the separator and dropping it produces zero matches.",
    "GOOD output: `After Dark - Mr.Kitty` / `Take On Me - a-ha` / `Midnight City - M83` / `Sunset Lover - Petit Biscuit`",
    "BAD output: `Midnight City M83` (no dash — search will fail), `I would suggest: ...`, `Try this:`, multiple suggestions, quotes, markdown, emojis (no ➕, ✅, 🎵), bullet points, justification text after the song.",
    "The chat will queue your output via `!sr <your output>` going through Spotify search exactly as written. The separator MATTERS.",
    "If you genuinely can't pick something matching the vibe, output exactly: SKIP",
    "Do not pick a song that already appears in the recent requests list — pick something complementary, not duplicate.",
  ].join(" ");

  const userContent = `Recent !sr requests in chat (most recent first):\n${requestsBlock}\n${askHintBlock}\nSuggest ONE song. Title and artist only. One line.`;

  let response;
  try {
    response = await chatCompletion(
      { provider: "gemini", model: PICKER_MODEL, apiKey },
      {
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: userContent },
        ],
        // Higher temperature = more variety in picks across calls
        temperature: 1.0,
        // 60 tokens is plenty for a song title + artist
        maxTokens: 60,
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { query: null, raw: `ERROR: ${msg.slice(0, 120)}`, finishReason: null };
  }

  const raw = (response.text || "").trim();

  if (!raw || /^SKIP$/i.test(raw)) {
    return { query: null, raw, finishReason: response.finishReason };
  }

  const cleaned = cleanupPick(raw);
  if (!cleaned) {
    return { query: null, raw, finishReason: response.finishReason };
  }

  return { query: cleaned, raw, finishReason: response.finishReason };
}

/**
 * Strip common LLM preambles, quotes, markdown, multi-line wrappers.
 * Returns null if the result is empty or obviously broken.
 */
function cleanupPick(raw: string): string | null {
  // Take first non-empty line (some models append a justification line).
  const firstLine = raw.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
  if (!firstLine) return null;

  let s = firstLine;

  // Drop common preambles.
  s = s.replace(
    /^(i'?d? (suggest|recommend|pick|go with|throw on)|how about|try (this|something like)|let'?s go with|maybe|perhaps|here'?s one|consider)[:\s,]+/i,
    "",
  );
  // Drop "Song:" / "Track:" labels.
  s = s.replace(/^(song|track|pick|suggestion|answer|reply)\s*[:\-—]\s*/i, "");
  // Strip surrounding quotes / markdown.
  s = s.replace(/^["'`*_]+|["'`*_]+$/g, "");
  // Strip leading bullet / dash / decorative emoji prefix. The model
  // sometimes prepends a "queue add" indicator like ➕ or ✅ even when
  // told not to. Live failure 2026-04-21: bot sent "➕ MGMT - Electric
  // Feel" to chat instead of "!sr MGMT - Electric Feel", didn't queue.
  s = s.replace(/^[\-•*➕✅🎵🎶▶️⏯️▶️♪♫►→]\s*/, "");
  // Collapse internal whitespace.
  s = s.replace(/\s+/g, " ").trim();

  // Enforce the "Title - Artist" dash format. If the model dropped the
  // dash separator, Spotify search returns zero matches and the !sr
  // silently fails. We can't reliably reconstruct the title/artist
  // boundary from a flat string ("Midnight City M83"), so when the
  // dash is missing we reject the pick and let the caller skip this
  // chime cycle. Better to skip than to ship a !sr that won't queue.
  if (!s.includes(" - ") && !s.includes(" – ") && !/\sby\s/i.test(s)) {
    return null;
  }

  // Length sanity. A song title + artist over 100 chars is almost
  // certainly broken (e.g. an LLM apology in disguise).
  if (s.length === 0 || s.length > 100) return null;

  // Reject obvious refusals.
  if (/^(no|sorry|i (can'?t|won'?t|cannot)|none|nothing|n\/a|skip)$/i.test(s)) return null;

  return s;
}
