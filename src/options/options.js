import { ext, t, applyI18n, fillLanguageSelect } from '../lib/ui.js';
import { loadSettings, saveSettings } from '../lib/settings.js';

applyI18n();

const $ = (id) => document.getElementById(id);
const form = $('form');
const status = $('status');
const testButton = $('test');

function setStatus(text, kind = '') {
  status.textContent = text;
  status.className = kind;
}

/** API address / key / model, extra prompt and batch sizes only apply to the OpenAI-compatible engine. */
function syncEngine() {
  const openai = $('engine').value === 'openai';
  document.querySelectorAll('[data-openai-only]').forEach((el) => {
    el.hidden = !openai;
  });
  $('baseUrl').required = openai; // a hidden required field would silently block saving
  $('model').required = openai;
  const engine = $('engine').value;
  $('engineHint').textContent = t(`engineHint${engine[0].toUpperCase()}${engine.slice(1)}`);
}

function fill(settings) {
  $('engine').value = settings.engine;
  syncEngine();
  $('baseUrl').value = settings.baseUrl;
  $('apiKey').value = settings.apiKey;
  $('model').value = settings.model;
  fillLanguageSelect($('targetLang'), settings.targetLang);
  $('style').value = settings.style;
  $('extraPrompt').value = settings.extraPrompt;
  $('autoDomains').value = settings.autoDomains.join('\n');
  $('batchMaxItems').value = settings.batchMaxItems;
  $('batchMaxChars').value = settings.batchMaxChars;
  $('concurrency').value = settings.concurrency;
}

function read() {
  return {
    engine: $('engine').value,
    baseUrl: $('baseUrl').value,
    apiKey: $('apiKey').value,
    model: $('model').value,
    targetLang: $('targetLang').value,
    style: $('style').value,
    extraPrompt: $('extraPrompt').value,
    autoDomains: $('autoDomains').value,
    batchMaxItems: $('batchMaxItems').value,
    batchMaxChars: $('batchMaxChars').value,
    concurrency: $('concurrency').value,
  };
}

function validate() {
  if ($('engine').value !== 'openai') return true;
  if (!/^https?:\/\/[^\s/]+/i.test($('baseUrl').value.trim())) {
    setStatus(t('optInvalidUrl'), 'error');
    $('baseUrl').focus();
    return false;
  }
  return true;
}

$('engine').addEventListener('change', syncEngine);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!validate()) return;
  const saved = await saveSettings(read());
  fill(saved); // show what was actually stored (normalised values)
  setStatus(t('optSaved'), 'ok');
});

testButton.addEventListener('click', async () => {
  if (!validate()) return;
  testButton.disabled = true;
  setStatus(t('optTesting'));
  try {
    const response = await ext.runtime.sendMessage({ type: 'testConnection', settings: read() });
    if (response?.ok) setStatus(t('optTestOk') + response.result, 'ok');
    else setStatus(t('optTestFail') + (response?.error ?? 'unknown error'), 'error');
  } catch (err) {
    setStatus(t('optTestFail') + (err?.message ?? err), 'error');
  } finally {
    testButton.disabled = false;
  }
});

loadSettings().then(fill);
