// Translation engines. `translate()` is the single entry point used by the background script.
//
//   google     Google Translate's free web endpoint (no key).      One text per request.
//   microsoft  Microsoft Translator via the Bing Translator web UI (no key). One text per request.
//   openai     Any OpenAI-compatible /chat/completions endpoint (own key / local server). Batched.
//
// google and microsoft are the *unofficial* endpoints the public web UIs use. They need no account
// but are undocumented, rate limited and may change or stop working at any time.
//
// Pure ES module (fetch is injectable) so it can be unit-tested in Node.

import { requestTranslations as translateWithLlm } from './llm.js';

/** Engines that translate one text per request; the caller should fan texts out over its own limiter. */
export const isPerTextEngine = (engine) => engine === 'google' || engine === 'microsoft';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- text splitting -----------------------------------------------------------------------
// Both web endpoints cap the size of one request (Bing: 1000 chars). Long texts are cut at
// paragraph / sentence / word boundaries and the pieces are translated one after another.

const SENTENCE_END = /[.!?。！？…]["')\]”’」』]*\s/g;

/** Split `text` into pieces of at most `max` chars. `sep` is the whitespace that followed each piece. */
export function splitText(text, max) {
  if (text.length <= max) return [{ text, sep: '' }];

  const pieces = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1); // +1 so a break exactly at `max` is visible
    const floor = Math.floor(max * 0.4); // do not make tiny pieces

    let cut = window.lastIndexOf('\n');
    if (cut < floor) {
      cut = -1;
      for (const m of window.matchAll(SENTENCE_END)) cut = m.index + m[0].length - 1; // the whitespace char
    }
    if (cut < floor) cut = window.search(/\s\S*$/); // last whitespace
    if (cut < floor) {
      cut = max; // no usable boundary (e.g. CJK without punctuation): hard cut
      const prev = rest.charCodeAt(cut - 1);
      if (prev >= 0xd800 && prev <= 0xdbff) cut -= 1; // do not split a surrogate pair
    }

    const head = rest.slice(0, cut);
    const tail = rest.slice(cut);
    const piece = head.trimEnd();
    pieces.push({ text: piece, sep: head.slice(piece.length) + tail.slice(0, tail.length - tail.trimStart().length) });
    rest = tail.trimStart();
  }
  if (rest) pieces.push({ text: rest, sep: '' });
  return pieces.filter((p) => p.text.length > 0);
}

/** Translate `text` piece by piece with `one(piece)` and stitch the results back together. */
async function translateLong(text, max, one) {
  const pieces = splitText(text, max);
  let out = '';
  for (let i = 0; i < pieces.length; i++) {
    out += (await one(pieces[i].text)) + (i < pieces.length - 1 ? pieces[i].sep : '');
  }
  return out;
}

// ---- HTTP helper --------------------------------------------------------------------------

/** fetch with timeout and retries (network errors, 429, 5xx). Resolves with an ok Response. */
async function request(url, init, opts = {}) {
  const { fetchImpl = globalThis.fetch, retries = 2, timeoutMs = 30000, sleep = defaultSleep } = opts;

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, { ...init, credentials: 'omit', signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      if (attempt < retries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw new Error(err?.name === 'AbortError' ? 'Request timed out' : `Network error: ${err?.message || err}`);
    }
    clearTimeout(timer);

    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const hint = res.status === 429 ? ' (too many requests: wait a moment, lower the concurrency, or switch engine)' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
}

// ---- Google -------------------------------------------------------------------------------

const GOOGLE_URL = 'https://translate.googleapis.com/translate_a/single';
const GOOGLE_MAX_CHARS = 4000;

async function googlePiece(text, settings, opts) {
  const body = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: settings.targetLang, dt: 't', q: text });
  const res = await request(
    GOOGLE_URL,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() },
    opts,
  );
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('Google Translate returned an invalid response');
  }
  // [[["translated", "original", ...], ...sentences], null, "detected-lang", ...]
  if (!Array.isArray(data?.[0])) throw new Error('Unexpected response format from Google Translate');
  return data[0].map((segment) => (typeof segment?.[0] === 'string' ? segment[0] : '')).join('');
}

