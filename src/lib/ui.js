// Helpers shared by the popup and the options page.

import { LANGUAGES } from './settings.js';

export const ext = globalThis.browser ?? globalThis.chrome;
export const t = (key) => ext.i18n.getMessage(key) || key;

/** Fill text from _locales: [data-i18n], [data-i18n-placeholder], [data-i18n-title]. */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
}

function languageLabel(code) {
  const ui = ext.i18n.getUILanguage?.() || 'en';
  try {
    const own = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    const local = new Intl.DisplayNames([ui], { type: 'language' }).of(code);
    return own && local && own !== local ? `${own} · ${local}` : own || local || code;
  } catch {
    return code;
  }
}

export function fillLanguageSelect(select, selected) {
  select.replaceChildren(
    ...LANGUAGES.map((code) => {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = languageLabel(code);
      option.selected = code === selected;
      return option;
    }),
  );
}
