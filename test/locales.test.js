import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/_locales');
const locales = Object.fromEntries(
  readdirSync(dir).map((lang) => [lang, JSON.parse(readFileSync(path.join(dir, lang, 'messages.json'), 'utf8'))]),
);

test('every locale has exactly the same message keys', () => {
  const [first, ...others] = Object.entries(locales);
  assert.ok(others.length >= 1, 'expected at least two locales');
  for (const [lang, messages] of others) {
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(first[1]).sort(), `${lang} differs from ${first[0]}`);
  }
});

test('placeholders used in a message are declared, with the same names in every locale', () => {
  for (const [lang, messages] of Object.entries(locales)) {
    for (const [key, entry] of Object.entries(messages)) {
      const used = [...entry.message.matchAll(/\$([A-Z_][A-Z0-9_]*)\$/g)].map((m) => m[1].toLowerCase());
      const declared = Object.keys(entry.placeholders ?? {});
      assert.deepEqual([...new Set(used)].sort(), declared.sort(), `${lang}:${key}`);
    }
  }
});

test('the rate-limit message takes the service name and the wait in seconds', () => {
  for (const [lang, messages] of Object.entries(locales)) {
    const entry = messages.errRateLimited;
    assert.ok(entry, `${lang} is missing errRateLimited`);
    assert.equal(entry.placeholders.service.content, '$1');
    assert.equal(entry.placeholders.seconds.content, '$2');
    assert.match(entry.message, /\$SERVICE\$/);
    assert.match(entry.message, /\$SECONDS\$/);
  }
});
