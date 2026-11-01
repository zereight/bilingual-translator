// End-to-end check in a real Chrome: loads dist/chrome as an extension, points it at a mock
// OpenAI-compatible server and verifies the bilingual rendering on a local test page.
//
//   npm run build && npm run e2e
//   CHROME_PATH=/path/to/chrome npm run e2e     (if Chrome is not auto-detected)

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

// ---- mock OpenAI-compatible server + test page ----------------------------------------------
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test</title></head><body>
<h1>Welcome to the test page</h1>
<p id="p1">This is the <b>first</b> paragraph with a <a href="#">link</a>.</p>
<p>이미 한국어로 작성된 문단입니다.</p>
<pre>const doNotTranslate = true;</pre>
<ul><li>First list item</li><li>Second list item</li></ul>
<div style="height:6000px"></div>
<p id="far">This paragraph is far below the fold.</p>
</body></html>`;

const requests = [];
let failWithStatus = 0;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/page.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const texts = JSON.parse(parsed.messages[1].content);
      requests.push({ auth: req.headers.authorization, model: parsed.model, texts });
      if (failWithStatus) {
        res.writeHead(failWithStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
        return;
      }
      const out = texts.map((t) => `[KO] ${t}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// ---- browser --------------------------------------------------------------------------------
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  pipe: true,
  enableExtensions: true,
});

let failed = false;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed = true;
    console.log(`  FAIL ${name}\n       ${String(err?.stack || err).split('\n').slice(0, 4).join('\n       ')}`);
  }
};

