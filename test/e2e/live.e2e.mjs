// LIVE end-to-end check of the key-less engines (google, microsoft) in a real Chrome.
//
// Unlike chrome.e2e.mjs this talks to the real Google / Microsoft web endpoints, so it needs network
// access and is NOT part of `npm test`. Those endpoints are unofficial and can change or stop working
// at any time; run this when translation suddenly fails to find out whether the service or the code broke.
//
//   npm run build && npm run e2e:live
//   CHROME_PATH=/path/to/chrome npm run e2e:live     (if Chrome is not auto-detected)
//   LIVE_ENGINES=microsoft npm run e2e:live          (only some engines, e.g. while Google is rate limiting you)
//
// Only harmless sample sentences are sent. Do not loop this: the services throttle by connection.

import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const distChrome = path.join(root, 'dist/chrome');

const chromePath =
  process.env.CHROME_PATH ||
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].find(existsSync);
assert.ok(chromePath, 'Chrome not found. Set CHROME_PATH.');
assert.ok(existsSync(path.join(distChrome, 'manifest.json')), 'Run `npm run build` first.');

// ~1500 characters in one paragraph: longer than Microsoft's 1000-char request limit, so it is split.
const LONG = [
  'Small habits are easy to start and hard to abandon, which is exactly why they work.',
  'A glass of water in the morning, ten minutes of reading at night, a short walk after lunch.',
  'None of these changes your life on its own, but together they shape how every day feels.',
  'People often wait for motivation before they begin, yet motivation usually arrives after the first step.',
  'Start with something so small that skipping it would feel silly, and let the routine grow naturally.',
  'When a day goes badly, do the smallest version of the habit instead of nothing at all.',
  'Over a few months the effort fades into the background and the results quietly pile up.',
  'The trick is to be patient with progress and generous with yourself when you slip.',
].join(' ').repeat(2);

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Live test</title></head><body>
<h1>Welcome to the test page</h1>
<p id="short">This is the first paragraph with a link.</p>
<p id="long">${LONG}</p>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/page.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
  } else {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const only = process.env.LIVE_ENGINES?.split(',').map((e) => e.trim()).filter(Boolean);
const CASES = [
  { engine: 'google', targetLang: 'ko', script: /[\uac00-\ud7a3]/ },
  { engine: 'microsoft', targetLang: 'ko', script: /[\uac00-\ud7a3]/ },
  { engine: 'microsoft', targetLang: 'zh-CN', script: /[\u4e00-\u9fff]/ }, // exercises the zh-CN -> zh-Hans mapping
].filter((c) => !only || only.includes(c.engine));
assert.ok(CASES.length > 0, `LIVE_ENGINES=${process.env.LIVE_ENGINES} matches no engine (google, microsoft)`);

const browser = await puppeteer.launch({ executablePath: chromePath, headless: true, pipe: true, enableExtensions: true });
let failed = false;

try {
  const extensionId = await browser.installExtension(distChrome);
  const workerTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes(extensionId));
  const worker = await workerTarget.worker();

  const setSettings = (settings) => worker.evaluate((s) => chrome.storage.local.set({ settings: s }), settings);
  const sendToPage = (message) =>
    worker.evaluate(
      async (url, msg) => {
        const [tab] = await chrome.tabs.query({ url });
        return chrome.tabs.sendMessage(tab.id, msg);
      },
      `${origin}/*`,
      message,
    );

  const page = await browser.newPage();
  console.log('Live engines (real Google / Microsoft endpoints)');

  for (const { engine, targetLang, script } of CASES) {
    const label = `${engine} -> ${targetLang}`;
    try {
      await setSettings({ engine, targetLang, style: 'subtle' });
      await page.goto(`${origin}/page.html`, { waitUntil: 'load' }); // fresh content script per case
      await new Promise((r) => setTimeout(r, 300));

      const state = await sendToPage({ type: 'toggle' });
      assert.equal(state.enabled, true);

      await page.waitForFunction(
        () => {
          const done = document.querySelectorAll('bt-translation[data-bt-state="done"]').length;
          const error = document.querySelectorAll('bt-translation[data-bt-state="error"]').length;
          return done >= 3 || error > 0;
        },
        { timeout: 45000 },
      );

      const result = await page.evaluate(() => ({
        done: [...document.querySelectorAll('bt-translation[data-bt-state="done"]')].map((e) => e.textContent),
        errors: document.querySelectorAll('bt-translation[data-bt-state="error"]').length,
        toast: document.querySelector('bt-toast')?.textContent ?? '',
      }));
      assert.equal(result.errors, 0, `translation failed: ${result.toast}`);
      assert.equal(result.done.length, 3, JSON.stringify(result.done));
      for (const text of result.done) assert.match(text, script, `not translated: ${text.slice(0, 80)}`);

      const longest = result.done.reduce((a, b) => (b.length > a.length ? b : a), '');
      assert.ok(longest.length > 300, `long paragraph came back suspiciously short (${longest.length} chars)`);

      console.log(`  ok   ${label}  (${result.done[0]} | long paragraph: ${longest.length} chars)`);
      await sendToPage({ type: 'toggle' }); // back to original
    } catch (err) {
      failed = true;
      console.log(`  FAIL ${label}\n       ${String(err?.message || err).split('\n').slice(0, 3).join('\n       ')}`);
    }
  }
} finally {
  await browser.close();
  server.close();
}

if (failed) {
  console.log('\nSome engines failed. If the unit tests pass, the service has probably changed its endpoint or is rate limiting you.');
  process.exit(1);
}
console.log('\nAll live checks passed.');
