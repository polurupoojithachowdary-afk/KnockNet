package com.example.wedrtc.translate;

import com.example.wedrtc.translate.riva.*;
import com.google.protobuf.ByteString;
import io.grpc.ManagedChannel;
import io.grpc.ManagedChannelBuilder;
import io.grpc.Metadata;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.MetadataUtils;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

import javax.sound.sampled.AudioSystem;
import javax.sound.sampled.AudioFormat;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

/** NVIDIA-hosted Whisper gRPC ASR followed by Riva text translation. */
@Service
public class NvidiaTranslationService {
    static final Set<String> LANGUAGES = Set.of("en", "es", "fr", "de", "hi", "te", "ta", "bn",
            "mr", "gu", "kn", "ml", "pa", "ur", "ja", "ko", "zh", "ar", "ru", "pt", "it",
            "tr", "vi", "th", "id", "ms", "nl", "pl", "sv", "da", "fi", "no", "uk", "he", "ro", "cs");
    private final String apiKey;
    private final ManagedChannel channel;
    private final String functionId;
    private final URI translateUri;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
    private final ObjectMapper json = new ObjectMapper();

    @Autowired
    public NvidiaTranslationService(@Value("${app.nvidia.api-key:}") String apiKey,
            @Value("${app.nvidia.whisper-function-id:b702f636-f60c-4a3d-a6f4-f3568c13bd7d}") String functionId) {
        this(apiKey, functionId, ManagedChannelBuilder.forAddress("grpc.nvcf.nvidia.com", 443)
                .useTransportSecurity().build(), URI.create("https://integrate.api.nvidia.com/v1/chat/completions"));
    }

    NvidiaTranslationService(String apiKey, String functionId, ManagedChannel channel, URI translateUri) {
        this.apiKey = apiKey;
        this.functionId = functionId;
        this.channel = channel;
        this.translateUri = translateUri;
    }

    public boolean isConfigured() { return apiKey != null && !apiKey.isBlank(); }

    public static String language(String code) {
        String normalized = code == null ? "" : code.toLowerCase(Locale.ROOT).split("[-_]")[0];
        if (!LANGUAGES.contains(normalized)) throw new IllegalArgumentException("Unsupported language");
        return normalized;
    }

    public String transcribeAudio(byte[] wav, String sourceLanguage) throws IOException {
        requireConfigured();
        String source = language(sourceLanguage);
        byte[] pcm;
        try (var audio = AudioSystem.getAudioInputStream(new ByteArrayInputStream(wav))) {
            var format = audio.getFormat();
            if (format.getChannels() != 1 || format.getSampleSizeInBits() != 16
                    || format.getSampleRate() != 16000 || format.isBigEndian()
                    || !AudioFormat.Encoding.PCM_SIGNED.equals(format.getEncoding())) {
                throw new IllegalArgumentException("Audio must be mono 16-bit PCM WAV at 16 kHz");
            }
            pcm = audio.readAllBytes();
            if (pcm.length < 3200 || pcm.length > 16000 * 2 * 30) {
                throw new IllegalArgumentException("Record between 0.1 and 30 seconds of audio");
            }
        } catch (javax.sound.sampled.UnsupportedAudioFileException e) {
            throw new IllegalArgumentException("Audio must be a WAV recording", e);
        }
        Metadata headers = new Metadata();
        headers.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), "Bearer " + apiKey);
        headers.put(Metadata.Key.of("function-id", Metadata.ASCII_STRING_MARSHALLER), functionId);
        var request = RecognizeRequest.newBuilder()
                .setConfig(RecognitionConfig.newBuilder().setEncoding(1).setSampleRateHertz(16000)
                        .setAudioChannelCount(1).setLanguageCode(source).setMaxAlternatives(1)
                        .setEnableAutomaticPunctuation(true).putCustomConfiguration("task", "transcribe"))
                .setAudio(ByteString.copyFrom(pcm)).build();
        try {
            var response = RivaSpeechRecognitionGrpc.newBlockingStub(channel)
                    .withInterceptors(MetadataUtils.newAttachHeadersInterceptor(headers))
                    .withDeadlineAfter(45, TimeUnit.SECONDS).recognize(request);
            return response.getResultsList().stream().filter(r -> r.getAlternativesCount() > 0)
                    .map(r -> r.getAlternatives(0).getTranscript()).collect(Collectors.joining(" ")).trim();
        } catch (StatusRuntimeException e) {
            throw new IOException("NVIDIA Whisper failed: " + e.getStatus().getCode(), e);
        }
    }

    public String translateText(String text, String sourceLanguage, String targetLanguage)
            throws IOException, InterruptedException {
        requireConfigured();
        String source = language(sourceLanguage), target = language(targetLanguage);
        if (text == null || text.isBlank() || text.length() > 4000)
            throw new IllegalArgumentException("Text must contain 1 to 4000 characters");
        if (source.equals(target)) return text.trim();
        // This model supports English <-> 36 languages. Pivot other pairs through English.
        if (!source.equals("en") && !target.equals("en"))
            return translateText(translateText(text, source, "en"), "en", target);
        String body = json.writeValueAsString(Map.of("model", "nvidia/riva-translate-4b-instruct-v2",
                "messages", List.of(Map.of("role", "system", "content", source + "-" + target),
                        Map.of("role", "user", "content", text)), "temperature", 0, "max_tokens", 1024));
        var request = HttpRequest.newBuilder(translateUri).timeout(Duration.ofSeconds(45))
                .header("Authorization", "Bearer " + apiKey).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build();
        var response = http.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() != 200)
            throw new IOException("NVIDIA translation failed: HTTP " + response.statusCode());
        var choice = json.readTree(response.body()).path("choices").path(0);
        String translated = choice.path("message").path("content").asText("").trim();
        if (translated.isBlank() || "length".equals(choice.path("finish_reason").asText()))
            throw new IOException("NVIDIA returned an empty or incomplete translation");
        return translated;
    }

    public TranslationResult translateAudio(byte[] wav, String source, String target)
            throws IOException, InterruptedException {
        language(source);
        target = language(target);
        String original = transcribeAudio(wav, source);
        return new TranslationResult(original, original.isBlank() ? "" : translateText(original, source, target), target);
    }

    private void requireConfigured() {
        if (!isConfigured()) throw new IllegalStateException("NVIDIA API key is not configured");
    }

    @PreDestroy
    public void close() { channel.shutdownNow(); }
    public record TranslationResult(String original, String translated, String targetLanguage) {}
}
