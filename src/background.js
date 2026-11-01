// Background script (service worker in Chrome, event page in Firefox).
// Owns the API key: content scripts only ever send text and receive translations.

import { loadSettings, publicSettings, sanitize, hostMatches, isConfigured } from './lib/settings.js';
import { translate, isPerTextEngine } from './lib/engines.js';

const ext = globalThis.browser ?? globalThis.chrome;

const MAX_BATCH_ITEMS = 100;
const MAX_ITEM_CHARS = 20000;

// ---- cache (in memory; cleared when the worker is recycled) -------------------------------
const CACHE_LIMIT = 4000;
const cache = new Map();
const cacheKey = (s, text) => {
  // model and extra prompt only influence the OpenAI-compatible engine
  const variant = s.engine === 'openai' ? `${s.model}\u0000${s.extraPrompt}` : '';
  return `${s.engine}\u0000${variant}\u0000${s.targetLang}\u0000${text}`;
};

function cacheGet(key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key); // refresh recency
  cache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

// ---- tiny concurrency limiter -------------------------------------------------------------
let active = 0;
let limit = 3;
const waiting = [];

function schedule(task) {
  return new Promise((resolve, reject) => {
    waiting.push({ task, resolve, reject });
    pump();
  });
}

function pump() {
  while (active < limit && waiting.length) {
    const job = waiting.shift();
    active++;
    job.task().then(job.resolve, job.reject).finally(() => {
      active--;
      pump();
    });
  }
}

// ---- translation --------------------------------------------------------------------------
async function translateTexts(texts) {
  const settings = await loadSettings();
  if (!isConfigured(settings)) {
    throw new Error(ext.i18n.getMessage('errNoApiKey') || 'API key is not set. Open the extension settings.');
  }
  limit = settings.concurrency;

  const results = new Array(texts.length);
  const missing = [];
  texts.forEach((text, i) => {
    const hit = cacheGet(cacheKey(settings, text));
    if (hit === undefined) missing.push(i);
    else results[i] = hit;
  });

  if (missing.length) {
    // The OpenAI-compatible engine translates a whole batch per request. google / microsoft take one
    // text per request, so each text becomes its own job and the concurrency limit applies to those.
    const groups = isPerTextEngine(settings.engine) ? missing.map((i) => [i]) : [missing];
    await Promise.all(
      groups.map((group) =>
        schedule(async () => {
          const translated = await translate(group.map((i) => texts[i]), settings);
          group.forEach((i, j) => {
            results[i] = translated[j];
            cacheSet(cacheKey(settings, texts[i]), translated[j]); // keep finished texts even if a sibling fails
          });
        }),
      ),
    );
  }
  return results;
}

const isValidTexts = (texts) =>
  Array.isArray(texts) &&
  texts.length > 0 &&
  texts.length <= MAX_BATCH_ITEMS &&
  texts.every((t) => typeof t === 'string' && t.length > 0 && t.length <= MAX_ITEM_CHARS);

const errorMessage = (err) => String(err?.message ?? err);

// ---- messages -----------------------------------------------------------------------------
ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== ext.runtime.id) return false;

  switch (msg?.type) {
    case 'translate': {
      if (!isValidTexts(msg.texts)) {
        sendResponse({ ok: false, error: 'Invalid request' });
        return false;
      }
      translateTexts(msg.texts).then(
        (translations) => sendResponse({ ok: true, translations }),
        (err) => sendResponse({ ok: false, error: errorMessage(err) }),
      );
      return true;
    }

    case 'getPublicSettings': {
      loadSettings().then(
        (settings) => {
          const out = publicSettings(settings);
          out.autoTranslate = Boolean(sender.url) && hostMatches(new URL(sender.url).hostname, settings.autoDomains);
          sendResponse(out);
        },
        () => sendResponse(null),
      );
      return true;
    }

    case 'testConnection': {
      // Only the extension's own pages (options) may test with unsaved credentials. The options
      // page lives in a tab, so sender.tab is useless here; a content script's sender.url is
      // always the web page's URL, which cannot start with our extension origin.
      if (!sender.url?.startsWith(ext.runtime.getURL(''))) {
        sendResponse({ ok: false, error: 'Not allowed' });
        return false;
      }
      translate(['Hello, world!'], sanitize(msg.settings), { retries: 0, timeoutMs: 20000 }).then(
        ([result]) => sendResponse({ ok: true, result }),
        (err) => sendResponse({ ok: false, error: errorMessage(err) }),
      );
      return true;
    }

    case 'state': {
      if (sender.tab?.id != null) {
        ext.action.setBadgeText({ tabId: sender.tab.id, text: msg.enabled ? 'ON' : '' });
        ext.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#4f46e5' });
      }
      return false;
    }

    default:
      return false;
  }
});

// ---- keyboard shortcut --------------------------------------------------------------------
ext.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-translate') return;
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) ext.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => {});
});

// ---- first run ----------------------------------------------------------------------------
ext.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') ext.runtime.openOptionsPage();
});
