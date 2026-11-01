// Builds dist/chrome and dist/firefox (+ zip files) from src/.
// The two browsers differ only in manifest.json (background declaration + Firefox metadata).
// Usage: node scripts/build.mjs

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { zipDirectory } from './zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');

const FIREFOX_ID = 'bilingual-translator@zereight.github.io';

const base = JSON.parse(await readFile(path.join(src, 'manifest.json'), 'utf8'));

const variants = {
  chrome: (m) => ({
    ...m,
    minimum_chrome_version: '110',
    background: { service_worker: 'background.js', type: 'module' },
  }),
  firefox: (m) => ({
    ...m,
    background: { scripts: ['background.js'], type: 'module' },
    browser_specific_settings: {
      gecko: {
        id: FIREFOX_ID,
        // 140 is the first release that supports data_collection_permissions (required for new add-ons).
        strict_min_version: '140.0',
        // Page text is sent to the API endpoint the user configures.
        data_collection_permissions: { required: ['websiteContent'] },
      },
      gecko_android: { strict_min_version: '142.0' },
    },
  }),
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const [browser, transform] of Object.entries(variants)) {
  const out = path.join(dist, browser);
  await cp(src, out, {
    recursive: true,
    filter: (file) => path.basename(file) !== 'manifest.json' || path.dirname(file) !== src,
  });
  const manifest = transform(structuredClone(base));
  await writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const zipName = `bilingual-translator-${base.version}-${browser}.zip`;
  const count = await zipDirectory(out, path.join(dist, zipName));
  console.log(`${browser}: dist/${browser}/  ->  dist/${zipName} (${count} files)`);
}
