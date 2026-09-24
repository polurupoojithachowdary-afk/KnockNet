package com.example.wedrtc.translate;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Base64;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Proxies audio through NVIDIA NIM free-tier endpoints:
 * Step 1 — Canary ASR (speech-to-text with optional translation)
 * Step 2 — If Canary doesn't support the target language pair, fall back to
 *           separate ASR + NMT calls.
 *
 * Uses batch/offline mode (one complete utterance per request) to stay within
 * the ~40 RPM free-tier rate limit.
 */
@Service
public class NvidiaTranslationService {

    private static final Logger log = LoggerFactory.getLogger(NvidiaTranslationService.class);

    private static final String NVIDIA_ASR_URL =
            "https://integrate.api.nvidia.com/v1/audio/transcriptions";

    private static final String NVIDIA_NMT_URL =
            "https://integrate.api.nvidia.com/v1/chat/completions";

    private final String apiKey;
    private final HttpClient httpClient;

    public NvidiaTranslationService(
            @Value("${app.nvidia.api-key:}") String apiKey) {
        this.apiKey = apiKey;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(15))
                .build();
    }

    public boolean isConfigured() {
        return apiKey != null && !apiKey.isBlank();
    }

    /**
     * Transcribe audio to text using NVIDIA Canary ASR endpoint.
     * Accepts raw audio bytes (WAV/WebM) and returns the transcribed text.
     */
    public String transcribeAudio(byte[] audioData, String sourceLanguage) throws IOException, InterruptedException {
        if (!isConfigured()) {
            throw new IllegalStateException("NVIDIA API key is not configured");
        }

        String base64Audio = Base64.getEncoder().encodeToString(audioData);

        // Map BCP-47 codes to Canary-compatible language codes
        String langCode = mapToCanaryLanguage(sourceLanguage);

        // Build multipart-like JSON request for the ASR endpoint
        String requestBody = """
                {
                  "model": "openai/whisper-large-v3",
                  "language": "%s",
                  "response_format": "json",
                  "file": "data:audio/wav;base64,%s"
                }
                """.formatted(langCode, base64Audio);

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(NVIDIA_ASR_URL))
                .timeout(Duration.ofSeconds(30))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(requestBody))
                .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

        if (response.statusCode() != 200) {
            log.warn("NVIDIA ASR returned {}: {}", response.statusCode(), response.body());
            throw new IOException("NVIDIA ASR request failed with status " + response.statusCode());
        }

        return extractTextField(response.body());
    }

    /**
     * Translate text using NVIDIA NMT via the chat completions endpoint.
     * Uses NVIDIA Riva Translate 4B Instruct v2.
     */
    public String translateText(String text, String sourceLanguage, String targetLanguage) throws IOException, InterruptedException {
        if (!isConfigured()) {
            throw new IllegalStateException("NVIDIA API key is not configured");
        }

        String srcCode = sourceLanguage != null ? sourceLanguage.toLowerCase().split("[-_]")[0] : "en";
        String tgtCode = targetLanguage != null ? targetLanguage.toLowerCase().split("[-_]")[0] : "en";
        String pairTag = srcCode + "-" + tgtCode;

        // Use NVIDIA Riva Translate 4B Instruct v2 with language pair system tag
        String requestBody = """
                {
                  "model": "nvidia/riva-translate-4b-instruct-v2",
                  "messages": [
                    {
                      "role": "system",
                      "content": "%s"
                    },
                    {
                      "role": "user",
                      "content": "%s"
                    }
                  ],
                  "temperature": 0.1,
                  "max_tokens": 512
                }
                """.formatted(pairTag, escapeJson(text));

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(NVIDIA_NMT_URL))
                .timeout(Duration.ofSeconds(30))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(requestBody))
                .build();

        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());

        if (response.statusCode() != 200) {
            log.warn("NVIDIA NMT returned {}: {}", response.statusCode(), response.body());
            throw new IOException("NVIDIA translation request failed with status " + response.statusCode());
        }

        return extractChatContent(response.body());
    }

    /**
     * Combined pipeline: audio → text → translated text.
     */
    public TranslationResult translateAudio(byte[] audioData, String sourceLanguage, String targetLanguage)
            throws IOException, InterruptedException {

        // Step 1: ASR — speech to text
        String originalText = transcribeAudio(audioData, sourceLanguage);

        if (originalText == null || originalText.isBlank()) {
            return new TranslationResult("", "", targetLanguage);
        }

        // Step 2: NMT — translate text
        String translatedText = translateText(originalText, sourceLanguage, targetLanguage);

        return new TranslationResult(originalText, translatedText, targetLanguage);
    }

    // --- Helpers ---

    private String mapToCanaryLanguage(String bcp47) {
        if (bcp47 == null) return "en";
        String lower = bcp47.toLowerCase().replace("_", "-");
        // Canary supports: en, es, fr, de, hi, ja, ko, pt, zh, and more
        if (lower.startsWith("en")) return "en";
        if (lower.startsWith("es")) return "es";
        if (lower.startsWith("fr")) return "fr";
        if (lower.startsWith("de")) return "de";
        if (lower.startsWith("hi")) return "hi";
        if (lower.startsWith("ja")) return "ja";
        if (lower.startsWith("ko")) return "ko";
        if (lower.startsWith("pt")) return "pt";
        if (lower.startsWith("zh")) return "zh";
        if (lower.startsWith("te")) return "te";
        if (lower.startsWith("ta")) return "ta";
        if (lower.startsWith("bn")) return "bn";
        if (lower.startsWith("ar")) return "ar";
        if (lower.startsWith("ru")) return "ru";
        return "en";
    }

    private static final Map<String, String> LANGUAGE_NAMES = Map.ofEntries(
            Map.entry("en", "English"),
            Map.entry("es", "Spanish"),
            Map.entry("fr", "French"),
            Map.entry("de", "German"),
            Map.entry("hi", "Hindi"),
            Map.entry("te", "Telugu"),
            Map.entry("ta", "Tamil"),
            Map.entry("bn", "Bengali"),
            Map.entry("mr", "Marathi"),
            Map.entry("gu", "Gujarati"),
            Map.entry("kn", "Kannada"),
            Map.entry("ml", "Malayalam"),
            Map.entry("pa", "Punjabi"),
            Map.entry("ur", "Urdu"),
            Map.entry("ja", "Japanese"),
            Map.entry("ko", "Korean"),
            Map.entry("zh", "Chinese"),
            Map.entry("ar", "Arabic"),
            Map.entry("ru", "Russian"),
            Map.entry("pt", "Portuguese"),
            Map.entry("it", "Italian"),
            Map.entry("tr", "Turkish"),
            Map.entry("vi", "Vietnamese"),
            Map.entry("th", "Thai"),
            Map.entry("id", "Indonesian"),
            Map.entry("ms", "Malay"),
            Map.entry("nl", "Dutch"),
            Map.entry("pl", "Polish"),
            Map.entry("sv", "Swedish"),
            Map.entry("da", "Danish"),
            Map.entry("fi", "Finnish"),
            Map.entry("no", "Norwegian"),
            Map.entry("uk", "Ukrainian"),
            Map.entry("he", "Hebrew"),
            Map.entry("ro", "Romanian"),
            Map.entry("cs", "Czech")
    );

    private String languageDisplayName(String code) {
        if (code == null) return "English";
        String prefix = code.toLowerCase().split("[-_]")[0];
        return LANGUAGE_NAMES.getOrDefault(prefix, code);
    }

    /**
     * Extracts the "text" field from the ASR JSON response.
     * Simple regex extraction to avoid adding a JSON library dependency.
     */
    private String extractTextField(String json) {
        Pattern pattern = Pattern.compile("\"text\"\\s*:\\s*\"([^\"]*?)\"");
        Matcher matcher = pattern.matcher(json);
        if (matcher.find()) {
            return unescapeJson(matcher.group(1));
        }
        log.warn("Could not extract 'text' from ASR response: {}", json);
        return "";
    }

    /**
     * Extracts the assistant message content from a chat completions response.
     */
    private String extractChatContent(String json) {
        Pattern pattern = Pattern.compile("\"content\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
        Matcher matcher = pattern.matcher(json);
        if (matcher.find()) {
            return unescapeJson(matcher.group(1));
        }
        log.warn("Could not extract 'content' from NMT response: {}", json);
        return "";
    }

    private String escapeJson(String text) {
        return text.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t");
    }

    private String unescapeJson(String text) {
        return text.replace("\\\"", "\"")
                .replace("\\n", "\n")
                .replace("\\r", "\r")
                .replace("\\t", "\t")
                .replace("\\\\", "\\");
    }

    /**
     * Immutable result of the translate-audio pipeline.
     */
    public record TranslationResult(String original, String translated, String targetLanguage) {}
}
