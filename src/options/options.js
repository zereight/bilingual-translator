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

function fill(settings) {
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
  if (!/^https?:\/\/[^\s/]+/i.test($('baseUrl').value.trim())) {
    setStatus(t('optInvalidUrl'), 'error');
    $('baseUrl').focus();
    return false;
  }
  return true;
}

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
