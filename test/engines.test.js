import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  bingLanguage,
  isPerTextEngine,
  parseBingPage,
  resetBingSession,
  splitText,
  translate,
} from '../src/lib/engines.js';

const noSleep = async () => {};
beforeEach(() => resetBingSession());

const json = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
const html = (body) => ({ ok: true, status: 200, text: async () => body });
const failing = (status) => ({ ok: false, status, json: async () => ({}), text: async () => '' });

/** A fetch stub that records every call and answers with whatever `handler(url, init)` returns. */
function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url: String(url), init, form: init.body ? new URLSearchParams(String(init.body)) : null };
    calls.push(call);
    return handler(call);
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

// ---- google -------------------------------------------------------------------------------

const googleSettings = { engine: 'google', targetLang: 'ko' };
const googleReply = (...sentences) => json([sentences.map((s) => [s, 'orig', null, null, 3]), null, 'en']);

test('google: posts the text as a form body (not in the URL) and joins the sentence segments', async () => {
  const fetchImpl = stubFetch(() => googleReply('안녕, 세상! ', '이것은 테스트입니다.'));
  const out = await translate(['Hello, world! This is a test.'], googleSettings, { fetchImpl });

  assert.deepEqual(out, ['안녕, 세상! 이것은 테스트입니다.']);
  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'https://translate.googleapis.com/translate_a/single');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.credentials, 'omit');
  assert.equal(call.form.get('q'), 'Hello, world! This is a test.');
  assert.equal(call.form.get('tl'), 'ko');
  assert.equal(call.form.get('sl'), 'auto');
  assert.equal(call.form.get('client'), 'gtx');
  assert.equal(call.url.includes('Hello'), false);
});

test('google: one request per text, results keep their order', async () => {
  const fetchImpl = stubFetch((c) => googleReply(`[${c.form.get('q')}]`));
  const out = await translate(['a', 'b', 'c'], googleSettings, { fetchImpl });
  assert.deepEqual(out, ['[a]', '[b]', '[c]']);
  assert.equal(fetchImpl.calls.length, 3);
});

test('google: texts longer than the limit are split, translated piece by piece and stitched together', async () => {
  const sentence = 'The quick brown fox jumps over the lazy dog. ';
  const text = sentence.repeat(120).trim(); // ~5400 chars
  const fetchImpl = stubFetch((c) => googleReply(c.form.get('q').toUpperCase()));
  const [out] = await translate([text], googleSettings, { fetchImpl });

  assert.ok(fetchImpl.calls.length >= 2);
  for (const c of fetchImpl.calls) assert.ok(c.form.get('q').length <= 4000);
  assert.equal(out, text.toUpperCase()); // nothing lost, nothing duplicated, separators preserved
});

test('google: retries 429 and 5xx, then succeeds', async () => {
  const replies = [failing(429), failing(503), googleReply('ok')];
  const fetchImpl = stubFetch(() => replies.shift());
  const out = await translate(['x'], googleSettings, { fetchImpl, sleep: noSleep });
  assert.deepEqual(out, ['ok']);
  assert.equal(fetchImpl.calls.length, 3);
});

test('google: gives up with a helpful message when rate limited', async () => {
  const fetchImpl = stubFetch(() => failing(429));
  await assert.rejects(translate(['x'], googleSettings, { fetchImpl, sleep: noSleep }), /HTTP 429.*too many requests/);
  assert.equal(fetchImpl.calls.length, 3); // 1 + 2 retries
});

test('google: does not retry client errors', async () => {
  const fetchImpl = stubFetch(() => failing(400));
  await assert.rejects(translate(['x'], googleSettings, { fetchImpl, sleep: noSleep }), /HTTP 400/);
  assert.equal(fetchImpl.calls.length, 1);
});

test('google: reports unexpected payloads and network errors', async () => {
  await assert.rejects(
    translate(['x'], googleSettings, { fetchImpl: stubFetch(() => json({ nope: true })) }),
    /Unexpected response format from Google/,
  );
  await assert.rejects(
    translate(['x'], googleSettings, { fetchImpl: stubFetch(() => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } })) }),
    /invalid response/,
  );
  const down = stubFetch(() => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(translate(['x'], googleSettings, { fetchImpl: down, sleep: noSleep }), /Network error: Failed to fetch/);
});

// ---- microsoft (Bing) ---------------------------------------------------------------------

const BING_PAGE_HTML = `<html><script>var _G={IG:"ABC123DEF456"};
var params_AbusePreventionHelper = [1793542621616,"tok-en_1",3600000];</script></html>`;
const bingSettings = { engine: 'microsoft', targetLang: 'ko' };
const bingReply = (text) => json([{ translations: [{ text, to: 'ko' }], detectedLanguage: { language: 'en' } }]);

/** Routes the page request and the translate request; `onTranslate` decides the translate reply. */
function bingFetch(onTranslate, page = BING_PAGE_HTML) {
  return stubFetch((c) => (c.url.startsWith('https://www.bing.com/translator') ? html(page) : onTranslate(c)));
}

test('parseBingPage extracts IG and the abuse-prevention token', () => {
  assert.deepEqual(parseBingPage(BING_PAGE_HTML), { ig: 'ABC123DEF456', key: '1793542621616', token: 'tok-en_1' });
  assert.equal(parseBingPage('<html>layout changed</html>'), null);
});

