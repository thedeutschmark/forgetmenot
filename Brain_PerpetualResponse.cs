using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

public class CPHInline
{
    public bool Execute()
    {
        string botName = GetArgOrGlobalOrDefault("botName", "perpetual_bot_name", "Auto_Mark");

        try
        {
            string user = GetArgAsString("userName", "UnknownUser");
            string currentMessage = GetArgAsString("message", string.Empty);
            string chatBuffer = CPH.GetGlobalVar<string>("chat_buffer", true) ?? "(No recent chat history.)";
            string provider = GetArgOrGlobalOrDefault("aiProvider", "ai_provider", "gemini").Trim().ToLowerInvariant();

            // Load per-user lore — first from local file, fallback to Streamer.bot var
            string dataDir = GetGlobalOrDefault("perpetual_data_dir", string.Empty);
            string lore = LoadUserLore(user, dataDir);
            if (string.IsNullOrWhiteSpace(lore))
            {
                lore = CPH.GetTwitchUserVar<string>(user, "perpetual_lore", true);
            }
            if (string.IsNullOrWhiteSpace(lore))
            {
                lore = "Unknown Subject.";
            }

            // Load session memory (compressed summaries from previous streams)
            string sessionMemory = LoadSessionMemory(dataDir);

            if (provider != "gemini" && provider != "openai")
            {
                CPH.LogInfo(botName + ": Invalid provider '" + provider + "'.");
                CPH.SendMessage("Invalid provider. Set aiProvider to exactly gemini OR exactly openai.");
                return true;
            }

            List<string> exclusionList = CPH.GetGlobalVar<List<string>>("chatGptExclusions", true);
            if (exclusionList != null && exclusionList.Contains(user.ToLowerInvariant()))
            {
                return false;
            }

            string defaultEndpoint = provider == "openai"
                ? "https://api.openai.com/v1/chat/completions"
                : "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
            string defaultModel = provider == "openai" ? "gpt-4o-mini" : "gemini-2.5-flash";

            string endpoint = GetArgOrGlobalOrDefault("aiEndpoint", "ai_endpoint", defaultEndpoint);
            string model = GetArgOrGlobalOrDefault("aiModel", "ai_model", defaultModel);

            string apiKey = GetArgAsString("aiApiKey", string.Empty);
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                apiKey = provider == "openai"
                    ? GetArgOrGlobalOrDefault("openaiApiKey", "openai_api_key", string.Empty)
                    : GetArgOrGlobalOrDefault("geminiApiKey", "gemini_api_key", string.Empty);
            }
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                apiKey = GetGlobalOrDefault("ai_api_key", string.Empty);
            }
            if (string.IsNullOrWhiteSpace(apiKey) && provider == "gemini")
            {
                apiKey = GetGlobalOrDefault("google_api_key", string.Empty);
            }
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                CPH.SendMessage("I can't run yet. Missing " + provider + " API key.");
                return true;
            }

            string persona = GetArgOrGlobalOrDefault(
                "systemPrompt",
                "perpetual_system_prompt",
                "You are " + botName + ", a resident AI mod and robotic co-host. " +
                "Tone: witty, meta-humor, sarcastic, and playful. " +
                "Behavior: prioritize useful moderation/helpful answers, then add personality. " +
                "Keep replies concise (1-2 sentences). " +
                "Safety: no hate speech, threats, sexual content, or harassment; keep content streamer-safe.");
            persona = persona.Replace("{BOT_NAME}", botName);

            double temperature = 0.9;
            string tempStr = GetGlobalOrDefault("perpetual_temperature", string.Empty);
            if (!string.IsNullOrWhiteSpace(tempStr)) double.TryParse(tempStr, out temperature);

            int maxTokens = 140;
            string tokStr = GetGlobalOrDefault("perpetual_max_tokens", string.Empty);
            if (!string.IsNullOrWhiteSpace(tokStr)) int.TryParse(tokStr, out maxTokens);

            // Build context with session memory if available
            string contextBlock = "Bot Name: " + botName + "\n";
            if (!string.IsNullOrWhiteSpace(sessionMemory))
            {
                contextBlock += "Previous Session Memory:\n" + sessionMemory + "\n\n";
            }
            contextBlock += "Recent Chat Buffer:\n" + chatBuffer + "\n\n" +
                "Target User: " + user + "\n" +
                "Known Lore: " + lore + "\n" +
                "Current Message: " + currentMessage + "\n\n" +
                "Generate one in-character " + botName + " reply for Twitch chat.";

            var payload = new
            {
                model = model,
                temperature = temperature,
                max_tokens = maxTokens,
                messages = new object[]
                {
                    new { role = "system", content = persona },
                    new { role = "user", content = "Use this context to respond:\n" + contextBlock }
                }
            };

            string requestJson = JsonConvert.SerializeObject(payload);

            string responseText;
            string requestError;
            if (!TrySendChatCompletion(endpoint, apiKey, requestJson, out responseText, out requestError))
            {
                CPH.LogInfo(botName + " API Error: " + requestError);
                string shortError = string.IsNullOrWhiteSpace(requestError) ? "unknown_error" : requestError;
                if (shortError.Length > 120) shortError = shortError.Substring(0, 120);
                CPH.SendMessage("API error (" + provider + "): " + shortError);
                return true;
            }

            string botReply = ParseAssistantReply(responseText, botName);
            if (string.IsNullOrWhiteSpace(botReply))
            {
                CPH.SendMessage("I had the perfect line and then dropped my circuits.");
                return true;
            }

            string cleaned = Regex.Replace(botReply.Replace(Environment.NewLine, " "), @"\r\n?|\n", " ");
            cleaned = Regex.Unescape(cleaned).Trim();
            CPH.SetGlobalVar("_chatGptResponse", cleaned, false);
            CPH.SetArgument("finalGpt", cleaned);
            CPH.SendMessage(cleaned);
            return true;
        }
        catch (Exception ex)
        {
            CPH.LogInfo(botName + " Exception: " + ex.Message);
            CPH.SendMessage("My sarcasm core crashed. Try again.");
            return true;
        }
    }

    // ── Local file helpers ──

    private string LoadUserLore(string username, string dataDir)
    {
        if (string.IsNullOrWhiteSpace(dataDir)) return null;
        string lorePath = Path.Combine(dataDir, "lore", username.ToLowerInvariant() + ".txt");
        if (File.Exists(lorePath))
        {
            try { return File.ReadAllText(lorePath).Trim(); }
            catch { return null; }
        }
        return null;
    }

    private string LoadSessionMemory(string dataDir)
    {
        if (string.IsNullOrWhiteSpace(dataDir)) return null;
        string memPath = Path.Combine(dataDir, "memory", "latest_summary.txt");
        if (File.Exists(memPath))
        {
            try { return File.ReadAllText(memPath).Trim(); }
            catch { return null; }
        }
        return null;
    }

    // ── Network helpers ──

    private bool TrySendChatCompletion(string endpoint, string apiKey, string requestJson, out string responseText, out string requestError)
    {
        responseText = string.Empty;
        requestError = string.Empty;
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(endpoint);
            request.Headers.Add("Authorization", "Bearer " + apiKey);
            request.ContentType = "application/json";
            request.Method = "POST";
            byte[] bytes = Encoding.UTF8.GetBytes(requestJson);
            request.ContentLength = bytes.Length;
            using (Stream s = request.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
            HttpWebResponse response = (HttpWebResponse)request.GetResponse();
            using (Stream rs = response.GetResponseStream())
            using (StreamReader reader = new StreamReader(rs, Encoding.UTF8))
            {
                responseText = reader.ReadToEnd();
                if ((int)response.StatusCode < 200 || (int)response.StatusCode > 299)
                {
                    requestError = ((int)response.StatusCode) + " " + response.StatusDescription;
                    return false;
                }
            }
            return true;
        }
        catch (Exception ex) { requestError = ex.Message; return false; }
    }

    private string ParseAssistantReply(string rawJson, string botName)
    {
        try
        {
            JObject json = JObject.Parse(rawJson);
            JToken content = json.SelectToken("choices[0].message.content");
            return content == null ? string.Empty : content.ToString();
        }
        catch (Exception ex) { CPH.LogInfo(botName + " Parse Error: " + ex.Message); return string.Empty; }
    }

    private string GetGlobalOrDefault(string key, string fallback)
    {
        string value = CPH.GetGlobalVar<string>(key, true);
        return string.IsNullOrWhiteSpace(value) ? fallback : value;
    }

    private string GetArgOrGlobalOrDefault(string argKey, string globalKey, string fallback)
    {
        string fromArg = GetArgAsString(argKey, string.Empty);
        if (!string.IsNullOrWhiteSpace(fromArg)) return fromArg;
        return GetGlobalOrDefault(globalKey, fallback);
    }

    private string GetArgAsString(string key, string fallback)
    {
        if (!CPH.TryGetArg(key, out string value)) return fallback;
        return string.IsNullOrEmpty(value) ? fallback : value;
    }
}
