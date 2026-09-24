# Knocknet

Knocknet is an identity-gated WebRTC meeting prototype. The frontend deploys to Vercel and the Spring Boot signaling/API service deploys to Render.

## Repository layout

- `frontend/` — Vite, static HTML/CSS/JavaScript, Firebase Google Authentication, and the browser WebRTC client.
- `backend/` — Java 21/Spring Boot REST API and WebSocket signaling service.
- `vercel.json` — frontend build and browser security headers.
- `render.yaml` — Render Docker service definition.

## Security model

The current implementation provides:

- Google sign-in through Firebase Authentication for every host and participant.
- Firebase ID-token verification by the backend, including issuer and audience validation.
- Exact-origin CORS and WebSocket origin restrictions.
- Authorization checks on room metadata, invite rotation, and WebSocket admission.
- Six-digit invitations that expire after 60 seconds and are rate-limited per account.
- Invite links that store the code in the URL fragment, which is not sent in HTTP requests or referrer headers.
- Same-room checks on every SDP, ICE, and media-state relay.
- WebSocket payload limits and one active call connection per identity.
- Browser security headers on Vercel and HTTPS/WSS-only production configuration.

WebRTC already encrypts media using DTLS-SRTP. Firebase authenticates identities; it does **not** transport video. In the current mesh design, media travels between participants (or through a future TURN relay while remaining encrypted), while Render only relays signaling metadata.

## Firebase setup

1. Create a Firebase project and register a Web app.
2. In Firebase Authentication, enable the Google provider.
3. Add the production Vercel domain and any custom domain to Firebase Authentication's authorized domains.
4. Copy `frontend/.env.example` into the Vercel project environment variables:

   - `VITE_API_BASE_URL` — the Render HTTPS service URL.
   - `VITE_FIREBASE_API_KEY`
   - `VITE_FIREBASE_AUTH_DOMAIN`
   - `VITE_FIREBASE_PROJECT_ID`
   - `VITE_FIREBASE_APP_ID`

Firebase's web configuration is intentionally public. Authorization is enforced by Firebase ID tokens and backend validation, not by hiding these values.

## Render setup

Create the service from `render.yaml` and set:

- `FRONTEND_ORIGINS` — exact comma-separated Vercel/custom origins, with no trailing slash.
- `FIREBASE_PROJECT_ID` — the same project ID used by the frontend.

The health check is `/actuator/health`. The container reads Render's `PORT` automatically.

## Vercel setup

Import the repository root. `vercel.json` installs and builds `frontend/`, then publishes `frontend/dist`. Add all `VITE_*` variables before deploying; Vite embeds them at build time.

## Development checks

```powershell
cd backend
.\gradlew.bat test

cd ..\frontend
npm ci
npm run build
```

## Product direction: Verified Ephemeral Rooms

The strongest defensible position is not “another meeting app.” It is a meeting product where participants can verify who entered, invitations die quickly, and the service minimizes what it can retain.

Recommended next security milestones:

1. Add a host-controlled lobby and an identity allowlist by verified email/domain.
2. Move scheduled meeting metadata to Firestore; keep live presence ephemeral.
3. Issue short-lived TURN credentials from the backend and offer a relay-only privacy mode that hides participant IP addresses from one another.
4. Add an in-call security panel showing verified identities, transport path, and a human-comparable room safety code.
5. Add WebRTC Encoded Transforms for application-level media E2EE, with room keys unavailable to the signaling service.
6. Publish a concise threat model and independent security test results. Verifiability is more credible than generic “military-grade encryption” copy.

## Current operational limits

### Voice translation and gesture assistance

Set `NVIDIA_API_KEY` on **Render**, where the Spring service runs. A Vercel variable does not configure Render. No NVIDIA credential belongs in a `VITE_*` variable or browser code. Rotate any previously committed key in NVIDIA's console and update Render.

Voice translation is push-to-talk: the browser records up to 28 seconds, converts the recording to mono 16-bit/16 kHz WAV, and sends it to the authenticated backend. The backend calls NVIDIA-hosted OpenAI Whisper Large v3 through Riva gRPC, then Riva Translate 4B Instruct v2 for text translation. Non-English language pairs use an English pivot. Whisper's hosted API is documented at https://build.nvidia.com/openai/whisper-large-v3/api. Translation audio is processed by NVIDIA; translated captions pass through signaling. This optional feature is not service-blind media E2EE. Browser voice availability varies by language and OS.

Gesture assistance runs locally with MediaPipe. Open the hand panel to load it. Build and development scripts copy the WASM files from the pinned MediaPipe package to keep JavaScript and native runtime compatible. It supports the listed gesture shortcuts and experimental static letter rules, **not full ASL/ISL sentence translation**. Hold one hand in view and lower it before repeating a gesture. Camera tracking continues independently of screen sharing.

Demo mode is a local camera/gesture preview. It does not open a call WebSocket or invoke authenticated translation. Use Google sign-in and a real room for voice translation and peer captions.

Regression checks: `npm --prefix frontend test` (install Chromium once with `npx playwright install chromium` from `frontend/`) and `backend/gradlew.bat -p backend test`. The optional live NVIDIA test requires `NVIDIA_API_KEY` and `NVIDIA_SMOKE_WAV` pointing to a mono 16 kHz WAV containing "hello"; ordinary tests make no provider calls.

Development priorities: reliable TURN connectivity and reconnect behavior; bounded translation usage and latency monitoring; durable scheduled meetings; accessibility evaluation with sign-language users and a trained, language-specific temporal model; an SFU only when room sizes outgrow the current mesh.

- Room and schedule state is in memory. A Render restart or free-tier spin-down clears it. Firestore or Redis is required before durable scheduling can be claimed.
- Render Free can take around a minute to wake and can restart at any time. It is appropriate for a prototype, not a production SLA.
- There is no TURN service yet, so calls can fail on restrictive networks. Do not embed permanent TURN credentials in the Vercel bundle.
- Full-mesh video scales poorly. Keep rooms small; use an SFU when larger meetings become a requirement.
