import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const csp = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url)))
  .headers[0].headers.find(h => h.key === 'Content-Security-Policy').value;

test('demo joins without server authentication and the real hand tracker initializes under production CSP', async ({ page }) => {
  const errors = [], sockets = [], apiRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => sockets.push(socket.url()));
  page.on('request', request => { if (request.url().includes('/api/')) apiRequests.push(request.url()); });
  await page.route('**/room.html?demo=true', async route => {
    const response = await route.fetch();
    // Vite's development HMR needs inline scripts; production bundle does not.
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace('upgrade-insecure-requests', '') } });
  });
  await page.goto('/room.html?demo=true');
  await expect(page.locator('#local-display-name')).toHaveText('Local preview');
  await expect(page.locator('#auth-gate')).not.toHaveClass(/active/);
  await expect(page.locator('body')).toHaveAttribute('data-room-ready', 'true');
  await page.locator('#btn-toggle-translate').click();
  await expect(page.locator('#push-to-talk-label')).toHaveText('Join a meeting to translate voice');
  await page.locator('#btn-toggle-sign').click();
  await expect(page.locator('#sign-status-text')).toHaveText('Tracking hand signs', { timeout: 45000 });
  await page.locator('#btn-close-sign').click();
  await expect(page.locator('#sign-status-text')).toHaveText('Translation paused');
  expect(errors).toEqual([]);
  expect(sockets.filter(url => !url.includes('localhost:5173'))).toEqual([]);
  expect(apiRequests).toEqual([]);
});

test('recorded browser audio is converted to mono 16 kHz WAV and voice subtitles use the server protocol', async ({ page }) => {
  await page.goto('/room.html?demo=true');
  const result = await page.evaluate(async () => {
    const { recordingToWav } = await import('/js/audio.js');
    const { TranslateManager } = await import('/js/translate.js');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = e => chunks.push(e.data);
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });
    recorder.start();
    await new Promise(resolve => setTimeout(resolve, 600));
    recorder.stop(); await stopped;
    stream.getTracks().forEach(t => t.stop());
    const wav = await recordingToWav(new Blob(chunks, { type: recorder.mimeType }));
    const view = new DataView(await wav.arrayBuffer());
    let message;
    const translator = new TranslateManager({ sendToPeer: data => { message = data; } });
    translator.speak = () => {};
    translator.emitTranslation('Hello', 'Hola', 'es');
    return { channels: view.getUint16(22, true), rate: view.getUint32(24, true), bits: view.getUint16(34, true), bytes: wav.size, message };
  });
  expect(result.channels).toBe(1);
  expect(result.rate).toBe(16000);
  expect(result.bits).toBe(16);
  expect(result.bytes).toBeGreaterThan(3200);
  expect(result.message.type).toBe('translation-subtitle');
});

test('early ICE is buffered and rejected joins do not reconnect', async ({ page }) => {
  await page.goto('/room.html?demo=true');
  const result = await page.evaluate(async () => {
    const { WebRTCManager } = await import('/js/webrtc.js');
    const manager = new WebRTCManager();
    const candidate = { candidate: 'candidate:1 1 UDP 2122260223 192.0.2.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
    await manager.handleSignalingMessage({ type: 'ice-candidate', from: 'peer', candidate });
    const buffered = manager.pendingCandidates.get('peer').length;
    let applied = 0, closed = false;
    await manager.flushCandidates('peer', { addIceCandidate: async () => { applied++; } });
    manager.ws = { close: () => { closed = true; } };
    manager.onError = () => {};
    await manager.handleSignalingMessage({ type: 'error', code: 'ROOM_NOT_FOUND' });
    return { buffered, applied, closed, reconnect: manager.shouldReconnect };
  });
  expect(result).toEqual({ buffered: 1, applied: 1, closed: true, reconnect: false });
});

test('holding a gesture emits once, and lowering the hand permits repeating it', async ({ page }) => {
  await page.goto('/room.html?demo=true');
  const result = await page.evaluate(async () => {
    const { SignLanguageManager } = await import('/js/sign-language.js');
    const messages = [];
    const manager = new SignLanguageManager({ sendToPeer: m => messages.push(m) });
    manager.ttsEnabled = false;
    const sign = { sign: 'YES', spoken: 'Yes', label: 'Thumbs up' };
    manager.onConfirmedSign(sign);
    manager.lastSpokenTime = 0;
    manager.onConfirmedSign(sign);
    const heldCount = messages.length;
    for (let i = 0; i < 6; i++) manager.processResults({ landmarks: [] });
    manager.onConfirmedSign(sign);
    return { heldCount, releasedCount: messages.length, sentence: manager.getSentence() };
  });
  expect(result).toEqual({ heldCount: 1, releasedCount: 2, sentence: 'Yes Yes' });
});
