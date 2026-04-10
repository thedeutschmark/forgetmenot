using System;

/// <summary>
/// Transcript logger — captures streamer speech via Streamer.bot's
/// Speech-to-Text action and appends it to the session buffer.
///
/// Trigger: Streamer.bot Speech-to-Text result (or any action that
///          provides a "speechResult" / "message" argument with the
///          transcribed text).
///
/// This does NOT replace your visible captions. It runs in parallel
/// and only feeds the persistence memory system. The Brain and Compress
/// scripts read session_buffer_full — they don't care whether a line
/// came from chat or from the streamer's mic.
///
/// Lines are prefixed [STREAMER] so the LLM can distinguish between
/// what chat said and what the streamer said when building context.
/// </summary>
public class CPHInline
{
    public bool Execute()
    {
        // Streamer.bot Speech-to-Text typically provides the result
        // as "speechResult" or "message" depending on the action config.
        string transcript = GetArgAsString("speechResult", string.Empty);
        if (string.IsNullOrWhiteSpace(transcript))
        {
            transcript = GetArgAsString("message", string.Empty);
        }
        if (string.IsNullOrWhiteSpace(transcript))
        {
            return true; // Nothing transcribed (silence, noise, etc.)
        }

        // Hybrid filter: skip filler words AND fragments too short to
        // carry meaning. STT fires constantly — most of it is noise.
        string cleaned = transcript.Trim();
        if (cleaned.Length < 3) return true;

        // Filler word blocklist — common STT noise across English speakers.
        // Exact match after lowercasing + stripping trailing punctuation.
        string normalized = cleaned.TrimEnd('.', ',', '!', '?').ToLowerInvariant();
        if (IsFillerOnly(normalized)) return true;

        // Word count gate — single-word utterances that aren't filler
        // still rarely carry useful context for memory.
        int wordCount = normalized.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries).Length;
        if (wordCount < 2) return true;

        string botName = GetGlobalOrDefault("perpetual_bot_name", "Auto_Mark");
        string newLine = "[STREAMER]: " + cleaned;

        // Append to session buffer (full, for compression)
        string existingSessionBuffer = CPH.GetGlobalVar<string>("session_buffer_full", true) ?? string.Empty;
        string sessionCombined;
        if (string.IsNullOrWhiteSpace(existingSessionBuffer))
        {
            sessionCombined = newLine;
        }
        else
        {
            sessionCombined = existingSessionBuffer + "\n" + newLine;
        }
        CPH.SetGlobalVar("session_buffer_full", sessionCombined, true);

        // Also append to the live chat buffer so the Brain has
        // streamer speech context for real-time replies.
        string existingBuffer = CPH.GetGlobalVar<string>("chat_buffer", true) ?? string.Empty;
        string combined;
        if (string.IsNullOrWhiteSpace(existingBuffer))
        {
            combined = newLine;
        }
        else
        {
            combined = existingBuffer + "\n" + newLine;
        }

        const int maxChars = 1000;
        if (combined.Length > maxChars)
        {
            combined = combined.Substring(combined.Length - maxChars);
            int firstNewline = combined.IndexOf('\n');
            if (firstNewline >= 0 && firstNewline < combined.Length - 1)
            {
                combined = combined.Substring(firstNewline + 1);
            }
        }

        CPH.SetGlobalVar("chat_buffer", combined, true);

        CPH.LogInfo(botName + " Transcript: logged " + cleaned.Length + " chars");
        return true;
    }

    // Filler detection — covers hesitation markers, backchannels,
    // and single-word acknowledgments that STT picks up constantly.
    // Source: common disfluency patterns from speech recognition literature.
    private static readonly System.Collections.Generic.HashSet<string> Fillers =
        new System.Collections.Generic.HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            // Hesitation markers
            "uh", "um", "uhh", "umm", "erm", "hmm", "hm", "hmmmm",
            "ah", "ahh", "eh", "er", "mm", "mmm", "mhm",
            // Backchannels
            "yeah", "yep", "yup", "ya", "nah", "nope", "no",
            "ok", "okay", "sure", "right", "alright",
            // Single-word reactions
            "wow", "oh", "ooh", "oof", "lol", "haha", "ha",
            "nice", "cool", "true", "same", "yes", "yo",
            // STT artifacts
            "thank you", "thanks", "bye", "hello", "hi", "hey",
            // Trailing filler
            "so", "well", "like", "anyway", "anyways", "basically",
        };

    private static bool IsFillerOnly(string text)
    {
        return Fillers.Contains(text);
    }

    private string GetGlobalOrDefault(string key, string fallback)
    {
        string value = CPH.GetGlobalVar<string>(key, true);
        return string.IsNullOrWhiteSpace(value) ? fallback : value;
    }

    private string GetArgAsString(string key, string fallback)
    {
        if (!CPH.TryGetArg(key, out string value))
        {
            return fallback;
        }

        return string.IsNullOrEmpty(value) ? fallback : value;
    }
}
