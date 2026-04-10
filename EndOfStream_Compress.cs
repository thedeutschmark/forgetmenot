using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using System;
using System.IO;
using System.Net;
using System.Text;

/// <summary>
/// End-of-stream memory compressor.
///
/// Trigger: Stream Offline event (or manual trigger at end of stream).
///
/// Takes the full chat buffer, sends it to the LLM with a compression
/// prompt, and saves the summary to a local file. Next stream, the Brain
/// script loads this summary as context — giving the bot persistent
/// memory across sessions without storing raw chat logs.
///
/// Requires: perpetual_data_dir global variable set to a local directory.
/// </summary>
public class CPHInline
{
    public bool Execute()
    {
        string botName = GetGlobalOrDefault("perpetual_bot_name", "Auto_Mark");
        string dataDir = GetGlobalOrDefault("perpetual_data_dir", string.Empty);

        if (string.IsNullOrWhiteSpace(dataDir))
        {
            CPH.LogInfo(botName + " Compress: No data directory set (perpetual_data_dir). Skipping.");
            return true;
        }

        string chatBuffer = CPH.GetGlobalVar<string>("chat_buffer", true);
        if (string.IsNullOrWhiteSpace(chatBuffer) || chatBuffer.Length < 50)
        {
            CPH.LogInfo(botName + " Compress: Chat buffer too short to summarize. Skipping.");
            return true;
        }

        string provider = GetGlobalOrDefault("ai_provider", "gemini").Trim().ToLowerInvariant();
        string defaultEndpoint = provider == "openai"
            ? "https://api.openai.com/v1/chat/completions"
            : "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
        string defaultModel = provider == "openai" ? "gpt-4o-mini" : "gemini-2.5-flash";

        string endpoint = GetGlobalOrDefault("ai_endpoint", defaultEndpoint);
        string model = GetGlobalOrDefault("ai_model", defaultModel);

        string apiKey = provider == "openai"
            ? GetGlobalOrDefault("openai_api_key", string.Empty)
            : GetGlobalOrDefault("gemini_api_key", string.Empty);
        if (string.IsNullOrWhiteSpace(apiKey))
            apiKey = GetGlobalOrDefault("ai_api_key", string.Empty);
        if (string.IsNullOrWhiteSpace(apiKey) && provider == "gemini")
            apiKey = GetGlobalOrDefault("google_api_key", string.Empty);

        if (string.IsNullOrWhiteSpace(apiKey))
        {
            CPH.LogInfo(botName + " Compress: No API key. Skipping compression.");
            return true;
        }

        // Load previous summary to chain context
        string memoryDir = Path.Combine(dataDir, "memory");
        Directory.CreateDirectory(memoryDir);
        string prevSummary = string.Empty;
        string latestPath = Path.Combine(memoryDir, "latest_summary.txt");
        if (File.Exists(latestPath))
        {
            try { prevSummary = File.ReadAllText(latestPath).Trim(); }
            catch { /* ignore read errors */ }
        }

        // Build compression prompt
        string compressPrompt =
            "You are a session memory compressor for a Twitch stream bot named " + botName + ".\n\n" +
            "Your job: read the chat log below and produce a compact summary (under 300 words) that captures:\n" +
            "- Key events, topics discussed, games played\n" +
            "- Notable user interactions or memes that emerged\n" +
            "- Any promises made, inside jokes created, or running bits\n" +
            "- Users who were particularly active or memorable\n\n" +
            "Write in third person past tense. Be factual and concise. This summary will be fed to the bot next session as context.\n\n";

        if (!string.IsNullOrWhiteSpace(prevSummary))
        {
            compressPrompt += "Previous session summary (for continuity):\n" + prevSummary + "\n\n";
        }

        compressPrompt += "Current session chat log:\n" + chatBuffer;

        var payload = new
        {
            model = model,
            temperature = 0.3, // low temperature for factual summary
            max_tokens = 400,
            messages = new object[]
            {
                new { role = "system", content = "You compress Twitch chat sessions into concise factual summaries for bot memory persistence. No commentary, no filler, just the facts." },
                new { role = "user", content = compressPrompt }
            }
        };

        string requestJson = JsonConvert.SerializeObject(payload);
        string responseText;
        string requestError;

        if (!TrySend(endpoint, apiKey, requestJson, out responseText, out requestError))
        {
            CPH.LogInfo(botName + " Compress Error: " + requestError);
            return true;
        }

        string summary = ParseReply(responseText);
        if (string.IsNullOrWhiteSpace(summary))
        {
            CPH.LogInfo(botName + " Compress: Empty summary returned.");
            return true;
        }

        // Save summary
        try
        {
            // Archive previous summary with timestamp
            if (File.Exists(latestPath))
            {
                string archiveDir = Path.Combine(memoryDir, "archive");
                Directory.CreateDirectory(archiveDir);
                string timestamp = DateTime.UtcNow.ToString("yyyy-MM-dd_HHmmss");
                File.Move(latestPath, Path.Combine(archiveDir, timestamp + ".txt"));
            }

            File.WriteAllText(latestPath, summary.Trim());
            CPH.LogInfo(botName + " Compress: Session summary saved (" + summary.Length + " chars).");
        }
        catch (Exception ex)
        {
            CPH.LogInfo(botName + " Compress: Failed to write summary: " + ex.Message);
        }

        return true;
    }

    private bool TrySend(string endpoint, string apiKey, string json, out string response, out string error)
    {
        response = string.Empty;
        error = string.Empty;
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(endpoint);
            req.Headers.Add("Authorization", "Bearer " + apiKey);
            req.ContentType = "application/json";
            req.Method = "POST";
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            req.ContentLength = bytes.Length;
            using (Stream s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
            using (Stream rs = ((HttpWebResponse)req.GetResponse()).GetResponseStream())
            using (StreamReader r = new StreamReader(rs, Encoding.UTF8))
                response = r.ReadToEnd();
            return true;
        }
        catch (Exception ex) { error = ex.Message; return false; }
    }

    private string ParseReply(string rawJson)
    {
        try
        {
            JObject json = JObject.Parse(rawJson);
            JToken content = json.SelectToken("choices[0].message.content");
            return content == null ? string.Empty : content.ToString();
        }
        catch { return string.Empty; }
    }

    private string GetGlobalOrDefault(string key, string fallback)
    {
        string value = CPH.GetGlobalVar<string>(key, true);
        return string.IsNullOrWhiteSpace(value) ? fallback : value;
    }
}
