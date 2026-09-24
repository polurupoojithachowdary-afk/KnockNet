import { requireAuthenticatedUser } from './auth.js';
import { apiUrl } from './config.js';

let backendReadyUntil = 0;
let readinessCheck = null;

async function waitForBackend() {
  if (Date.now() < backendReadyUntil) return;
  if (readinessCheck) return readinessCheck;

  readinessCheck = (async () => {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(apiUrl('/actuator/health'), {
          cache: 'no-store',
          signal: controller.signal
        });
        const contentType = response.headers.get('content-type') || '';
        if (response.ok && contentType.includes('json')) {
          const health = await response.json();
          if (health.status === 'UP') {
            backendReadyUntil = Date.now() + 240000;
            return;
          }
        }
      } catch (_) {
        // Render Free may reject requests briefly while its instance wakes.
      } finally {
        clearTimeout(timeout);
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    throw new Error('The meeting service is still waking up. Please try again in a moment.');
  })();

  try {
    await readinessCheck;
  } finally {
    readinessCheck = null;
  }
}

export async function authenticatedFetch(path, options = {}) {
  await waitForBackend();
  const user = await requireAuthenticatedUser({ interactive: false });
  const token = await user.getIdToken();
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(apiUrl(path), { ...options, headers });
  if (response.status !== 401) return response;

  const refreshedToken = await user.getIdToken(true);
  headers.set('Authorization', `Bearer ${refreshedToken}`);
  return fetch(apiUrl(path), { ...options, headers });
}
