import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  RateLimitError,
  microsoftLanguage,
  packTexts,
  resetEngineState,
  splitText,
  translate,
} from '../src/lib/engines.js';

beforeEach(() => resetEngineState());

// ---- helpers ------------------------------------------------------------------------------

/** A fake clock: sleeping just moves time forward, so cool-downs and gaps cost no real time. */
function clock(start = 1_000_000) {
  let t = start;
  const slept = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
    slept,
  };
}

/** translate() with a fake clock (a fresh one unless `clock` is given). */
function call(texts, settings, extra = {}) {
  const { clock: c = clock(), ...rest } = extra;
  return translate(texts, settings, { now: c.now, sleep: c.sleep, ...rest });
}

const json = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
const html = (body) => ({ ok: true, status: 200, text: async () => body });
const failing = (status, headers = {}) => ({ ok: false, status, headers: new Headers(headers), json: async () => ({}), text: async () => '' });

/** A fetch stub that records every call (with the fake time it happened at) and answers via `handler`. */
function stubFetch(handler, c) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const entry = { url: String(url), init, form: init.body ? new URLSearchParams(String(init.body)) : null, at: c?.now() };
    calls.push(entry);
    return handler(entry);
  };
  fn.calls = calls;
  return fn;
}

// ---- splitText ----------------------------------------------------------------------------

test('splitText: short text is returned as is', () => {
  assert.deepEqual(splitText('Hello there.', 50), [{ text: 'Hello there.', sep: '' }]);
});

test('splitText: pieces respect the limit and rejoin to the original', () => {
  const text = 'First sentence is here. Second sentence follows it. Third one ends the paragraph. And a fourth.';
  const pieces = splitText(text, 40);
  assert.ok(pieces.length > 1);
  for (const p of pieces) assert.ok(p.text.length <= 40, `piece too long: ${p.text.length}`);
  const rejoined = pieces.map((p, i) => p.text + (i < pieces.length - 1 ? p.sep : '')).join('');
  assert.equal(rejoined, text);
  assert.equal(pieces[0].text, 'First sentence is here.'); // cut at a sentence boundary
});

test('splitText: prefers line breaks and keeps the original separator', () => {
  const text = 'Line one is quite long here.\n\nLine two is also long here.';
  const pieces = splitText(text, 35);
  assert.equal(pieces[0].text, 'Line one is quite long here.');
  assert.equal(pieces[0].sep, '\n\n');
});

test('splitText: falls back to words, then to a hard cut (CJK, no spaces)', () => {
  const words = splitText('alpha beta gamma delta epsilon zeta', 12);
  for (const w of words) assert.ok(w.text.length <= 12);
  assert.equal(words.map((p, i) => p.text + (i < words.length - 1 ? p.sep : '')).join(''), 'alpha beta gamma delta epsilon zeta');

  const cjk = '日本語'.repeat(20); // 60 chars, no boundaries
  const pieces = splitText(cjk, 25);
  for (const p of pieces) assert.ok(p.text.length <= 25);
  assert.equal(pieces.map((p) => p.text).join(''), cjk);
});

test('splitText: never splits a surrogate pair', () => {
  const emoji = '😀'.repeat(15); // 30 UTF-16 units, no boundaries
  const pieces = splitText(emoji, 7); // an odd limit would cut a pair in half
  for (const p of pieces) {
    assert.ok(p.text.length <= 7);
    assert.doesNotMatch(p.text, /^[\udc00-\udfff]|[\ud800-\udbff]$/);
  }
  assert.equal(pieces.map((p) => p.text).join(''), emoji);
});

// ---- packTexts ----------------------------------------------------------------------------

test('packTexts: greedy, in order, joining newlines count towards the limit', () => {
  const groups = packTexts(['a'.repeat(300), 'b'.repeat(300), 'c'.repeat(300), 'd'.repeat(300), 'e'.repeat(300)], 900);
  assert.deepEqual(groups.map((g) => g.indexes), [[0, 1], [2, 3], [4]]); // 300+1+300 = 601, a third would make 902
});

