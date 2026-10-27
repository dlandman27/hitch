// What a request sent and got back: headers (with credentials hidden) and
// bodies, kept in memory for recent requests only. Bodies never go into saved
// session files; headers are redacted before they are stored anywhere.

// Credentials and session identifiers: shown as hidden everywhere.
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|access-token|token|x-csrf-token|x-xsrf-token|x-amz-security-token|x-session-token|x-firebase-appcheck|signature|x-signature|x-request-signature)$/i;
export const HIDDEN = '•••• hidden';
export const BODY_MAX = 256 * 1024;
export const REQUEST_BODY_MAX = 64 * 1024;
export const BODIES_KEPT = 150;

export function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return null;
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, SECRET_HEADER.test(name) ? HIDDEN : String(value)]));
}

// A body as text, cut to a size, with what was cut noted.
export function clip(text, max) {
  if (text == null) return null;
  const value = String(text);
  return value.length > max ? { text: value.slice(0, max), truncated: true, size: value.length } : { text: value, truncated: false, size: value.length };
}

// JSON pretty-printed when it parses; anything else unchanged.
export function prettyBody(text) {
  if (!text) return text;
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

// Recent response bodies by request event id; oldest dropped first.
export function createBodyStore(limit = BODIES_KEPT) {
  const bodies = new Map();
  return {
    set(id, body) {
      bodies.set(id, body);
      while (bodies.size > limit) bodies.delete(bodies.keys().next().value);
    },
    get: id => bodies.get(id) ?? null,
    clear: () => bodies.clear(),
  };
}

// Fields that look like credentials inside JSON bodies (a login request, a
// token refresh): hidden. Best effort; non-JSON bodies are left as they are.
const SECRET_FIELD = /^(password|passwd|pass|secret|client_secret|token|access_?token|refresh_?token|id_?token|api_?key|otp|pin|ssn|cvv|cvc|card_?number|authorization)$/i;
export function redactBody(text) {
  if (!text) return text;
  const trimmed = String(text).trim();
  if (!/^[[{]/.test(trimmed)) return text;
  try {
    const walk = value => {
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, SECRET_FIELD.test(key) && v != null && typeof v !== 'object' ? HIDDEN : walk(v)]));
      return value;
    };
    return JSON.stringify(walk(JSON.parse(trimmed)));
  } catch {
    return text;
  }
}
