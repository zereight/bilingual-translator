// Translation engines. `translate()` is the single entry point used by the background script.
//
//   google     Google Translate's free web endpoint (no key).
//   microsoft  Microsoft Translator via the Bing Translator web UI (no key).
//   openai     Any OpenAI-compatible /chat/completions endpoint (own key / local server).
//
// google and microsoft are the *unofficial* endpoints the public web UIs use. They need no account
// but are undocumented, rate limited and may change or stop working at any time. To stay under
// their limits several paragraphs travel in one request (joined by newlines, checked on the way
// back) and every request goes through a per-service gate (see "being polite" below).
//
// Pure ES module (fetch is injectable) so it can be unit-tested in Node.

import { requestTranslations as translateWithLlm } from './llm.js';

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

// ---- being polite: pacing, shared cool-down, circuit breaker -----------------------------
// Both services rate limit per connection. Sending one request per paragraph from several workers
// at once gets the connection blocked (HTTP 429 with a captcha page), and hammering a blocked
// connection does not help. Every request therefore passes a per-service gate that
//   * spaces request starts at least MIN_GAP_MS apart,
//   * makes everybody wait after a 429 (escalating, honours Retry-After),
//   * and, once a request has given up on 429, refuses new ones for BREAKER_MS without sending anything.

const SERVICE_LABEL = { google: 'Google Translate', microsoft: 'Microsoft Translator' };
const MIN_GAP_MS = 250;
const COOLDOWN_STEPS_MS = [2000, 5000, 15000]; // after the 1st, 2nd, 3rd+ rate limit in a row
const MAX_RETRY_AFTER_MS = 30000;
const BREAKER_MS = 60000;

const gates = new Map(); // service -> { nextStart, cooldownUntil, breakerUntil, strikes }

function gateFor(service) {
  if (!gates.has(service)) gates.set(service, { nextStart: 0, cooldownUntil: 0, breakerUntil: 0, strikes: 0 });
  return gates.get(service);
}

/** Thrown when a service answers 429 (or while the circuit breaker is open). `code` is stable for callers. */
export class RateLimitError extends Error {
  constructor(service, retryInSeconds) {
    const label = SERVICE_LABEL[service] ?? service;
    super(
      `${label} is rate limiting this connection (HTTP 429). Wait about ${retryInSeconds} s, or switch the translation engine in the settings.`,
    );
    this.name = 'RateLimitError';
    this.code = 'rate_limited';
    this.service = label;
    this.retryInSeconds = retryInSeconds;
  }
}

async function waitForTurn(gate, service, sleep, now) {
  for (;;) {
    const t = now();
    if (gate.breakerUntil > t) throw new RateLimitError(service, Math.ceil((gate.breakerUntil - t) / 1000));
    const wait = Math.max(gate.nextStart, gate.cooldownUntil) - t;
    if (wait <= 0) {
      gate.nextStart = t + MIN_GAP_MS;
      return;
    }
    await sleep(wait);
  }
}

function noteRateLimited(gate, res, now) {
  const t = now();
  if (t < gate.cooldownUntil) return; // concurrent 429s inside one cool-down count once
  gate.strikes += 1;
  const step = COOLDOWN_STEPS_MS[Math.min(gate.strikes, COOLDOWN_STEPS_MS.length) - 1];
  const header = Number(res.headers?.get?.('retry-after'));
  const hinted = Number.isFinite(header) && header > 0 ? Math.min(header * 1000, MAX_RETRY_AFTER_MS) : 0;
  gate.cooldownUntil = t + Math.max(step, hinted);
}

/** Forget the cached Bing token, the gates and the batching statistics (tests; also a clean slate). */
export function resetEngineState() {
  bingSession = null;
  bingSessionLoading = null;
  gates.clear();
  batchMismatches.clear();
}

// ---- HTTP helper --------------------------------------------------------------------------

/**
 * fetch with timeout and retries (network errors, 429, 5xx). Resolves with an ok Response.
 * `opts.gate` names the service whose gate the request passes; `opts.now` / `opts.sleep` are injectable.
 */