test('packTexts: honours the item limit', () => {
  const groups = packTexts(Array.from({ length: 45 }, () => 'x'), 4000, 20);
  assert.deepEqual(groups.map((g) => g.indexes.length), [20, 20, 5]);
});

test('packTexts: an oversize text gets its own group and does not swallow its neighbours', () => {
  const groups = packTexts(['short', 'L'.repeat(1000), 'tail', 'end'], 900);
  assert.deepEqual(groups.map((g) => g.indexes), [[0], [1], [2, 3]]);
});

// ---- google -------------------------------------------------------------------------------

const googleSettings = { engine: 'google', targetLang: 'ko' };
const googleReply = (...sentences) => json([sentences.map((s) => [s, 'orig', null, null, 3]), null, 'en']);
/** Translates every line to "[line]" and keeps the line structure, like the real service does. */
const googleEcho = (c) => googleReply(c.form.get('q').split('\n').map((l) => `[${l}]`).join('\n'));

test('google: posts the text as a form body (not in the URL) and joins the sentence segments', async () => {
  const fetchImpl = stubFetch(() => googleReply('안녕, 세상! ', '이것은 테스트입니다.'));
  const out = await call(['Hello, world! This is a test.'], googleSettings, { fetchImpl });

  assert.deepEqual(out, ['안녕, 세상! 이것은 테스트입니다.']);
  const [req] = fetchImpl.calls;
  assert.equal(req.url, 'https://translate.googleapis.com/translate_a/single');
  assert.equal(req.init.method, 'POST');
  assert.equal(req.init.credentials, 'omit');
  assert.equal(req.form.get('q'), 'Hello, world! This is a test.');
  assert.equal(req.form.get('tl'), 'ko');
  assert.equal(req.form.get('sl'), 'auto');
  assert.equal(req.form.get('client'), 'gtx');
  assert.equal(req.url.includes('Hello'), false);
});

test('google: several texts travel in ONE request, joined by newlines, and come back in order', async () => {
  const fetchImpl = stubFetch(googleEcho);
  const out = await call(['a', 'b', 'c'], googleSettings, { fetchImpl });
  assert.deepEqual(out, ['[a]', '[b]', '[c]']);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].form.get('q'), 'a\nb\nc');
});

test('google: many texts become few requests (item limit), order preserved across them', async () => {
  const texts = Array.from({ length: 45 }, (_, i) => String(i).padStart(5, '0'));
  const fetchImpl = stubFetch(googleEcho);
  const out = await call(texts, googleSettings, { fetchImpl });
  assert.equal(fetchImpl.calls.length, 3); // 20 + 20 + 5
  assert.deepEqual(out, texts.map((t) => `[${t}]`));
});

test('google: the 4000-character request cap starts a new request', async () => {
  const texts = ['a', 'b', 'c'].map((ch) => ch.repeat(1500));
  const fetchImpl = stubFetch(googleEcho);
  const out = await call(texts, googleSettings, { fetchImpl });
  assert.deepEqual(fetchImpl.calls.map((c) => c.form.get('q').length), [3001, 1500]);
  assert.deepEqual(out, texts.map((t) => `[${t}]`));
});

test('google: a text longer than the cap is split, translated piece by piece and stitched together', async () => {
  const sentence = 'The quick brown fox jumps over the lazy dog. ';
  const text = sentence.repeat(120).trim(); // ~5400 chars
  const fetchImpl = stubFetch((c) => googleReply(c.form.get('q').toUpperCase()));
  const [out] = await call([text], googleSettings, { fetchImpl });

  assert.ok(fetchImpl.calls.length >= 2);
  for (const c of fetchImpl.calls) assert.ok(c.form.get('q').length <= 4000);
  assert.equal(out, text.toUpperCase()); // nothing lost, nothing duplicated, separators preserved
});

