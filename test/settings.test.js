import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  ENGINES,
  hostMatches,
  isConfigured,
  normalizeDomain,
  publicSettings,
  sanitize,
} from '../src/lib/settings.js';

test('sanitize fills defaults for missing/garbage input', () => {
  assert.deepEqual(sanitize(undefined), { ...DEFAULTS, autoDomains: [] });
  assert.deepEqual(sanitize('nope'), { ...DEFAULTS, autoDomains: [] });
});

test('sanitize trims, clamps and validates', () => {
  const s = sanitize({
    baseUrl: '  http://localhost:11434/v1///  ',
    apiKey: '  k  ',
    model: '   ',
    targetLang: 'xx',
    style: 'weird',
    batchMaxItems: '999',
    batchMaxChars: '5',
    concurrency: 'abc',
  });
  assert.equal(s.baseUrl, 'http://localhost:11434/v1');
  assert.equal(s.apiKey, 'k');
  assert.equal(s.model, DEFAULTS.model);
  assert.equal(s.targetLang, DEFAULTS.targetLang);
  assert.equal(s.style, DEFAULTS.style);
  assert.equal(s.batchMaxItems, 30);
  assert.equal(s.batchMaxChars, 200);
  assert.equal(s.concurrency, DEFAULTS.concurrency);
});

test('sanitize rejects non-http base URLs', () => {
  assert.equal(sanitize({ baseUrl: 'javascript:alert(1)' }).baseUrl, DEFAULTS.baseUrl);
  assert.equal(sanitize({ baseUrl: 'ftp://x.test' }).baseUrl, DEFAULTS.baseUrl);
});

test('normalizeDomain', () => {
  assert.equal(normalizeDomain('https://www.Example.com:8080/a/b?c#d'), 'example.com');
  assert.equal(normalizeDomain('news.ycombinator.com'), 'news.ycombinator.com');
  assert.equal(normalizeDomain('  '), '');
  assert.equal(normalizeDomain('exa mple.com'), '');
  assert.equal(normalizeDomain('<script>'), '');
});

test('autoDomains accepts a textarea string and dedupes', () => {
  const s = sanitize({ autoDomains: 'a.com\nhttps://www.a.com/x, b.org\n\n' });
  assert.deepEqual(s.autoDomains, ['a.com', 'b.org']);
});

test('hostMatches covers subdomains but not look-alikes', () => {
  assert.equal(hostMatches('a.com', ['a.com']), true);
  assert.equal(hostMatches('sub.a.com', ['a.com']), true);
  assert.equal(hostMatches('nota.com', ['a.com']), false);
  assert.equal(hostMatches('a.com.evil.test', ['a.com']), false);
  assert.equal(hostMatches('a.com', []), false);
});

test('isConfigured: official OpenAI needs a key, local servers do not', () => {
  assert.equal(isConfigured({ baseUrl: 'https://api.openai.com/v1', apiKey: '' }), false);
  assert.equal(isConfigured({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1' }), true);
  assert.equal(isConfigured({ baseUrl: 'http://localhost:11434/v1', apiKey: '' }), true);
});

test('publicSettings never exposes the API key', () => {
  const pub = publicSettings({ ...DEFAULTS, apiKey: 'sk-secret' });
  assert.equal('apiKey' in pub, false);
  assert.equal(JSON.stringify(pub).includes('sk-secret'), false);
  assert.equal(pub.configured, true);
});

test('engine defaults to google (works without any setup) and rejects unknown values', () => {
  assert.equal(DEFAULTS.engine, 'google');
  assert.deepEqual(ENGINES, ['google', 'microsoft', 'openai']);
  assert.equal(sanitize({}).engine, 'google');
  assert.equal(sanitize({ engine: 'microsoft' }).engine, 'microsoft');
  assert.equal(sanitize({ engine: 'openai' }).engine, 'openai');
  assert.equal(sanitize({ engine: 'bing' }).engine, 'google');
  assert.equal(sanitize({ engine: 42 }).engine, 'google');
});

test('settings saved before engines existed keep using the OpenAI-compatible API', () => {
  assert.equal(sanitize({ apiKey: 'sk-1' }).engine, 'openai');
  assert.equal(sanitize({ baseUrl: 'http://localhost:11434/v1' }).engine, 'openai');
  assert.equal(sanitize({ baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'qwen2.5:7b' }).engine, 'openai');
  // untouched defaults carry no OpenAI configuration -> the key-less default engine
  assert.equal(sanitize({ baseUrl: DEFAULTS.baseUrl, apiKey: '', model: DEFAULTS.model }).engine, 'google');
});

test('an explicit engine always wins over leftover OpenAI fields', () => {
  assert.equal(sanitize({ engine: 'google', apiKey: 'sk-1', baseUrl: 'http://localhost:11434/v1' }).engine, 'google');
  assert.equal(sanitize({ engine: 'microsoft', apiKey: 'sk-1' }).engine, 'microsoft');
});

test('isConfigured: google and microsoft need no key, whatever the OpenAI fields say', () => {
  for (const engine of ['google', 'microsoft']) {
    assert.equal(isConfigured({ engine, baseUrl: 'https://api.openai.com/v1', apiKey: '' }), true);
  }
  assert.equal(isConfigured({ engine: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '' }), false);
  assert.equal(isConfigured({ engine: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-1' }), true);
  assert.equal(isConfigured({ engine: 'openai', baseUrl: 'http://localhost:11434/v1', apiKey: '' }), true);
});

test('publicSettings exposes the engine but still never the key', () => {
  const pub = publicSettings({ ...DEFAULTS, engine: 'microsoft', apiKey: 'sk-secret' });
  assert.equal(pub.engine, 'microsoft');
  assert.equal(pub.configured, true);
  assert.equal(JSON.stringify(pub).includes('sk-secret'), false);
});