async function request(url, init, opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    retries = 2,
    timeoutMs = 30000,
    sleep = defaultSleep,
    now = Date.now,
    gate: service,
  } = opts;
  const gate = service ? gateFor(service) : null;

  for (let attempt = 0; ; attempt++) {
    if (gate) await waitForTurn(gate, service, sleep, now);

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

    if (res.ok) {
      if (gate) gate.strikes = 0;
      return res;
    }
    if (res.status === 429 && gate) noteRateLimited(gate, res, now);

    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      // With a gate the next attempt waits out the cool-down by itself; otherwise plain backoff.
      if (!(res.status === 429 && gate)) await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 429) {
      if (!gate) throw new Error('HTTP 429 (too many requests)');
      gate.breakerUntil = now() + BREAKER_MS;
      throw new RateLimitError(service, BREAKER_MS / 1000);
    }
    throw new Error(`HTTP ${res.status}`);
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
    { ...opts, gate: 'google' },
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
      const res = await request(BING_PAGE, { method: 'GET' }, { ...opts, gate: 'microsoft' });
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
    { ...opts, gate: 'microsoft' },
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

// ---- batching -----------------------------------------------------------------------------
// Several paragraphs are sent in one request, joined by "\n" (paragraphs are whitespace-normalised
// upstream, so they contain no newlines of their own). The reply is split on "\n" again and only
// trusted when it has exactly as many non-empty lines; otherwise each paragraph is sent on its own.
// If that keeps happening the engine stops batching until the worker restarts.

const BATCH_MAX_ITEMS = 20;
const MAX_BATCH_MISMATCHES = 3;
const batchMismatches = new Map(); // engine -> consecutive batches whose line count did not match

/**
 * Group texts, in order, into requests of at most `maxChars` characters (joining newlines included)
 * and `maxItems` texts. A text that alone exceeds `maxChars` gets a group of its own.
 */
export function packTexts(texts, maxChars, maxItems = BATCH_MAX_ITEMS) {
  const groups = [];
  let current = null;
  texts.forEach((text, index) => {
    if (text.length > maxChars) {
      groups.push({ indexes: [index] });
      current = null;
    } else if (current && current.indexes.length < maxItems && current.size + 1 + text.length <= maxChars) {
      current.indexes.push(index);
      current.size += 1 + text.length;
    } else {
      current = { indexes: [index], size: text.length };
      groups.push(current);
    }
  });
  return groups;
}

const FREE_ENGINES = {
  google: { piece: googlePiece, maxChars: GOOGLE_MAX_CHARS },
  microsoft: { piece: bingPiece, maxChars: BING_MAX_CHARS },
};

async function translateFree(engine, texts, settings, opts) {
  const { piece, maxChars } = FREE_ENGINES[engine];
  const alone = (text) => translateLong(text, maxChars, (p) => piece(p, settings, opts));
  const results = new Array(texts.length);

  for (const { indexes } of packTexts(texts, maxChars)) {
    if (indexes.length > 1 && (batchMismatches.get(engine) ?? 0) < MAX_BATCH_MISMATCHES) {
      const lines = indexes.map((i) => texts[i].replace(/\s*\n\s*/g, ' '));
      const parts = (await piece(lines.join('\n'), settings, opts)).split('\n');
      if (parts.length === indexes.length && parts.every((part) => part.trim())) {
        batchMismatches.set(engine, 0);
        indexes.forEach((i, j) => {
          results[i] = parts[j];
        });
        continue;
      }
      batchMismatches.set(engine, (batchMismatches.get(engine) ?? 0) + 1);
    }
    for (const i of indexes) results[i] = await alone(texts[i]);
  }
  return results;
}

// ---- dispatcher ---------------------------------------------------------------------------

/**
 * Translate `texts` (array of strings) and return an array of the same length.
 * `settings.engine` selects the backend.
 */
export async function translate(texts, settings, opts = {}) {
  if (FREE_ENGINES[settings.engine]) return translateFree(settings.engine, texts, settings, opts);
  return translateWithLlm(texts, settings, opts);
}
