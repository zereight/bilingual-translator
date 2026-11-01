import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../src/content/units.js', import.meta.url), 'utf8');

/** Load units.js (a classic script) into a fresh jsdom window and return its API. */
function load(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { runScripts: 'outside-only' });
  dom.window.eval(source);
  return { window: dom.window, document: dom.window.document, U: dom.window.BilingualUnits };
}

// Array.from: the units array comes from the jsdom realm; copy it into this realm for deepEqual.
const texts = (U, document, targetLang = 'ko') =>
  Array.from(U.collectUnits(document.body, { targetLang }), (u) => u.text);

test('one unit per block; inline markup is flattened into the sentence', () => {
  const { U, document } = load(`
    <h1>Hello World Title</h1>
    <p>First <b>bold</b> paragraph with <a href="#">a link</a>.</p>
    <ul><li>Item one text</li><li>Item two text</li></ul>
  `);
  assert.deepEqual(texts(U, document), [
    'Hello World Title',
    'First bold paragraph with a link.',
    'Item one text',
    'Item two text',
  ]);
});

test('text mixed with block children is split into separate runs', () => {
  const { U, document } = load('<div>Intro text here <p>Inner paragraph here</p> Outro text here</div>');
  assert.deepEqual(texts(U, document), ['Intro text here', 'Inner paragraph here', 'Outro text here']);
});

test('block content inside an inline wrapper (card links) stays separate', () => {
  const { U, document } = load('<a href="#"><div>Card title text</div><div>Card description text</div></a>');
  assert.deepEqual(texts(U, document), ['Card title text', 'Card description text']);
});

test('skips code blocks, scripts, buttons, inputs and hidden content', () => {
  const { U, document } = load(`
    <pre>code block here</pre>
    <script>var x = "not translated";</script>
    <style>p { color: red }</style>
    <button>Click this button</button>
    <textarea>some textarea words</textarea>
    <div style="display:none"><p>Hidden paragraph text</p></div>
    <div style="visibility:hidden"><p>Invisible paragraph text</p></div>
    <p>Visible paragraph text</p>
  `);
  assert.deepEqual(texts(U, document), ['Visible paragraph text']);
});

test('honours translate="no", .notranslate, aria-hidden and contenteditable', () => {
  const { U, document } = load(`
    <p translate="no">Do not translate me</p>
    <p class="notranslate">Nor me please</p>
    <p aria-hidden="true">Decorative duplicate</p>
    <div contenteditable="true">Editable area text</div>
    <p>Translate this one</p>
  `);
  assert.deepEqual(texts(U, document), ['Translate this one']);
});

test('inline <code> stays part of the sentence', () => {
  const { U, document } = load('<p>Run <code>npm install</code> to begin.</p>');
  assert.deepEqual(texts(U, document), ['Run npm install to begin.']);
});

test('skips text that is already in the target language', () => {
  const { U, document } = load('<p>이미 한국어로 된 문단입니다.</p><p>This needs translating</p>');
  assert.deepEqual(texts(U, document, 'ko'), ['This needs translating']);
  assert.deepEqual(texts(U, document, 'en'), ['이미 한국어로 된 문단입니다.', 'This needs translating']);
});

test('skips elements whose lang already matches the target (but not the scan root)', () => {
  const { U, document } = load('<p lang="ko-KR">Labelled Korean</p><p lang="en">Labelled English</p>');
  assert.deepEqual(texts(U, document, 'ko'), ['Labelled English']);
});

test('our own <bt-translation> closes the run before it and is never read as text', () => {
  const { U, document } = load('<p id="p">Original sentence<bt-translation>번역문</bt-translation> and later text</p>');
  assert.deepEqual(texts(U, document), ['Original sentence', 'and later text']);
});

test('units point at the last node so the translation can be inserted after it', () => {
  const { U, document } = load('<p id="p">Hello <b>big</b> world</p>');
  const [unit] = U.collectUnits(document.body, { targetLang: 'ko' });
  assert.equal(unit.last.textContent, ' world');
  assert.equal(unit.last.parentNode.id, 'p');
});

test('isTranslatable', () => {
  const { U } = load('');
  const t = (s, lang = 'ko') => U.isTranslatable(s, lang);
  assert.equal(t('Hello there'), true);
  assert.equal(t('a'), false);
  assert.equal(t('12345'), false);
  assert.equal(t('$ 9.99 !!'), false);
  assert.equal(t('https://example.com/path'), false);
  assert.equal(t('someone@example.com'), false);
  assert.equal(t('한국어 문장입니다'), false);
  assert.equal(t('한국어로 작성된 긴 문장입니다 OK'), false); // mostly Korean with a stray Latin word
  assert.equal(t('한국어 문장 with a few English words'), true); // mostly English
  assert.equal(t('English with 한글'), true);
  assert.equal(t('これは日本語です', 'ja'), false);
  assert.equal(t('这是中文', 'ja'), true); // Han only: Chinese, not Japanese
  assert.equal(t('这是中文', 'zh-CN'), false);
  assert.equal(t('Это русский текст', 'ru'), false);
  assert.equal(t('Hello there', 'en'), true); // Latin targets rely on the model returning text unchanged
});

test('normalize collapses whitespace', () => {
  const { U } = load('');
  assert.equal(U.normalize('  a \n\t b  '), 'a b');
});
