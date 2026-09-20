FROM eclipse-temurin:21-jdk-alpine AS build
WORKDIR /workspace

COPY gradlew gradlew.bat build.gradle settings.gradle ./
COPY gradle ./gradle
RUN chmod +x gradlew && ./gradlew dependencies --no-daemon

COPY src ./src
RUN ./gradlew bootJar --no-daemon

FROM eclipse-temurin:21-jre-alpine
RUN addgroup -S knocknet && adduser -S knocknet -G knocknet
WORKDIR /app
COPY --from=build /workspace/build/libs/knocknet.jar /app/knocknet.jar

USER knocknet
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=70 -XX:+UseSerialGC"
EXPOSE 10000
ENTRYPOINT ["java", "-jar", "/app/knocknet.jar"]
