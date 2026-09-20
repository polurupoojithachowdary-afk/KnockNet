# Knocknet implementation and deployment guide

This is the handoff for Knocknet: architecture, local development, Firebase configuration, deployment, security guarantees, limitations and release operations.

## Product and deployment overview

Knocknet is an identity-gated WebRTC meeting prototype. Google sign-in is handled by Firebase Authentication. The Java/Spring service validates Firebase ID tokens, creates short-lived room invitations, authorizes participants and relays WebRTC signaling. Browsers exchange encrypted audio/video directly using WebRTC DTLS-SRTP.

The product direction is verified ephemeral rooms: authenticated participants, short-lived invitations, host-controlled admission and minimal retained call state. This is not yet a claim of application-level end-to-end encryption against every service operator.

| Component | Current deployment | Responsibility |
| --- | --- | --- |
| Frontend | https://knock-net.vercel.app | Vite static UI, CDN, HTTPS and security headers |
| Backend | https://knocknet-api.onrender.com | Spring Boot REST API and WebSocket signaling |
| Identity | Firebase project knocknet-99ceb | Google OAuth and signed Firebase ID tokens |

Render Free can sleep when idle. The first request after sleep can be slow, and process-memory rooms disappear after restart. Vercel serves the frontend independently.

    Browser (Vercel)
      Firebase sign-in -> ID token
      HTTPS REST / WSS signaling -> Spring Boot (Render)
      WebRTC encrypted media <-> other browsers
    Firebase = identity; Render = authorization/signaling; Vercel = static hosting

## Repository map

- frontend/index.html: landing page, clock, calendar and sign-in markup.
- frontend/room.html: in-call markup.
- frontend/css/index.css and room.css: page styles.
- frontend/js/config.js: build-time API/Firebase values.
- frontend/js/auth.js: Firebase initialization and Google sign-in.
- frontend/js/api.js: REST requests with Firebase bearer token.
- frontend/js/app.js: landing page, schedules, room creation and joining.
- frontend/js/room.js: room admission and call-page orchestration.
- frontend/js/webrtc.js: peer connections, SDP/ICE and media controls.
- frontend/js/fluid.js: decorative background canvas.
- backend/src/main/java: Spring controllers, security, room manager and WebSocket handler.
- backend/src/test/java: unit/application tests.
- backend/Dockerfile: Render production image.
- backend/build.gradle: Java 21 and Spring Boot dependencies.
- render.yaml: Render Blueprint definition.
- vercel.json: Vercel build and browser security headers.
- firebase.json: Firebase Auth provider/domain configuration.
- .env.example files: variable templates; real env files must never be committed.

## Technology choices

HTML/CSS/JavaScript + Vite gives a small static client and inexpensive CDN hosting. Firebase Authentication provides maintained Google OAuth and signed identity tokens. WebRTC gives low-latency browser media with DTLS-SRTP encryption. Spring Boot 4, Java 21 and Gradle provide typed REST/WebSocket and security middleware. Spring OAuth2 resource server/Nimbus JWT validates Firebase signature, issuer and audience. Render Docker runs the JVM and supports WebSockets. Vercel serves static output globally with HTTPS and previews.

## Run locally from scratch

Prerequisites: Git, Node 20+, npm, JDK 21, and a Firebase project with Google enabled. Firebase/Vercel CLIs are optional.

    git clone <repository-url>
    cd WedRTC

Frontend terminal:

    cd frontend
    npm ci
    Copy-Item .env.example .env.local

Set frontend/.env.local:

    VITE_API_BASE_URL=http://localhost:8080
    VITE_FIREBASE_API_KEY=<web app apiKey>
    VITE_FIREBASE_AUTH_DOMAIN=<project-id>.firebaseapp.com
    VITE_FIREBASE_PROJECT_ID=<project-id>
    VITE_FIREBASE_APP_ID=<web app appId>

Run npm run dev and open http://localhost:5173.

Backend terminal:

    cd backend
    $env:FIREBASE_PROJECT_ID = "<project-id>"
    $env:FRONTEND_ORIGINS = "http://localhost:5173"
    .\gradlew.bat bootRun

The API is http://localhost:8080 and health is /actuator/health. Spring downloads Google's public Firebase JWK keys, so no service-account JSON is needed. Localhost is a secure browser origin for camera/microphone permissions.

## Firebase setup

1. Create a Firebase project and add a Web app.
2. Copy apiKey, authDomain, projectId and appId into Vercel and local variables.
3. Authentication -> Sign-in method -> enable Google and set support email.
4. Authentication -> Settings -> Authorized domains: add localhost, knock-net.vercel.app and every actual custom/preview domain.
5. Never commit service-account private keys. The web API key is public configuration; signed ID tokens provide authorization.

    firebase login
    firebase use <project-id>
    firebase deploy --only auth
    firebase login:list

For auth/internal-error, check provider, authorized domain, build variables, popup blocking and the CSP. Keep https://apis.google.com in script-src and Google/Firebase frames in frame-src.

## Request and call flow

