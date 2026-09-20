const rawApiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').trim();

function normalizeBaseUrl(value) {
  if (!value) return '';
  const parsed = new URL(value);
  if (import.meta.env.PROD && parsed.protocol !== 'https:') {
    throw new Error('VITE_API_BASE_URL must use HTTPS in production');
  }
  return parsed.toString().replace(/\/$/, '');
}

export const apiBaseUrl = normalizeBaseUrl(rawApiBaseUrl);

export function apiUrl(path) {
  if (!apiBaseUrl) {
    throw new Error('The backend URL is not configured');
  }
  return `${apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

export function websocketUrl(path) {
  const url = new URL(apiUrl(path));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export const firebaseConfig = Object.freeze({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || ''
});

export const isFirebaseConfigured = Object.values(firebaseConfig).every(Boolean);
