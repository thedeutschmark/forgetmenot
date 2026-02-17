using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;

public class CPHInline
{
    public bool Execute()
    {
        string botName = GetGlobalOrDefault("perpetual_bot_name", "Auto_Mark");

        try
        {
            string user = GetArgAsString("userName", "UnknownUser");
            string currentMessage = GetArgAsString("message", string.Empty);
            string chatBuffer = CPH.GetGlobalVar<string>("chat_buffer", true) ?? "(No recent chat history.)";
            string lore = CPH.GetUserVar<string>(user, "perpetual_lore", true);

            if (string.IsNullOrWhiteSpace(lore))
            {
                lore = "Unknown Subject.";
            }

            string apiKey = GetGlobalOrDefault("ai_api_key", string.Empty);
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                // Backward compatibility with previous variable naming.
                apiKey = GetGlobalOrDefault("openai_api_key", string.Empty);
            }

            if (string.IsNullOrWhiteSpace(apiKey))
            {
                CPH.LogInfo(botName + ": Missing Global Variable 'ai_api_key' (or legacy 'openai_api_key').");
                CPH.SendMessage("I can't run yet. Mark forgot to set my AI API key.");
                return true;
            }

            // Gemini OpenAI-compatible endpoint defaults.
            string endpoint = GetGlobalOrDefault("ai_endpoint", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
            string model = GetGlobalOrDefault("ai_model", "gemini-2.0-flash");
            string persona = GetGlobalOrDefault(
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
                    new
                    {
                        role = "system",
                        content = persona
                    },
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
            using (var httpClient = new HttpClient())
            {
                httpClient.Timeout = TimeSpan.FromSeconds(20);
                httpClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);

                using (var content = new StringContent(requestJson, Encoding.UTF8, "application/json"))
                {
                    var response = httpClient.PostAsync(endpoint, content).Result;
                    responseText = response.Content.ReadAsStringAsync().Result;

                    if (!response.IsSuccessStatusCode)
                    {
                        CPH.LogInfo(botName + " API Error: " + (int)response.StatusCode + " " + response.ReasonPhrase + " :: " + responseText);
                        CPH.SendMessage("My core glitched. Try again in a second.");
                        return true;
                    }
                }
            }

            string botReply = ParseAssistantReply(responseText, botName);
            if (string.IsNullOrWhiteSpace(botReply))
            {
                CPH.LogInfo(botName + ": API returned no assistant content.");
                CPH.SendMessage("I had the perfect line and then dropped my circuits.");
                return true;
            }

            CPH.SendMessage(botReply.Trim());

            // Placeholder for future lore updates:
            // if (ShouldUpdateLore(botReply)) { CPH.SetUserVar(user, "perpetual_lore", updatedLore, true); }
            return true;
        }
        catch (Exception ex)
        {
            CPH.LogInfo(botName + " Exception: " + ex.Message);
            CPH.SendMessage("My sarcasm core crashed. Try again.");
            return true;
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

    private string GetArgAsString(string key, string fallback)
    {
        if (!CPH.TryGetArg(key, out string value))
        {
            return fallback;
        }

        return string.IsNullOrEmpty(value) ? fallback : value;
    }
}
