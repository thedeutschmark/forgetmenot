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

        // Skip very short fragments — STT often fires partial results
        // like "uh" or "um" that add noise without value.
        if (transcript.Trim().Length < 8)
        {
            return true;
        }

        string botName = GetGlobalOrDefault("perpetual_bot_name", "Auto_Mark");
        string newLine = "[STREAMER]: " + transcript.Trim();

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

        CPH.LogInfo(botName + " Transcript: logged " + transcript.Trim().Length + " chars");
        return true;
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
