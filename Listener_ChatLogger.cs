using System;

public class CPHInline
{
    public bool Execute()
    {
        string user = GetArgAsString("userName", "UnknownUser");
        string message = GetArgAsString("message", string.Empty);
        string botName = GetGlobalOrDefault("perpetual_bot_name", "Auto_Mark");

        if (string.IsNullOrWhiteSpace(message))
        {
            return true;
        }

        // Skip logging the bot's own chat output to reduce prompt loops.
        if (string.Equals(user, botName, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        string existingBuffer = CPH.GetGlobalVar<string>("chat_buffer", true) ?? string.Empty;
        string newLine = "[" + user + "]: " + message;

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
