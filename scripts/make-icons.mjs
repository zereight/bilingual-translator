// Renders the logo (assets/*.svg) to PNG with a real Chrome, via puppeteer-core:
//   src/icons/icon-{16,32,48,128}.png   toolbar / store icons
//   assets/logo.png                     512px, for store listings and the README
//
// logo.svg is the full design; logo-small.svg is a simplified variant (heavier strokes, bigger
// bubbles) that stays readable at 16-32px, so it is used for sizes <= SMALL_MAX.
//
// Usage: npm run icons        (needs `npm install` and Chrome; set CHROME_PATH if not auto-detected)

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.join(root, 'assets');
const iconsDir = path.join(root, 'src/icons');
const SMALL_MAX = 32;

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

const [full, small] = await Promise.all(
  ['logo.svg', 'logo-small.svg'].map((f) => readFile(path.join(assetsDir, f), 'utf8')),
);

const browser = await puppeteer.launch({ executablePath: chromePath, headless: true });
try {
  const page = await browser.newPage();

  // Rasterises the SVG at exactly size x size CSS px (deviceScaleFactor 1) on a transparent background.
  async function render(svg, size) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    const sized = svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${sized}`,
    );
    return page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  }

  await mkdir(iconsDir, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const png = await render(size <= SMALL_MAX ? small : full, size);
    await writeFile(path.join(iconsDir, `icon-${size}.png`), png);
    console.log(`wrote src/icons/icon-${size}.png`);
  }
  await writeFile(path.join(assetsDir, 'logo.png'), await render(full, 512));
  console.log('wrote assets/logo.png');
} finally {
  await browser.close();
}
