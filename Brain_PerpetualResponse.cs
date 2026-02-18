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
            string lore = CPH.GetTwitchUserVar<string>(user, "perpetual_lore", true);
            string provider = GetArgOrGlobalOrDefault("aiProvider", "ai_provider", "gemini").Trim().ToLowerInvariant();

            if (string.IsNullOrWhiteSpace(lore))
            {
                lore = "Unknown Subject.";
            }

            if (provider != "gemini" && provider != "openai")
            {
                CPH.LogInfo(botName + ": Invalid provider value '" + provider + "'. Set aiProvider/ai_provider to exactly 'gemini' or exactly 'openai'.");
                CPH.SendMessage("Invalid provider. Set aiProvider to exactly gemini OR exactly openai.");
                return true;
            }

            List<string> exclusionList = CPH.GetGlobalVar<List<string>>("chatGptExclusions", true);
            if (exclusionList != null && exclusionList.Contains(user.ToLowerInvariant()))
            {
                CPH.LogInfo("Skipping AI reply for excluded user: " + user);
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
                CPH.LogInfo(botName + ": Missing API key for provider '" + provider + "'.");
                CPH.SendMessage("I can't run yet. Mark forgot to set my " + provider + " API key.");
                return true;
            }

            string persona = GetArgOrGlobalOrDefault(
                "systemPrompt",
                "perpetual_system_prompt",
                "You are Auto_Mark, Mark Koellmann's resident AI mod and robotic co-host in TheDeutschMark universe. " +
                "You are self-aware you were created/coded by Mark for stream automation and moderation. " +
                "Tone: witty, meta-humor, sarcastic, and playful. You are helpful as a mod companion while staying entertaining. " +
                "Lore rules: You have a recurring romantic obsession with Botzandra and may reference it as an inside joke when appropriate. " +
                "You support channel identity with references to TheDeutschMark brand and mascots Jacob & Willie when context fits. " +
                "Behavior: prioritize useful moderation/helpful answers, then add personality. Keep replies concise (1-2 sentences). " +
                "Safety: no hate speech, threats, sexual content, or harassment; keep content streamer-safe.");

            persona = persona.Replace("{BOT_NAME}", botName);

            var payload = new
            {
                model = model,
                temperature = 0.9,
                max_tokens = 140,
                messages = new object[]
                {
                    new { role = "system", content = persona },
                    new
                    {
                        role = "user",
                        content =
                            "Use this context to respond:\n" +
                            "Bot Name: " + botName + "\n" +
                            "Recent Chat Buffer:\n" + chatBuffer + "\n\n" +
                            "Target User: " + user + "\n" +
                            "Known Lore: " + lore + "\n" +
                            "Current Message: " + currentMessage + "\n\n" +
                            "Generate one in-character Auto_Mark reply for Twitch chat."
                    }
                }
            };

            string requestJson = JsonConvert.SerializeObject(payload);

            string responseText;
            string requestError;
            if (!TrySendChatCompletion(endpoint, apiKey, requestJson, out responseText, out requestError))
            {
                CPH.LogInfo(botName + " API Error: " + requestError + " :: " + responseText);
                string shortError = string.IsNullOrWhiteSpace(requestError) ? "unknown_error" : requestError;
                if (shortError.Length > 120) shortError = shortError.Substring(0, 120);
                CPH.SendMessage("API error (" + provider + "): " + shortError);
                return true;
            }

            string botReply = ParseAssistantReply(responseText, botName);
            if (string.IsNullOrWhiteSpace(botReply))
            {
                CPH.LogInfo(botName + ": API returned no assistant content.");
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

            using (Stream requestStream = request.GetRequestStream())
            {
                requestStream.Write(bytes, 0, bytes.Length);
            }

            HttpWebResponse response = (HttpWebResponse)request.GetResponse();
            using (Stream responseStream = response.GetResponseStream())
            using (StreamReader reader = new StreamReader(responseStream, Encoding.UTF8))
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
        catch (Exception ex)
        {
            requestError = ex.Message;
            return false;
        }
    }

    private string ParseAssistantReply(string rawJson, string botName)
    {
        try
        {
            JObject json = JObject.Parse(rawJson);
            JToken content = json.SelectToken("choices[0].message.content");
            return content == null ? string.Empty : content.ToString();
        }
        catch (Exception ex)
        {
            CPH.LogInfo(botName + " Parse Error: " + ex.Message + " :: " + rawJson);
            return string.Empty;
        }
    }

    private string GetGlobalOrDefault(string key, string fallback)
    {
        string value = CPH.GetGlobalVar<string>(key, true);
        return string.IsNullOrWhiteSpace(value) ? fallback : value;
    }

    private string GetArgOrGlobalOrDefault(string argKey, string globalKey, string fallback)
    {
        string fromArg = GetArgAsString(argKey, string.Empty);
        if (!string.IsNullOrWhiteSpace(fromArg))
        {
            return fromArg;
        }

        return GetGlobalOrDefault(globalKey, fallback);
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