test('google: an oversize text between short ones keeps every result in place', async () => {
  const long = 'Word '.repeat(1000).trim(); // 4999 chars
  const fetchImpl = stubFetch((c) => googleReply(c.form.get('q').toUpperCase()));
  const out = await call(['first', long, 'last'], googleSettings, { fetchImpl });
  assert.equal(out[0], 'FIRST');
  assert.equal(out[1], long.toUpperCase());
  assert.equal(out[2], 'LAST');
});

test('google: if the line count does not come back right, each text is sent on its own', async () => {
  const fetchImpl = stubFetch((c) => (c.form.get('q').includes('\n') ? googleReply(c.form.get('q').replace(/\n/g, ' ')) : googleEcho(c)));
  const out = await call(['a', 'b', 'c'], googleSettings, { fetchImpl });
  assert.deepEqual(out, ['[a]', '[b]', '[c]']);
  assert.equal(fetchImpl.calls.length, 4); // 1 batch attempt + 3 singles
});

test('google: an empty line in the reply also counts as a mismatch', async () => {
  const fetchImpl = stubFetch((c) => (c.form.get('q') === 'a\nb\nc' ? googleReply('A\n\nC') : googleEcho(c)));
  const out = await call(['a', 'b', 'c'], googleSettings, { fetchImpl });
  assert.deepEqual(out, ['[a]', '[b]', '[c]']);
});

test('google: after 3 failed batches in a row it stops batching; a good batch resets the count', async () => {
  const c = clock();
  const bad = stubFetch((e) => (e.form.get('q').includes('\n') ? googleReply('one line') : googleEcho(e)), c);
  for (let i = 0; i < 3; i++) await call(['x', 'y'], googleSettings, { fetchImpl: bad, clock: c });
  bad.calls.length = 0;
  await call(['x', 'y'], googleSettings, { fetchImpl: bad, clock: c });
  assert.deepEqual(bad.calls.map((e) => e.form.get('q')), ['x', 'y']); // straight to singles, no batch attempt

  resetEngineState();
  const flaky = stubFetch((e) => googleEcho(e), c);
  const mismatchOnce = stubFetch((e) => (e.form.get('q').includes('\n') ? googleReply('one line') : googleEcho(e)), c);
  await call(['x', 'y'], googleSettings, { fetchImpl: mismatchOnce, clock: c });
  await call(['x', 'y'], googleSettings, { fetchImpl: mismatchOnce, clock: c });
  await call(['x', 'y'], googleSettings, { fetchImpl: flaky, clock: c }); // good batch -> counter back to 0
  await call(['x', 'y'], googleSettings, { fetchImpl: mismatchOnce, clock: c });
  mismatchOnce.calls.length = 0;
  await call(['x', 'y'], googleSettings, { fetchImpl: mismatchOnce, clock: c });
  assert.equal(mismatchOnce.calls[0].form.get('q'), 'x\ny'); // still batching
});

test('google: requests are spaced out, not fired back to back', async () => {
  const c = clock();
  const fetchImpl = stubFetch(googleEcho, c);
  await call(['a'.repeat(3000), 'b'.repeat(3000), 'c'.repeat(3000)], googleSettings, { fetchImpl, clock: c });
  const times = fetchImpl.calls.map((e) => e.at);
  assert.equal(times.length, 3);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 250, `gap ${times[i] - times[i - 1]} ms`);
});

test('google: a 429 makes the next attempt wait out a cool-down, then it succeeds', async () => {
  const c = clock();
  const replies = [failing(429), googleReply('ok')];
  const fetchImpl = stubFetch(() => replies.shift(), c);
  const out = await call(['x'], googleSettings, { fetchImpl, clock: c });
  assert.deepEqual(out, ['ok']);
  const [first, second] = fetchImpl.calls;
  assert.ok(second.at - first.at >= 2000, `waited only ${second.at - first.at} ms`);
});

test('google: a 5xx is retried with plain backoff', async () => {
  const replies = [failing(503), googleReply('ok')];
  const fetchImpl = stubFetch(() => replies.shift());
  const out = await call(['x'], googleSettings, { fetchImpl });
  assert.deepEqual(out, ['ok']);
  assert.equal(fetchImpl.calls.length, 2);
});