try {
  const extensionId = await browser.installExtension(distChrome);
  const workerTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().includes(extensionId),
  );
  const worker = await workerTarget.worker();

  const setSettings = (settings) =>
    worker.evaluate((s) => chrome.storage.local.set({ settings: s }), settings);
  const sendToPage = (message) =>
    worker.evaluate(
      async (url, msg) => {
        const [tab] = await chrome.tabs.query({ url });
        return chrome.tabs.sendMessage(tab.id, msg);
      },
      `${origin}/*`,
      message,
    );

  await setSettings({ baseUrl: `${origin}/v1`, apiKey: 'test-key', model: 'mock-model', targetLang: 'ko', style: 'subtle' });

  const page = await browser.newPage();
  await page.goto(`${origin}/page.html`, { waitUntil: 'load' });
  // content script is injected at document_idle
  await page.waitForFunction(() => document.readyState === 'complete');
  await new Promise((r) => setTimeout(r, 300));

  const doneTexts = () =>
    page.$$eval('bt-translation[data-bt-state="done"]', (els) => els.map((e) => e.textContent));

  console.log('Chrome end-to-end');

  await step('toggle on: visible paragraphs get a translation below them', async () => {
    const state = await sendToPage({ type: 'toggle' });
    assert.equal(state.enabled, true);
    await page.waitForFunction(
      () => document.querySelectorAll('bt-translation[data-bt-state="done"]').length >= 4,
      { timeout: 10000 },
    );
    const texts = await doneTexts();
    assert.ok(texts.includes('[KO] Welcome to the test page'), JSON.stringify(texts));
    assert.ok(texts.includes('[KO] This is the first paragraph with a link.'), JSON.stringify(texts));
    assert.ok(texts.includes('[KO] First list item'));
    assert.ok(texts.includes('[KO] Second list item'));
  });

  await step('translation sits directly after the original paragraph; original is untouched', async () => {
    const info = await page.$eval('#p1', (p) => ({
      html: p.innerHTML,
      next: p.lastElementChild?.tagName,
      after: p.lastElementChild?.textContent,
    }));
    assert.equal(info.next, 'BT-TRANSLATION');
    assert.equal(info.after, '[KO] This is the first paragraph with a link.');
    assert.match(info.html, /<b>first<\/b>/);
    assert.match(info.html, /<a href="#">link<\/a>/);
  });

  await step('Korean text, <pre> and untranslated areas are skipped; API key + model are sent', async () => {
    const all = requests.flatMap((r) => r.texts);
    assert.ok(!all.some((t) => t.includes('한국어')), 'Korean text was sent');
    assert.ok(!all.some((t) => t.includes('doNotTranslate')), '<pre> was sent');
    assert.ok(requests.every((r) => r.auth === 'Bearer test-key' && r.model === 'mock-model'));
    assert.equal(
      await page.$$eval('bt-translation', (els) => els.some((e) => e.previousSibling?.textContent?.includes('한국어'))),
      false,
    );
  });

  await step('lazy: far-below paragraph is not requested until scrolled into range', async () => {
    assert.ok(!requests.flatMap((r) => r.texts).includes('This paragraph is far below the fold.'));
    await page.evaluate(() => document.getElementById('far').scrollIntoView());
    await page.waitForFunction(
      () => document.querySelector('#far > bt-translation[data-bt-state="done"], #far + bt-translation[data-bt-state="done"]'),
      { timeout: 10000 },
    );
    assert.ok(requests.flatMap((r) => r.texts).includes('This paragraph is far below the fold.'));
  });

  await step('dynamic content added later is translated', async () => {
    await page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'dyn';
      p.textContent = 'Late arriving paragraph';
      document.getElementById('far').after(p);
    });
    await page.waitForFunction(
      () => document.querySelector('#dyn > bt-translation[data-bt-state="done"]'),
      { timeout: 10000 },
    );
    assert.equal(await page.$eval('#dyn > bt-translation', (e) => e.textContent), '[KO] Late arriving paragraph');
  });

  await step('no duplicate translations after re-scans', async () => {
    const dup = await page.$$eval('bt-translation', (els) =>
      els.filter((e) => e.nextElementSibling?.localName === 'bt-translation').length,
    );
    assert.equal(dup, 0);
  });

  await step('toggle off removes every inserted element', async () => {
    const state = await sendToPage({ type: 'toggle' });
    assert.equal(state.enabled, false);
    assert.equal(await page.$$eval('bt-translation, bt-toast', (els) => els.length), 0);
  });

  await step('API errors show a toast and clickable error placeholders (no request storm)', async () => {
    // The background script caches translations per (model, language, text): use a fresh model
    // name so these texts are not served from the cache and really hit the failing API.
    await setSettings({ baseUrl: `${origin}/v1`, apiKey: 'test-key', model: 'mock-model-errors', targetLang: 'ko' });
    failWithStatus = 401;
    requests.length = 0;
    await page.evaluate(() => window.scrollTo(0, 0));
    await sendToPage({ type: 'toggle' });
    await page.waitForSelector('bt-toast', { timeout: 10000 });
    const toast = await page.$eval('bt-toast', (e) => e.textContent);
    assert.match(toast, /HTTP 401: Incorrect API key provided/);
    assert.ok(!toast.includes('test-key'));
    await page.waitForSelector('bt-translation[data-bt-state="error"]');
    assert.ok(requests.length <= 3, `expected the circuit breaker to stop requests, got ${requests.length}`);

    // fix the backend, click an error placeholder -> it retries and succeeds
    failWithStatus = 0;
    await page.click('bt-translation[data-bt-state="error"]');
    await page.waitForSelector('bt-translation[data-bt-state="done"]', { timeout: 10000 });
    await sendToPage({ type: 'toggle' });
  });

  await step('auto-translate domain starts translating on load', async () => {
    await setSettings({ baseUrl: `${origin}/v1`, apiKey: 'test-key', model: 'mock-model', targetLang: 'ko', autoDomains: ['127.0.0.1'] });
    const auto = await browser.newPage();
    await auto.goto(`${origin}/page.html`, { waitUntil: 'load' });
    await auto.waitForFunction(
      () => document.querySelectorAll('bt-translation[data-bt-state="done"]').length >= 4,
      { timeout: 10000 },
    );
    await auto.close();
  });

  await step('popup renders localized UI and reports page state', async () => {
    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popup.waitForSelector('#lang option');
    const label = await popup.$eval('#toggle', (b) => b.textContent);
    assert.ok(label.length > 0 && !label.startsWith('popup'), label);
    assert.ok((await popup.$$eval('#lang option', (o) => o.length)) > 20);
    await popup.close();
  });

  await step('options page: load, save and "test connection" against the mock server', async () => {
    await setSettings({ baseUrl: `${origin}/v1`, apiKey: 'test-key', model: 'mock-model', targetLang: 'ko' });
    const opts = await browser.newPage();
    await opts.goto(`chrome-extension://${extensionId}/options/options.html`);
    await opts.waitForFunction(() => document.getElementById('model').value === 'mock-model');
    await opts.$eval('#targetLang', (s) => { s.value = 'ja'; });
    await opts.click('button[type=submit]');
    await opts.waitForFunction(() => document.getElementById('status').textContent.length > 0);
    const saved = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
    assert.equal(saved.targetLang, 'ja');
    assert.equal(saved.apiKey, 'test-key');

    await opts.click('#test');
    await opts.waitForFunction(() => document.getElementById('status').classList.contains('ok'), { timeout: 10000 });
    assert.match(await opts.$eval('#status', (s) => s.textContent), /\[KO\] Hello, world!/);
    await opts.close();
  });
} finally {
  await browser.close();
  server.close();
}

if (failed) {
  console.log('\nEnd-to-end FAILED');
  process.exit(1);
}
console.log('\nEnd-to-end passed');