1. auth.js signs in with Firebase signInWithPopup.
2. api.js obtains the ID token and sends Authorization: Bearer token.
3. POST /api/rooms creates an in-memory room and a six-digit code expiring after 60 seconds.
4. POST /api/rooms/join validates code, capacity and rate limits, then authorizes the participant.
5. room.js opens wss://knocknet-api.onrender.com/signal.
6. webrtc.js exchanges join/leave events, SDP and ICE. Same-room checks happen before relay.
7. Browsers negotiate a peer connection; media uses DTLS-SRTP. Render relays signaling, not video.
8. Clock, calendar, fluid background and join sound are client-side features.

## Backend API

All /api/** routes require a valid Firebase bearer token.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /actuator/health | Public Render health check |
| POST | /api/rooms | Create room; capacity 2-8 |
| POST | /api/rooms/join | Validate invitation and admit caller |
| GET | /api/rooms/{id} | Read metadata after admission |
| POST | /api/rooms/{id}/refresh-code | Host-only code rotation |
| GET/POST | /api/rooms/schedule | Read/create in-memory schedules |
| DELETE | /api/rooms/schedule/{id} | Delete an owned schedule |
| WSS | /signal | WebRTC signaling relay |

Room and schedule state is process memory. A Render restart, deploy or free-tier sleep can clear it.

## Deploy Render

1. Push to GitHub.
2. Render -> New -> Blueprint -> select the repository; it reads render.yaml.
3. Confirm service knocknet-api, Docker runtime, backend context and Free plan.
4. Set exact origins, without a trailing slash:

    FIREBASE_PROJECT_ID=knocknet-99ceb
    FRONTEND_ORIGINS=https://knock-net.vercel.app

5. Deploy and wait for /actuator/health. Use the resulting URL as the frontend API URL.

The Dockerfile builds the Gradle boot jar and uses Render PORT. CORS and WebSocket origins read FRONTEND_ORIGINS.

## Deploy Vercel

Import the repository root. vercel.json runs npm --prefix frontend ci, builds Vite and publishes frontend/dist.

Set Production variables:

    VITE_API_BASE_URL=https://knocknet-api.onrender.com
    VITE_FIREBASE_API_KEY=<web app apiKey>
    VITE_FIREBASE_AUTH_DOMAIN=knocknet-99ceb.firebaseapp.com
    VITE_FIREBASE_PROJECT_ID=knocknet-99ceb
    VITE_FIREBASE_APP_ID=<web app appId>

Vite embeds VITE_* values at build time; changing them requires redeployment. Deploy Render first, then Vercel.

    vercel env add VITE_API_BASE_URL production
    vercel env add VITE_FIREBASE_API_KEY production
    vercel env add VITE_FIREBASE_AUTH_DOMAIN production
    vercel env add VITE_FIREBASE_PROJECT_ID production
    vercel env add VITE_FIREBASE_APP_ID production
    vercel deploy --prod

## Security model

vercel.json configures CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy and nosniff. Implemented: Google-authenticated room actions; Firebase signature/issuer/audience validation; explicit CORS/WSS origins; short-lived, rate-limited, host-rotatable codes; room authorization; same-room signaling checks; payload/connection limits; DTLS-SRTP media encryption.

Not implemented: application-level E2EE against the signaling operator; TURN for restrictive networks; durable rooms/schedules; large-room SFU scaling; complete observability, abuse prevention, allowlists and independent security testing. Add TURN with short-lived server-issued credentials, never permanent browser secrets. Use Firestore/Postgres/Redis for durable state. Use Encoded Transforms and room-key rotation for future E2EE.

A strong USP is a visible security panel showing verified identity, admission time, a verbally comparable room safety code, direct/relay transport path and recording status. Describe verifiable privacy, not vague military-grade claims.

## Verification and operations

    cd frontend
    npm ci
    npm run build
    cd ..\backend
    .\gradlew.bat test
    cd ..
    git diff --check

Manually check Vercel HTTP 200, Render health status UP, Google sign-in, 401 for unauthenticated API, two-account room join/media, expired and rotated codes, and no CSP/CORS/mixed-content errors.

Troubleshooting: auth/internal-error means provider/domain/config/CSP; 401 means token/project/API mismatch; CORS or WSS means exact FRONTEND_ORIGINS then Render redeploy; slow first request is Render sleep; no media means permissions/HTTPS/TURN; disappearing rooms are expected in-memory behavior.

## Roadmap and maintenance

1. Current prototype: authenticated small-room mesh and short-lived invitations.
2. Host lobby, verified email/domain allowlist, identity/safety-code panel and minimal audit events.
3. Managed TURN and relay-only privacy mode.
4. Firestore/Postgres schedules and Redis if distributed live state is needed.
5. Encoded-Transform E2EE, key rotation, threat model and external penetration test.
6. SFU, metrics/tracing, rate limiting, backups, incident response and SLA.

Keep dependencies patched, rotate deployment variables, review Firebase domains, inspect Render/Vercel logs, never commit env files/service-account JSON/TURN secrets/media, and repeat the two-browser test after WebRTC/CSP/WebSocket changes.

## Glossary

ID token: signed, short-lived Firebase identity credential.
SDP: session description used to negotiate a peer connection.
ICE: possible WebRTC network route.
STUN/TURN: discovery and relay services.
DTLS-SRTP: encrypted WebRTC media transport.
SFU: forwarding server for scalable rooms.
CSP: browser allowlist for scripts, frames and connections.

This guide lets a new maintainer reproduce the environment, create Firebase configuration, deploy both services, understand every major request/call path, and distinguish current guarantees from future work.

