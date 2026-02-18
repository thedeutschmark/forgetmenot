using System;
using System.Collections.Generic;

public class CPHInline
{
    public bool Execute()
    {
        string providerInput = GetArgAsString("aiProvider", "gemini").Trim().ToLowerInvariant();
        string provider = providerInput == "openai" ? "openai" : "gemini";

        string apiKey = GetArgAsString("aiApiKey", string.Empty).Trim();
        string modelInput = GetArgAsString("aiModel", string.Empty).Trim();
        string endpointInput = GetArgAsString("aiEndpoint", string.Empty).Trim();
        string behavior = GetArgAsString("behavior", string.Empty);
        bool broadcasterReplies = ParseBool(GetArgAsString("broadcasterReplies", "true"), true);

        string model = string.IsNullOrWhiteSpace(modelInput)
            ? (provider == "openai" ? "gpt-4o-mini" : "gemini-2.5-flash")
            : modelInput;
        string endpoint = string.IsNullOrWhiteSpace(endpointInput)
            ? (provider == "openai"
                ? "https://api.openai.com/v1/chat/completions"
                : "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions")
            : endpointInput;

        List<string> exclusions = new List<string>
        {
            "streamelements",
            "nightbot",
            "streamlabs",
            "pokemoncommunitygame",
            "kofistreambot",
            "fourthwallhq"
        };

        var twitchBot = CPH.TwitchGetBot();
        if (twitchBot != null && !string.IsNullOrWhiteSpace(twitchBot.UserLogin))
        {
            exclusions.Add(twitchBot.UserLogin.ToLowerInvariant());
        }

        var twitchBroadcaster = CPH.TwitchGetBroadcaster();
        if (!broadcasterReplies && twitchBroadcaster != null && !string.IsNullOrWhiteSpace(twitchBroadcaster.UserLogin))
        {
            exclusions.Add(twitchBroadcaster.UserLogin.ToLowerInvariant());
        }

        CPH.SetGlobalVar("ai_provider", provider, true);
        CPH.SetGlobalVar("ai_model", model, true);
        CPH.SetGlobalVar("ai_endpoint", endpoint, true);
        CPH.SetGlobalVar("chatGptExclusions", exclusions, true);

        if (!string.IsNullOrWhiteSpace(apiKey))
        {
            if (provider == "openai")
            {
                CPH.SetGlobalVar("openai_api_key", apiKey, true);
            }
            else
            {
                CPH.SetGlobalVar("gemini_api_key", apiKey, true);
            }
        }

        if (!string.IsNullOrWhiteSpace(behavior))
        {
            CPH.SetGlobalVar("perpetual_system_prompt", behavior, true);
        }

        CPH.LogInfo("Perpetual options updated. provider=" + provider + ", model=" + model);
        return true;
    }

    private bool ParseBool(string value, bool fallback)
    {
        bool parsed;
        return bool.TryParse(value, out parsed) ? parsed : fallback;
    }

    private string GetArgAsString(string key, string fallback)
    {
        if (!CPH.TryGetArg(key, out string value))
        {
            return fallback;
        }

        return string.IsNullOrWhiteSpace(value) ? fallback : value;
    }
}