test('google: Retry-After is honoured (capped at 30 s)', async () => {
  const c = clock();
  const replies = [failing(429, { 'retry-after': '10' }), googleReply('ok')];
  const fetchImpl = stubFetch(() => replies.shift(), c);
  await call(['x'], googleSettings, { fetchImpl, clock: c });
  assert.ok(fetchImpl.calls[1].at - fetchImpl.calls[0].at >= 10000);

  resetEngineState();
  const c2 = clock();
  const huge = [failing(429, { 'retry-after': '3600' }), googleReply('ok')];
  const f2 = stubFetch(() => huge.shift(), c2);
  await call(['x'], googleSettings, { fetchImpl: f2, clock: c2 });
  const waited = f2.calls[1].at - f2.calls[0].at;
  assert.ok(waited >= 30000 && waited < 40000, `waited ${waited} ms`);
});

test('google: gives up with a RateLimitError after the retries, escalating the waits', async () => {
  const c = clock();
  const fetchImpl = stubFetch(() => failing(429), c);
  const err = await call(['x'], googleSettings, { fetchImpl, clock: c }).catch((e) => e);

  assert.ok(err instanceof RateLimitError);
  assert.equal(err.code, 'rate_limited');
  assert.equal(err.service, 'Google Translate');
  assert.equal(err.retryInSeconds, 60);
  assert.match(err.message, /rate limiting this connection/);
  assert.equal(fetchImpl.calls.length, 3); // 1 + 2 retries
  const at = fetchImpl.calls.map((e) => e.at);
  assert.ok(at[1] - at[0] >= 2000 && at[2] - at[1] >= 5000, `waits: ${at[1] - at[0]}, ${at[2] - at[1]}`);
});

test('google: once it gave up, the breaker blocks new requests without sending anything, then re-opens', async () => {
  const c = clock();
  const fetchImpl = stubFetch(() => failing(429), c);
  await call(['x'], googleSettings, { fetchImpl, clock: c }).catch(() => {});
  const sent = fetchImpl.calls.length;

  const blocked = await call(['y'], googleSettings, { fetchImpl, clock: c }).catch((e) => e);
  assert.ok(blocked instanceof RateLimitError);
  assert.ok(blocked.retryInSeconds > 0 && blocked.retryInSeconds <= 60);
  assert.equal(fetchImpl.calls.length, sent); // nothing was sent

  c.advance(61_000);
  const ok = stubFetch(() => googleReply('fine'), c);
  assert.deepEqual(await call(['y'], googleSettings, { fetchImpl: ok, clock: c }), ['fine']);
  assert.equal(ok.calls.length, 1);
});

test('google: the breaker is per service; Microsoft keeps working while Google is blocked', async () => {
  const c = clock();
  await call(['x'], googleSettings, { fetchImpl: stubFetch(() => failing(429), c), clock: c }).catch(() => {});
  const ms = msFetch((items) => items, c);
  assert.deepEqual(await call(['hello'], msSettings, { fetchImpl: ms, clock: c }), ['hello']);
});

test('google: does not retry client errors', async () => {
  const fetchImpl = stubFetch(() => failing(400));
  await assert.rejects(call(['x'], googleSettings, { fetchImpl }), /HTTP 400/);
  assert.equal(fetchImpl.calls.length, 1);
});

test('google: reports unexpected payloads and network errors', async () => {
  await assert.rejects(
    call(['x'], googleSettings, { fetchImpl: stubFetch(() => json({ nope: true })) }),
    /Unexpected response format from Google/,
  );
  await assert.rejects(
    call(['x'], googleSettings, { fetchImpl: stubFetch(() => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } })) }),
    /invalid response/,
  );
  const down = stubFetch(() => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(call(['x'], googleSettings, { fetchImpl: down }), /Network error: Failed to fetch/);
});

// ---- microsoft (Edge translate endpoint) -------------------------------------------------

