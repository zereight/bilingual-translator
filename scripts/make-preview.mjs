// Renders assets/preview/preview.html to assets/preview.png (the README hero image) with a real Chrome.
// The page uses the extension's actual content.css, so the translation styling matches what users see.
//
// Usage: npm run preview        (needs `npm install` and Chrome; set CHROME_PATH if not auto-detected)

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'assets/preview/preview.html');
const target = path.join(root, 'assets/preview.png');

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
if (!chromePath) throw new Error('Chrome not found. Set CHROME_PATH.');

const browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800, deviceScaleFactor: 2 });
  await page.goto(pathToFileURL(source).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const stage = await page.$('#stage');
  await stage.screenshot({ path: target, type: 'png' });
  console.log('wrote assets/preview.png');
} finally {
  await browser.close();
}
