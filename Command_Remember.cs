using System;
using System.IO;

/// <summary>
/// Live !remember command — hardcode a memory about a user mid-stream.
///
/// Trigger: Command "!remember" in Streamer.bot
/// Usage:
///   !remember @alice She always falls off the map
///   !remember I hate spiders (defaults to invoker)
///
/// Writes directly to lore/{username}.txt with duplicate check.
/// Falls back to Streamer.bot user variable if no data directory set.
/// Zero LLM cost — pure file write.
/// </summary>
public class CPHInline
{
    public bool Execute()
    {
        string botName = GetGlobalOrDefault("perpetual_bot_name", "Auto_Mark");
        string input = GetArgAsString("rawInput", string.Empty).Trim();
        string invoker = GetArgAsString("userName", "unknown").ToLowerInvariant();

        if (string.IsNullOrWhiteSpace(input) || input.Length < 5)
        {
            CPH.SendMessage("Usage: !remember [@user] [fact] — minimum 5 characters.");
            return true;
        }

        string targetUser = invoker;
        string fact = input;

        // Parse explicit target: !remember @alice She always falls off the map
        if (input.StartsWith("@"))
        {
            int firstSpace = input.IndexOf(' ');
            if (firstSpace > 1)
            {
                targetUser = input.Substring(1, firstSpace - 1).ToLowerInvariant();
                fact = input.Substring(firstSpace + 1).Trim();
            }
        }

        if (string.IsNullOrWhiteSpace(fact) || fact.Length < 5)
        {
            CPH.SendMessage("The memory fact must be at least 5 characters.");
            return true;
        }

        string dataDir = GetGlobalOrDefault("perpetual_data_dir", string.Empty);

        // Fallback: no local file storage — use Streamer.bot user variable
        if (string.IsNullOrWhiteSpace(dataDir))
        {
            string existing = CPH.GetTwitchUserVar<string>(targetUser, "perpetual_lore", true) ?? string.Empty;
            if (existing.IndexOf(fact, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                CPH.SendMessage("I already know that about " + targetUser + ".");
                return true;
            }
            string updated = string.IsNullOrWhiteSpace(existing) ? "- " + fact : existing + "\n- " + fact;
            CPH.SetTwitchUserVar(targetUser, "perpetual_lore", updated, true);
            CPH.SendMessage(botName + " locked in: " + targetUser + " — " + fact);
            return true;
        }

        // Standard path: local file storage
        string loreDir = Path.Combine(dataDir, "lore");
        Directory.CreateDirectory(loreDir);
        string filePath = Path.Combine(loreDir, targetUser + ".txt");

        // Duplicate check
        if (File.Exists(filePath))
        {
            string existing = File.ReadAllText(filePath);
            if (existing.IndexOf(fact, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                CPH.SendMessage("I already know that about " + targetUser + ".");
                return true;
            }
        }

        File.AppendAllText(filePath, "\n- " + fact);
        CPH.SendMessage(botName + " locked in: " + targetUser + " \u2014 " + fact);
        CPH.LogInfo(botName + " Remember: wrote lore for " + targetUser + " (" + fact.Length + " chars)");
        return true;
    }

    private string GetGlobalOrDefault(string key, string fallback)
    {
        string value = CPH.GetGlobalVar<string>(key, true);
        return string.IsNullOrWhiteSpace(value) ? fallback : value;
    }

    private string GetArgAsString(string key, string fallback)
    {
        if (!CPH.TryGetArg(key, out string value)) return fallback;
        return string.IsNullOrWhiteSpace(value) ? fallback : value;
    }
}
