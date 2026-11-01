import { ext, t, applyI18n, fillLanguageSelect } from '../lib/ui.js';
import { loadSettings, saveSettings, isConfigured } from '../lib/settings.js';

applyI18n();

const toggle = document.getElementById('toggle');
const lang = document.getElementById('lang');
const notice = document.getElementById('notice');

let tabId = null;
let enabled = false;
let available = true;

function showNotice(text) {
  notice.hidden = !text;
  notice.textContent = text || '';
}

function render() {
  toggle.disabled = !available;
  toggle.classList.toggle('active', enabled);
  toggle.textContent = t(enabled ? 'popupShowOriginal' : 'popupTranslate');
}

async function init() {
  const settings = await loadSettings();
  fillLanguageSelect(lang, settings.targetLang);

  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;
  try {
    const state = await ext.tabs.sendMessage(tabId, { type: 'getState' });
    enabled = Boolean(state?.enabled);
  } catch {
    available = false; // about:, the add-on store, PDF viewer, ... have no content script
  }

  if (!available) showNotice(t('popupUnavailable'));
  else if (!isConfigured(settings)) showNotice(t('popupNotConfigured'));
  render();
}

toggle.addEventListener('click', async () => {
  toggle.disabled = true;
  try {
    const state = await ext.tabs.sendMessage(tabId, { type: 'toggle' });
    enabled = Boolean(state?.enabled);
  } catch {
    available = false;
    showNotice(t('popupUnavailable'));
  }
  render();
});

lang.addEventListener('change', async () => {
  const settings = await loadSettings();
  await saveSettings({ ...settings, targetLang: lang.value });
  if (enabled) {
    try {
      await ext.tabs.sendMessage(tabId, { type: 'restart' });
    } catch {
      // page went away
    }
  }
});

document.getElementById('settings').addEventListener('click', (event) => {
  event.preventDefault();
  ext.runtime.openOptionsPage();
  window.close();
});

init();