// ---- Microsoft (Bing Translator web UI) ---------------------------------------------------

const BING_PAGE = 'https://www.bing.com/translator';
const BING_API = 'https://www.bing.com/ttranslatev3';
const BING_MAX_CHARS = 900; // the endpoint rejects more than 1000
const BING_SESSION_MAX_AGE_MS = 50 * 60 * 1000; // tokens last 1 h; renew early

// The web UI uses its own codes for Chinese and Portuguese.
const BING_LANG = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', pt: 'pt-pt', 'pt-BR': 'pt' };
export const bingLanguage = (code) => BING_LANG[code] ?? code;

let bingSession = null; // { ig, key, token, expires }
let bingSessionLoading = null;

/** Forget the cached Bing token (used by tests and after the server rejects it). */
export function resetBingSession() {
  bingSession = null;
  bingSessionLoading = null;
}

/** Pull the request signature (IG) and the abuse-prevention token out of the translator page. */
export function parseBingPage(html) {
  const ig = html.match(/IG:"([A-Z0-9]+)"/)?.[1];
  const helper = html.match(/params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"]+)"/);
  if (!ig || !helper) return null;
  return { ig, key: helper[1], token: helper[2] };
}

async function loadBingSession(opts, force) {
  if (!force && bingSession && bingSession.expires > Date.now()) return bingSession;
  if (!bingSessionLoading) {
    bingSessionLoading = (async () => {
      const res = await request(BING_PAGE, { method: 'GET' }, opts);
      const parsed = parseBingPage(await res.text());
      if (!parsed) throw new Error('Could not start a Microsoft Translator session (the page layout may have changed)');
      bingSession = { ...parsed, expires: Date.now() + BING_SESSION_MAX_AGE_MS };
      return bingSession;
    })().finally(() => {
      bingSessionLoading = null;
    });
  }
  return bingSessionLoading;
}

async function bingRequest(text, settings, opts, session) {
  const body = new URLSearchParams({
    fromLang: 'auto-detect',
    text,
    to: bingLanguage(settings.targetLang),
    token: session.token,
    key: session.key,
  });
  const res = await request(
    `${BING_API}?isVertical=1&IG=${session.ig}&IID=translator.5028.1`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() },
    opts,
  );
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('Microsoft Translator returned an invalid response');
  }
  return data;
}

async function bingPiece(text, settings, opts) {
  const session = await loadBingSession(opts, false);
  let data = await bingRequest(text, settings, opts, session);
  let translated = data?.[0]?.translations?.[0]?.text;

  // Errors come back as HTTP 200 with {"statusCode": ...}; 205 means the token is no longer valid.
  // Renew the session (unless a concurrent request already did) and try once more.
  if (typeof translated !== 'string' && data?.statusCode === 205) {
    const fresh = bingSession && bingSession !== session ? bingSession : await loadBingSession(opts, true);
    data = await bingRequest(text, settings, opts, fresh);
    translated = data?.[0]?.translations?.[0]?.text;
  }
  if (typeof translated === 'string') return translated;

  const code = data?.statusCode
    ? ` (code ${data.statusCode})`
    : data?.ShowCaptcha
      ? ' (captcha required: try again later)'
      : '';
  throw new Error(`Microsoft Translator rejected the request${code}`);
}

// ---- dispatcher ---------------------------------------------------------------------------

/**
 * Translate `texts` (array of strings) and return an array of the same length.
 * `settings.engine` selects the backend.
 */
export async function translate(texts, settings, opts = {}) {
  switch (settings.engine) {
    case 'google':
    case 'microsoft': {
      const [max, piece] =
        settings.engine === 'google' ? [GOOGLE_MAX_CHARS, googlePiece] : [BING_MAX_CHARS, bingPiece];
      const out = [];
      for (const text of texts) out.push(await translateLong(text, max, (p) => piece(p, settings, opts)));
      return out;
    }
    default:
      return translateWithLlm(texts, settings, opts);
  }
}
