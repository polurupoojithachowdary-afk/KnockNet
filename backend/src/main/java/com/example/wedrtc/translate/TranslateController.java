package com.example.wedrtc.translate;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.security.Principal;
import java.util.List;
import java.util.Map;

/**
 * REST controller for the push-to-talk translation pipeline.
 *
 * POST /api/translate — accepts an audio blob + language params,
 *   returns { original, translated, targetLanguage }.
 *
 * GET /api/translate/languages — returns the supported language list
 *   so the frontend can populate its dropdown.
 */
@RestController
@RequestMapping("/api/translate")
public class TranslateController {

    private static final Logger log = LoggerFactory.getLogger(TranslateController.class);

    private final NvidiaTranslationService translationService;

    /** Maximum audio upload size: 5 MB (covers ~30 seconds of WAV at 16-bit/16kHz). */
    private static final long MAX_AUDIO_BYTES = 5 * 1024 * 1024;

    public TranslateController(NvidiaTranslationService translationService) {
        this.translationService = translationService;
    }

    /**
     * Push-to-talk translation endpoint.
     *
     * The frontend records audio while the user holds a button, then sends
     * the complete utterance as a single multipart request. This batch approach
     * keeps NVIDIA free-tier usage to ~2 API calls per spoken turn.
     */
    @PostMapping(consumes = "multipart/form-data")
    public ResponseEntity<?> translateAudio(
            @RequestParam("audio") MultipartFile audioFile,
            @RequestParam(value = "sourceLang", defaultValue = "en") String sourceLang,
            @RequestParam("targetLang") String targetLang,
            Principal principal) {

        if (!translationService.isConfigured()) {
            return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of(
                    "success", false,
                    "error", "TRANSLATION_NOT_CONFIGURED",
                    "message", "Voice translation is not available on this server"
            ));
        }

        if (audioFile.isEmpty()) {
            return ResponseEntity.badRequest().body(Map.of(
                    "success", false,
                    "error", "EMPTY_AUDIO",
                    "message", "No audio data received"
            ));
        }

        if (audioFile.getSize() > MAX_AUDIO_BYTES) {
            return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE).body(Map.of(
                    "success", false,
                    "error", "AUDIO_TOO_LARGE",
                    "message", "Audio recording must be under 30 seconds"
            ));
        }

        try {
            byte[] audioBytes = audioFile.getBytes();
            NvidiaTranslationService.TranslationResult result =
                    translationService.translateAudio(audioBytes, sourceLang, targetLang);

            return ResponseEntity.ok(Map.of(
                    "success", true,
                    "original", result.original(),
                    "translated", result.translated(),
                    "targetLanguage", result.targetLanguage()
            ));

        } catch (Exception e) {
            log.error("Translation failed for user {}: {}", principal.getName(), e.getMessage(), e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of(
                    "success", false,
                    "error", "TRANSLATION_FAILED",
                    "message", "Could not translate the audio. Try again in a moment."
            ));
        }
    }

    /**
     * Returns the list of supported languages for the frontend dropdown.
     */
    @GetMapping("/languages")
    public ResponseEntity<?> getSupportedLanguages() {
        return ResponseEntity.ok(Map.of(
                "success", true,
                "configured", translationService.isConfigured(),
                "languages", SUPPORTED_LANGUAGES
        ));
    }

    /** Language list exposed to the frontend dropdown. */
    private static final List<Map<String, String>> SUPPORTED_LANGUAGES = List.of(
            Map.of("code", "en", "name", "English"),
            Map.of("code", "hi", "name", "Hindi"),
            Map.of("code", "te", "name", "Telugu"),
            Map.of("code", "ta", "name", "Tamil"),
            Map.of("code", "bn", "name", "Bengali"),
            Map.of("code", "mr", "name", "Marathi"),
            Map.of("code", "gu", "name", "Gujarati"),
            Map.of("code", "kn", "name", "Kannada"),
            Map.of("code", "ml", "name", "Malayalam"),
            Map.of("code", "pa", "name", "Punjabi"),
            Map.of("code", "ur", "name", "Urdu"),
            Map.of("code", "es", "name", "Spanish"),
            Map.of("code", "fr", "name", "French"),
            Map.of("code", "de", "name", "German"),
            Map.of("code", "pt", "name", "Portuguese"),
            Map.of("code", "it", "name", "Italian"),
            Map.of("code", "ru", "name", "Russian"),
            Map.of("code", "ja", "name", "Japanese"),
            Map.of("code", "ko", "name", "Korean"),
            Map.of("code", "zh", "name", "Chinese"),
            Map.of("code", "ar", "name", "Arabic"),
            Map.of("code", "tr", "name", "Turkish"),
            Map.of("code", "vi", "name", "Vietnamese"),
            Map.of("code", "th", "name", "Thai"),
            Map.of("code", "id", "name", "Indonesian"),
            Map.of("code", "ms", "name", "Malay"),
            Map.of("code", "nl", "name", "Dutch"),
            Map.of("code", "pl", "name", "Polish"),
            Map.of("code", "sv", "name", "Swedish"),
            Map.of("code", "da", "name", "Danish"),
            Map.of("code", "fi", "name", "Finnish"),
            Map.of("code", "no", "name", "Norwegian"),
            Map.of("code", "uk", "name", "Ukrainian"),
            Map.of("code", "he", "name", "Hebrew"),
            Map.of("code", "ro", "name", "Romanian"),
            Map.of("code", "cs", "name", "Czech")
    );
}
