// Settings storage + validation. Shared by the background script, popup and options page.
// Imported as an ES module; it has no DOM dependencies so it is also unit-tested in Node.

const ext = globalThis.browser ?? globalThis.chrome;

export const LANGUAGES = [
  'ko', 'en', 'ja', 'zh-CN', 'zh-TW', 'es', 'fr', 'de', 'it', 'pt', 'pt-BR', 'ru', 'uk', 'pl',
  'nl', 'sv', 'cs', 'el', 'tr', 'ar', 'he', 'fa', 'hi', 'th', 'vi', 'id', 'ms',
];

export const STYLES = ['subtle', 'plain', 'highlight', 'underline'];

/**
 * microsoft / google: free web endpoints, no key. openai: any OpenAI-compatible API (own key or local).
 * microsoft is the default: Google blocks a connection (HTTP 429, captcha) far more readily.
 */
export const ENGINES = ['microsoft', 'google', 'openai'];

export const DEFAULTS = Object.freeze({
  engine: 'microsoft',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  targetLang: 'ko',
  style: 'subtle',
  extraPrompt: '',
  batchMaxItems: 8,
  batchMaxChars: 2400,
  concurrency: 3,
  autoDomains: [],
});

const clampInt = (value, min, max, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** "https://www.Example.com:8080/path" -> "example.com". Returns "" when invalid. */
export function normalizeDomain(input) {
  let s = String(input ?? '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0];
  s = s.replace(/:\d+$/, '').replace(/^www\./, '').replace(/^\.+|\.+$/g, '');
  return /^[a-z0-9.-]+$/.test(s) ? s : '';
}

/** Coerce arbitrary stored/user input into a valid settings object. */
export function sanitize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const str = (v, d) => (typeof v === 'string' ? v.trim() : d);

  let baseUrl = str(r.baseUrl, DEFAULTS.baseUrl).replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) baseUrl = DEFAULTS.baseUrl;

  const domainList = Array.isArray(r.autoDomains)
    ? r.autoDomains
    : String(r.autoDomains ?? '').split(/[\s,]+/);
  const autoDomains = [...new Set(domainList.map(normalizeDomain).filter(Boolean))];

  const apiKey = str(r.apiKey, DEFAULTS.apiKey);

  // Settings saved before engines existed had no `engine` and always meant the OpenAI-compatible API.
  const legacyOpenAi = apiKey !== DEFAULTS.apiKey || baseUrl !== DEFAULTS.baseUrl;
  const engine = ENGINES.includes(r.engine) ? r.engine : legacyOpenAi ? 'openai' : DEFAULTS.engine;

  return {
    engine,
    baseUrl,
    apiKey,
    model: str(r.model, DEFAULTS.model) || DEFAULTS.model,
    targetLang: LANGUAGES.includes(r.targetLang) ? r.targetLang : DEFAULTS.targetLang,
    style: STYLES.includes(r.style) ? r.style : DEFAULTS.style,
    extraPrompt: str(r.extraPrompt, '').slice(0, 2000),
    batchMaxItems: clampInt(r.batchMaxItems, 1, 30, DEFAULTS.batchMaxItems),
    batchMaxChars: clampInt(r.batchMaxChars, 200, 8000, DEFAULTS.batchMaxChars),
    concurrency: clampInt(r.concurrency, 1, 8, DEFAULTS.concurrency),
    autoDomains,
  };
}

/** True when hostname equals one of the domains or is a subdomain of it. */
export function hostMatches(hostname, domains) {
  const host = String(hostname ?? '').toLowerCase();
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * google / microsoft work out of the box. For the OpenAI-compatible engine the official endpoint is
 * useless without a key; local servers (Ollama, LM Studio) need none.
 */
export function isConfigured(settings) {
  if (settings.engine && settings.engine !== 'openai') return true;
  if (settings.apiKey) return true;
  try {
    return new URL(settings.baseUrl).hostname !== 'api.openai.com';
  } catch {
    return false;
  }
}

/** Settings that are safe to hand to content scripts (no API key). */
export function publicSettings(settings) {
  const { apiKey, ...rest } = settings;
  return { ...rest, configured: isConfigured(settings) };
}

export async function loadSettings() {
  const { settings } = await ext.storage.local.get('settings');
  return sanitize(settings);
}

export async function saveSettings(settings) {
  const clean = sanitize(settings);
  await ext.storage.local.set({ settings: clean });
  return clean;
}