const msSettings = { engine: 'microsoft', targetLang: 'ko' };
const msEntry = (text) => ({ translations: [{ text, to: 'ko' }], detectedLanguage: { language: 'en' } });
/** `fn(items) -> array of translated strings`; the reply has the service's shape. */
function msFetch(fn, c) {
  return stubFetch((e) => json(fn(JSON.parse(e.init.body)).map(msEntry)), c);
}
const upper = (items) => items.map((t) => t.toUpperCase());

test('microsoftLanguage maps the codes the service uses', () => {
  assert.equal(microsoftLanguage('zh-CN'), 'zh-Hans');
  assert.equal(microsoftLanguage('zh-TW'), 'zh-Hant');
  assert.equal(microsoftLanguage('pt-BR'), 'pt'); // plain `pt` is Brazilian there
  assert.equal(microsoftLanguage('pt'), 'pt-PT'); // so generic Portuguese goes to European
  assert.equal(microsoftLanguage('ko'), 'ko');
});

test('microsoft: ONE post carries all texts as a JSON array; no session, no token, no cookies', async () => {
  const fetchImpl = msFetch(upper);
  const out = await call(['one', 'two', 'three'], { engine: 'microsoft', targetLang: 'zh-CN' }, { fetchImpl });

  assert.deepEqual(out, ['ONE', 'TWO', 'THREE']);
  assert.equal(fetchImpl.calls.length, 1); // nothing else is fetched first
  const [req] = fetchImpl.calls;
  const url = new URL(req.url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://edge.microsoft.com/translate/translatetext');
  assert.equal(url.searchParams.get('to'), 'zh-Hans');
  assert.equal(url.searchParams.get('isEnterpriseClient'), 'false');
  assert.equal(req.init.method, 'POST');
  assert.equal(req.init.credentials, 'omit');
  assert.equal(req.init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(req.init.body), ['one', 'two', 'three']);
  assert.equal(req.init.headers.authorization ?? req.init.headers.Authorization, undefined);
});

test('microsoft: the text goes in the body, never in the URL', async () => {
  const fetchImpl = msFetch(upper);
  await call(['secret paragraph'], msSettings, { fetchImpl });
  assert.equal(fetchImpl.calls[0].url.includes('secret'), false);
});

test('microsoft: texts keep their own newlines and need no joining trick', async () => {
  const fetchImpl = msFetch((items) => items.map((t) => `<${t}>`));
  const out = await call(['line one\nline two', 'second'], msSettings, { fetchImpl });
  assert.deepEqual(out, ['<line one\nline two>', '<second>']);
});

test('microsoft: texts are packed by item count and by characters', async () => {
  const many = Array.from({ length: 120 }, (_, i) => `t${i}`);
  const f1 = msFetch(upper);
  const out = await call(many, msSettings, { fetchImpl: f1 });
  assert.deepEqual(f1.calls.map((e) => JSON.parse(e.init.body).length), [50, 50, 20]);
  assert.deepEqual(out, many.map((t) => t.toUpperCase()));

  resetEngineState();
  const big = ['a', 'b', 'c'].map((ch) => ch.repeat(4000)); // 4000+1+4000 fits 10,000; a third does not
  const f2 = msFetch(upper);
  const out2 = await call(big, msSettings, { fetchImpl: f2 });
  assert.deepEqual(f2.calls.map((e) => JSON.parse(e.init.body).length), [2, 1]);
  assert.deepEqual(out2, big.map((t) => t.toUpperCase()));
});

test('microsoft: a text over 5000 chars is split into items, translated together and stitched back', async () => {
  const text = 'The quick brown fox jumps over the lazy dog near the river. '.repeat(250).trim(); // ~15,000 chars
  const fetchImpl = msFetch((items) => items.map((t) => `[${t}]`));
  const [out] = await call([text, 'tail'].slice(0, 1), msSettings, { fetchImpl });
  const items = fetchImpl.calls.flatMap((e) => JSON.parse(e.init.body));
  assert.ok(items.length >= 3);
  for (const item of items) assert.ok(item.length <= 5000);
  assert.equal(out.replace(/[\[\]]/g, ''), text); // nothing lost or duplicated, separators preserved
});

test('microsoft: a long text and its neighbours stay in the right slots', async () => {
  const long = 'Word '.repeat(2000).trim(); // 9999 chars -> two pieces
  const fetchImpl = msFetch(upper);
  const out = await call(['first', long, 'last'], msSettings, { fetchImpl });
  assert.equal(out[0], 'FIRST');
  assert.equal(out[1], long.toUpperCase());
  assert.equal(out[2], 'LAST');
});

test('microsoft: a reply with the wrong number of results is an error, never a silent shift', async () => {
  const short = stubFetch(() => json([msEntry('only one')]));
  await assert.rejects(call(['a', 'b'], msSettings, { fetchImpl: short }), /returned 1 results for 2 texts/);

  const notArray = stubFetch(() => json({ error: 'nope' }));
  await assert.rejects(call(['a'], msSettings, { fetchImpl: notArray }), /returned 0 results for 1 texts/);

  const noText = stubFetch(() => json([{ translations: [] }]));
  await assert.rejects(call(['a'], msSettings, { fetchImpl: noText }), /Unexpected response format from Microsoft/);
});

test('microsoft: reports an unreadable reply and a rejected request', async () => {
  const bad = stubFetch(() => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } }));
  await assert.rejects(call(['a'], msSettings, { fetchImpl: bad }), /invalid response/);
  const forbidden = stubFetch(() => failing(403));
  await assert.rejects(call(['a'], msSettings, { fetchImpl: forbidden }), /HTTP 403/);
  assert.equal(forbidden.calls.length, 1); // client errors are not retried
});

