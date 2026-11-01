// Finds the pieces of text on a page that should be translated ("units").
//
// A unit is a run of consecutive text/inline nodes inside one block-level container:
//   <p>Hello <b>big</b> world</p>            -> one unit  ("Hello big world")
//   <div>Intro <p>Para 1</p> Outro</div>     -> three units ("Intro", "Para 1", "Outro")
// The translation is later inserted right after the last node of the run.
//
// Classic script (content scripts cannot be ES modules); exposes globalThis.BilingualUnits.

(() => {
  'use strict';

  const TAG = 'bt-translation';
  const TOAST_TAG = 'bt-toast';

  // Never translated and never descended into.
  const SKIP = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'BUTTON',
    'PRE', 'SVG', 'MATH', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'IMG',
    'PICTURE', 'HEAD', 'LINK', 'META', TAG.toUpperCase(), TOAST_TAG.toUpperCase(),
  ]);

  const tagOf = (el) => el.tagName.toUpperCase();
  const isOwnElement = (node) =>
    node.nodeType === 1 && (node.localName === TAG || node.localName === TOAST_TAG);

  const normalize = (s) => s.replace(/\s+/g, ' ').trim();

  // ---- language helpers ---------------------------------------------------------------------
  const SCRIPT_PATTERNS = {
    ko: /\p{Script=Hangul}/u,
    ru: /\p{Script=Cyrillic}/u,
    uk: /\p{Script=Cyrillic}/u,
    ar: /\p{Script=Arabic}/u,
    fa: /\p{Script=Arabic}/u,
    he: /\p{Script=Hebrew}/u,
    th: /\p{Script=Thai}/u,
    hi: /\p{Script=Devanagari}/u,
    el: /\p{Script=Greek}/u,
  };
  const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
  const HAN = /\p{Script=Han}/u;

  const primaryTag = (code) => String(code).toLowerCase().split('-')[0];

  function countMatches(text, pattern) {
    let n = 0;
    for (const ch of text) if (pattern.test(ch)) n++;
    return n;
  }

  /** True when the text is already (mostly) written in the target language's script. */
  function isMostlyTargetScript(text, targetLang) {
    const lang = primaryTag(targetLang);
    const letters = countMatches(text, /\p{L}/u);
    if (!letters) return false;

    if (lang === 'ja') {
      const kana = countMatches(text, KANA);
      return kana > 0 && (kana + countMatches(text, HAN)) / letters >= 0.6;
    }
    if (lang === 'zh') {
      return !KANA.test(text) && countMatches(text, HAN) / letters >= 0.6;
    }
    const pattern = SCRIPT_PATTERNS[lang];
    return pattern ? countMatches(text, pattern) / letters >= 0.6 : false;
  }

  const URL_ONLY = /^(?:https?:\/\/|www\.)\S+$/i;
  const EMAIL_ONLY = /^[\w.+-]+@[\w-]+\.[\w.-]+$/;

  function isTranslatable(text, targetLang) {
    if (text.length < 2) return false;
    if (!/\p{L}/u.test(text)) return false;
    if (URL_ONLY.test(text) || EMAIL_ONLY.test(text)) return false;
    return !isMostlyTargetScript(text, targetLang);
  }

  // ---- DOM helpers --------------------------------------------------------------------------
  function isBlockDisplay(display) {
    return (
      display !== '' &&
      display !== 'inline' &&
      display !== 'contents' &&
      display !== 'none' &&
      !display.startsWith('inline-') &&
      !display.startsWith('ruby')
    );
  }

  const displayOf = (el) => getComputedStyle(el).display;
  const isBlockElement = (el) => isBlockDisplay(displayOf(el));

  /** Does this (inline) element contain a block-level descendant? */
  function containsBlock(el) {
    if (!el.firstElementChild) return false;
    for (const d of el.getElementsByTagName('*')) {
      if (d.localName === TAG) continue;
      if (isBlockDisplay(displayOf(d))) return true;
    }
    return false;
  }

  function shouldSkipElement(el, targetLang, isRoot) {
    if (el.getAttribute('translate') === 'no') return true;
    if (el.classList.contains('notranslate')) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    const editable = el.getAttribute('contenteditable');
    if (editable !== null && editable !== 'false') return true;
    if (!isRoot) {
      const lang = el.getAttribute('lang');
      if (lang && primaryTag(lang) === primaryTag(targetLang)) return true;
    }
    return getComputedStyle(el).visibility === 'hidden';
  }

  function collectText(node, out) {
    if (node.nodeType === 3) {
      out.push(node.data);
      return;
    }
    if (node.nodeType !== 1) return;
    if (SKIP.has(tagOf(node))) return;
    if (node.localName === 'br') {
      out.push(' ');
      return;
    }
    if (displayOf(node) === 'none') return;
    for (let child = node.firstChild; child; child = child.nextSibling) collectText(child, out);
  }

  function makeUnit(run, targetLang) {
    const parts = [];
    for (const node of run) collectText(node, parts);
    const text = normalize(parts.join(''));
    if (!isTranslatable(text, targetLang)) return null;
    return { nodes: run, last: run[run.length - 1], text };
  }

  function walk(container, targetLang, out, isRoot) {
    if (SKIP.has(tagOf(container)) || shouldSkipElement(container, targetLang, isRoot)) return;

    let run = [];
    const flush = () => {
      if (run.length) {
        const unit = makeUnit(run, targetLang);
        if (unit) out.push(unit);
        run = [];
      }
    };

    for (let node = container.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 3) {
        run.push(node);
        continue;
      }
      if (node.nodeType !== 1) continue;

      if (isOwnElement(node)) {
        flush(); // our own translation closes the run before it
        continue;
      }

      const display = displayOf(node);
      if (display === 'none') continue;

      const block = isBlockDisplay(display);
      if (SKIP.has(tagOf(node))) {
        if (block) flush();
        continue;
      }
      if (block || containsBlock(node)) {
        flush();
        walk(node, targetLang, out, false);
      } else {
        run.push(node);
      }
    }
    flush();
  }

  /** Collect translation units below `root` (an Element). */
  function collectUnits(root, { targetLang }) {
    const out = [];
    if (root && root.nodeType === 1) walk(root, targetLang, out, true);
    return out;
  }

  globalThis.BilingualUnits = {
    TAG,
    TOAST_TAG,
    collectUnits,
    isTranslatable,
    isBlockElement,
    isOwnElement,
    normalize,
  };
})();
