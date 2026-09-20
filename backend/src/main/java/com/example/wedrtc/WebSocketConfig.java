package com.example.wedrtc;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final SignalingHandler signalingHandler;
    private final String[] allowedOrigins;

    public WebSocketConfig(
            SignalingHandler signalingHandler,
            @Value("${app.frontend-origins}") String configuredOrigins) {
        this.signalingHandler = signalingHandler;
        this.allowedOrigins = java.util.Arrays.stream(configuredOrigins.split(","))
                .map(String::trim)
                .filter(value -> !value.isBlank())
                .toArray(String[]::new);
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(signalingHandler, "/signal")
                .setAllowedOrigins(allowedOrigins);
    }
}