test('microsoft: a 5xx is retried', async () => {
  const replies = [failing(503), json([msEntry('ok')])];
  const fetchImpl = stubFetch(() => replies.shift());
  assert.deepEqual(await call(['a'], msSettings, { fetchImpl }), ['ok']);
  assert.equal(fetchImpl.calls.length, 2);
});

test('microsoft: requests are spaced out and a 429 makes everybody wait', async () => {
  const c = clock();
  const spaced = msFetch(upper, c);
  await call(['a'.repeat(5000), 'b'.repeat(5000), 'c'.repeat(5000)], msSettings, { fetchImpl: spaced, clock: c }); // 5000+1+5000 > 10,000: three requests
  const times = spaced.calls.map((e) => e.at);
  assert.equal(times.length, 3);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 250);

  resetEngineState();
  const c2 = clock();
  const replies = [failing(429), json([msEntry('ok')])];
  const limited = stubFetch(() => replies.shift(), c2);
  assert.deepEqual(await call(['x'], msSettings, { fetchImpl: limited, clock: c2 }), ['ok']);
  assert.ok(limited.calls[1].at - limited.calls[0].at >= 2000);
});

test('microsoft: a 429 that does not go away gives a RateLimitError naming Microsoft, then the breaker holds', async () => {
  const c = clock();
  const fetchImpl = stubFetch(() => failing(429), c);
  const err = await call(['x'], msSettings, { fetchImpl, clock: c }).catch((e) => e);
  assert.ok(err instanceof RateLimitError);
  assert.equal(err.service, 'Microsoft Translator');
  assert.equal(err.retryInSeconds, 60);
  const sent = fetchImpl.calls.length;
  await assert.rejects(call(['y'], msSettings, { fetchImpl, clock: c }), RateLimitError);
  assert.equal(fetchImpl.calls.length, sent);
});

// ---- dispatcher ---------------------------------------------------------------------------

test('openai engine still goes through the chat-completions client (batched, with the key)', async () => {
  const fetchImpl = stubFetch(() => json({ choices: [{ message: { content: '["가","나"]' } }] }));
  const settings = { engine: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-1', model: 'm', targetLang: 'ko', extraPrompt: '' };
  const out = await translate(['a', 'b'], settings, { fetchImpl });
  assert.deepEqual(out, ['가', '나']);
  assert.equal(fetchImpl.calls.length, 1); // the whole batch in one request
  assert.equal(fetchImpl.calls[0].url, 'https://api.example.com/v1/chat/completions');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer sk-1');
});
