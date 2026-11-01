import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
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
