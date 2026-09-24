package com.example.wedrtc.translate;

import com.example.wedrtc.translate.riva.*;
import com.sun.net.httpserver.HttpServer;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.grpc.stub.StreamObserver;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import tools.jackson.databind.ObjectMapper;

import javax.sound.sampled.*;
import java.io.*;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

class NvidiaTranslationServiceTest {
    @Test
    void whisperReceivesPcmAndLanguageAndTextTranslationParsesEscapedJson() throws Exception {
        var captured = new AtomicReference<RecognizeRequest>();
        String name = InProcessServerBuilder.generateName();
        var grpc = InProcessServerBuilder.forName(name).directExecutor().addService(
                new RivaSpeechRecognitionGrpc.RivaSpeechRecognitionImplBase() {
                    @Override public void recognize(RecognizeRequest request, StreamObserver<RecognizeResponse> observer) {
                        captured.set(request);
                        observer.onNext(RecognizeResponse.newBuilder().addResults(SpeechRecognitionResult.newBuilder()
                                .addAlternatives(SpeechRecognitionAlternative.newBuilder().setTranscript("Hello \"friend\""))).build());
                        observer.onCompleted();
                    }
                }).build().start();
        var http = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var requestBody = new AtomicReference<String>();
        http.createContext("/translate", exchange -> {
            requestBody.set(new String(exchange.getRequestBody().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8));
            byte[] response = "{\"choices\":[{\"message\":{\"content\":\"Hola \\\"amigo\\\"\\n\"},\"finish_reason\":\"stop\"}]}".getBytes();
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        http.start();
        var service = new NvidiaTranslationService("test-key", "test-function", InProcessChannelBuilder.forName(name)
                .directExecutor().build(), URI.create("http://127.0.0.1:" + http.getAddress().getPort() + "/translate"));
        try {
            byte[] pcm = new byte[16000];
            var wav = new ByteArrayOutputStream();
            AudioSystem.write(new AudioInputStream(new ByteArrayInputStream(pcm),
                    new AudioFormat(16000, 16, 1, true, false), pcm.length / 2), AudioFileFormat.Type.WAVE, wav);
            var result = service.translateAudio(wav.toByteArray(), "en-US", "es");
            assertEquals("Hello \"friend\"", result.original());
            assertEquals("Hola \"amigo\"", result.translated());
            assertArrayEquals(pcm, captured.get().getAudio().toByteArray());
            assertEquals(16000, captured.get().getConfig().getSampleRateHertz());
            assertEquals("en", captured.get().getConfig().getLanguageCode());
            assertEquals("en-es", new ObjectMapper().readTree(requestBody.get()).path("messages").path(0).path("content").asText());
            assertThrows(IllegalArgumentException.class, () -> service.transcribeAudio(new byte[50], "en"));
            assertThrows(IllegalArgumentException.class, () -> service.translateText("Hi", "unsupported", "en"));
        } finally {
            service.close(); grpc.shutdownNow(); http.stop(0);
        }
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "NVIDIA_SMOKE_WAV", matches = ".+")
    void liveWhisperAndRiva() throws Exception {
        var service = new NvidiaTranslationService(System.getenv("NVIDIA_API_KEY"), "b702f636-f60c-4a3d-a6f4-f3568c13bd7d");
        try {
            var result = service.translateAudio(Files.readAllBytes(Path.of(System.getenv("NVIDIA_SMOKE_WAV"))), "en", "es");
            assertTrue(result.original().toLowerCase().contains("hello"), result.original());
            assertFalse(result.translated().isBlank());
            System.out.println("Live NVIDIA smoke: " + result.original() + " -> " + result.translated());
        } finally { service.close(); }
    }
}