test('bingLanguage maps the codes the web UI uses', () => {
  assert.equal(bingLanguage('zh-CN'), 'zh-Hans');
  assert.equal(bingLanguage('zh-TW'), 'zh-Hant');
  assert.equal(bingLanguage('pt-BR'), 'pt');
  assert.equal(bingLanguage('pt'), 'pt-pt');
  assert.equal(bingLanguage('ko'), 'ko');
});

test('microsoft: loads a session once, then posts the text with token, key and mapped language', async () => {
  const fetchImpl = bingFetch((c) => bingReply(`<${c.form.get('text')}>`));
  const out = await translate(['one', 'two'], { engine: 'microsoft', targetLang: 'zh-CN' }, { fetchImpl });

  assert.deepEqual(out, ['<one>', '<two>']);
  const pages = fetchImpl.calls.filter((c) => c.url.startsWith('https://www.bing.com/translator'));
  const posts = fetchImpl.calls.filter((c) => c.url.startsWith('https://www.bing.com/ttranslatev3'));
  assert.equal(pages.length, 1); // session is cached
  assert.equal(posts.length, 2);
  assert.match(posts[0].url, /IG=ABC123DEF456/);
  assert.equal(posts[0].init.credentials, 'omit');
  assert.equal(posts[0].form.get('token'), 'tok-en_1');
  assert.equal(posts[0].form.get('key'), '1793542621616');
  assert.equal(posts[0].form.get('to'), 'zh-Hans');
  assert.equal(posts[0].form.get('fromLang'), 'auto-detect');
});

test('microsoft: concurrent first requests share one session load', async () => {
  const fetchImpl = bingFetch((c) => bingReply(c.form.get('text')));
  await Promise.all(['a', 'b', 'c'].map((t) => translate([t], bingSettings, { fetchImpl })));
  assert.equal(fetchImpl.calls.filter((c) => c.url.startsWith('https://www.bing.com/translator')).length, 1);
});

test('microsoft: an expired token (statusCode 205) triggers one session refresh and a retry', async () => {
  let pageLoads = 0;
  const fetchImpl = stubFetch((c) => {
    if (c.url.startsWith('https://www.bing.com/translator')) {
      pageLoads++;
      return html(BING_PAGE_HTML.replace('tok-en_1', `tok-en_${pageLoads}`));
    }
    return c.form.get('token') === 'tok-en_2' ? bingReply('fresh') : json({ statusCode: 205, errorMessage: '' });
  });
  const out = await translate(['x'], bingSettings, { fetchImpl });
  assert.deepEqual(out, ['fresh']);
  assert.equal(pageLoads, 2);
});

test('microsoft: texts over 900 chars are split (the endpoint rejects more than 1000)', async () => {
  const text = 'The quick brown fox jumps over the lazy dog near the river. '.repeat(40).trim(); // ~2400 chars
  const fetchImpl = bingFetch((c) => bingReply(c.form.get('text')));
  const [out] = await translate([text], bingSettings, { fetchImpl });
  const posts = fetchImpl.calls.filter((c) => c.url.startsWith('https://www.bing.com/ttranslatev3'));
  assert.ok(posts.length >= 3);
  for (const p of posts) assert.ok(p.form.get('text').length <= 900);
  assert.equal(out, text);
});

test('microsoft: surfaces error codes and captcha, and gives up after one refresh', async () => {
  const bad = bingFetch(() => json({ statusCode: 400, errorMessage: '' }));
  await assert.rejects(translate(['x'], bingSettings, { fetchImpl: bad }), /rejected the request \(code 400\)/);

  resetBingSession();
  const expired = bingFetch(() => json({ statusCode: 205, errorMessage: '' }));
  await assert.rejects(translate(['x'], bingSettings, { fetchImpl: expired }), /rejected the request \(code 205\)/);
  assert.equal(expired.calls.filter((c) => c.url.startsWith('https://www.bing.com/translator')).length, 2); // initial + one refresh

  resetBingSession();
  const captcha = bingFetch(() => json({ ShowCaptcha: true }));
  await assert.rejects(translate(['x'], bingSettings, { fetchImpl: captcha }), /captcha required/);
});

test('microsoft: explains when the page layout changed', async () => {
  const fetchImpl = bingFetch(() => bingReply('unused'), '<html>something else</html>');
  await assert.rejects(translate(['x'], bingSettings, { fetchImpl }), /Could not start a Microsoft Translator session/);
});

// ---- dispatcher ---------------------------------------------------------------------------

test('isPerTextEngine', () => {
  assert.equal(isPerTextEngine('google'), true);
  assert.equal(isPerTextEngine('microsoft'), true);
  assert.equal(isPerTextEngine('openai'), false);
});

test('openai engine still goes through the chat-completions client (batched, with the key)', async () => {
  const fetchImpl = stubFetch(() => json({ choices: [{ message: { content: '["가","나"]' } }] }));
  const settings = { engine: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-1', model: 'm', targetLang: 'ko', extraPrompt: '' };
  const out = await translate(['a', 'b'], settings, { fetchImpl });
  assert.deepEqual(out, ['가', '나']);
  assert.equal(fetchImpl.calls.length, 1); // the whole batch in one request
  assert.equal(fetchImpl.calls[0].url, 'https://api.example.com/v1/chat/completions');
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer sk-1');
});
