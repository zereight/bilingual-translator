// Content script: shows the translation below each paragraph of the page.
//
// Flow: scan the DOM for units -> put an empty <bt-translation> placeholder after each one ->
// when a placeholder gets near the viewport, queue its text -> send batches to the background
// script -> fill the placeholder with the translation. A MutationObserver keeps up with
// dynamic pages. Translations are always inserted with textContent, never as HTML.

(() => {
  'use strict';

  if (globalThis.__bilingualTranslatorLoaded) return;
  globalThis.__bilingualTranslatorLoaded = true;

  const ext = globalThis.browser ?? globalThis.chrome;
  const U = globalThis.BilingualUnits;
  const msg = (key) => ext.i18n.getMessage(key) || key;

  const MAX_UPDATES_PER_UNIT = 5; // stops tickers/clocks from being re-translated forever
  const FLUSH_DELAY_MS = 80;
  const RESCAN_DELAY_MS = 300;

  let enabled = false;
  let generation = 0; // bumped on every enable/disable so late responses can be ignored
  let settings = { targetLang: 'ko', style: 'subtle', batchMaxItems: 8, batchMaxChars: 2400 };

  let observer = null; // IntersectionObserver
  let mutations = null; // MutationObserver
  let states = new WeakMap(); // <bt-translation> element -> state
  const queue = new Set();
  const dirty = new Set();
  let flushTimer = 0;
  let rescanTimer = 0;
  let errorStreak = 0;
  let halted = false;
  let toastTimer = 0;

  // ---- scanning ---------------------------------------------------------------------------
  function scan(root) {
    for (const unit of U.collectUnits(root, { targetLang: settings.targetLang })) register(unit);
  }

  function register(unit) {
    const next = unit.last.nextSibling;
    if (next && next.nodeType === 1 && next.localName === U.TAG) {
      const existing = states.get(next);
      if (!existing) {
        next.remove(); // left over from a previous run of this script
      } else {
        if (existing.text === unit.text || existing.updates >= MAX_UPDATES_PER_UNIT) return;
        existing.updates++;
        existing.text = unit.text;
        reset(existing);
        return;
      }
    }

    const el = document.createElement(U.TAG);
    el.setAttribute('dir', 'auto');
    el.setAttribute('lang', settings.targetLang);
    el.dataset.btState = 'pending';
    const state = { el, text: unit.text, requested: '', status: 'pending', updates: 0 };
    states.set(el, state);
    el.addEventListener('click', (event) => {
      if (state.status !== 'error') return;
      event.preventDefault();
      event.stopPropagation();
      halted = false;
      errorStreak = 0;
      reset(state);
    });
    unit.last.parentNode.insertBefore(el, unit.last.nextSibling);
    observer.observe(el);
  }

  function reset(state) {
    queue.delete(state);
    state.status = 'pending';
    state.el.textContent = '';
    state.el.removeAttribute('title');
    state.el.dataset.btState = 'pending';
    observer.unobserve(state.el);
    observer.observe(state.el);
  }

  // ---- visibility -> queue -> batches -------------------------------------------------------
  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const state = states.get(entry.target);
      if (!state || state.status !== 'pending') continue;
      observer.unobserve(entry.target);
      state.status = 'queued';
      queue.add(state);
    }
    if (queue.size && !flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  }

  function flush() {
    flushTimer = 0;
    if (!enabled) return;
    const items = [...queue].filter((s) => s.el.isConnected);
    queue.clear();

    let batch = [];
    let chars = 0;
    for (const state of items) {
      const full =
        batch.length >= settings.batchMaxItems || chars + state.text.length > settings.batchMaxChars;
      if (batch.length && full) {
        dispatch(batch);
        batch = [];
        chars = 0;
      }
      batch.push(state);
      chars += state.text.length;
    }
    if (batch.length) dispatch(batch);
  }

  async function dispatch(batch) {
    const myGeneration = generation;
    if (halted) {
      batch.forEach(fail);
      return;
    }
    for (const state of batch) {
      state.status = 'loading';
      state.requested = state.text;
      state.el.dataset.btState = 'loading';
    }

    let response;
    try {
      response = await ext.runtime.sendMessage({ type: 'translate', texts: batch.map((s) => s.text) });
    } catch (err) {
      response = { ok: false, error: String(err?.message ?? err) };
    }
    if (myGeneration !== generation) return;

    if (!response?.ok) {
      errorStreak++;
      if (errorStreak >= 2) halted = true;
      showToast(response?.error || 'Unknown error');
      batch.forEach(fail);
      return;
    }
    errorStreak = 0;
    batch.forEach((state, i) => apply(state, response.translations?.[i]));
  }

  function apply(state, translation) {
    if (state.status !== 'loading' || state.requested !== state.text) return; // text changed meanwhile
    const out = typeof translation === 'string' ? translation.trim() : '';
    if (!out || U.normalize(out) === state.text) {
      state.status = 'same'; // already in the target language: keep an invisible marker
      state.el.dataset.btState = 'same';
      return;
    }
    state.el.textContent = out;
    state.el.dataset.btState = 'done';
    state.status = 'done';
  }

  function fail(state) {
    if (state.status === 'error') return;
    state.status = 'error';
    state.el.textContent = msg('errFailed');
    state.el.title = msg('errRetryHint');
    state.el.dataset.btState = 'error';
  }

  function showToast(text) {
    let toast = document.querySelector(U.TOAST_TAG);
    if (!toast) {
      toast = document.createElement(U.TOAST_TAG);
      document.documentElement.appendChild(toast);
    }
    toast.textContent = `${msg('extName')}: ${text}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.remove(), 8000);
  }

  // ---- dynamic pages ------------------------------------------------------------------------
  const insideOwn = (el) => Boolean(el.closest?.(`${U.TAG},${U.TOAST_TAG}`));

  function onMutations(records) {
    for (const record of records) {
      if (record.type === 'childList') {
        const touched = [...record.addedNodes, ...record.removedNodes];
        if (touched.length && touched.every(U.isOwnElement)) continue;
        if (insideOwn(record.target)) continue;
        dirty.add(record.target);
      } else if (record.type === 'characterData') {
        const parent = record.target.parentElement;
        if (parent && !insideOwn(parent)) dirty.add(parent);
      }
    }
    if (dirty.size && !rescanTimer) rescanTimer = setTimeout(rescan, RESCAN_DELAY_MS);
  }

  function blockAncestor(el) {
    while (el && el !== document.body && el !== document.documentElement && !U.isBlockElement(el)) {
      el = el.parentElement;
    }
    return el && el !== document.documentElement ? el : document.body;
  }

  function rescan() {
    rescanTimer = 0;
    if (!enabled) return;
    const roots = new Set();
    for (const el of dirty) if (el.isConnected) roots.add(blockAncestor(el));
    dirty.clear();
    roots.forEach(scan);
  }

  // ---- on / off -----------------------------------------------------------------------------
  const report = () => {
    try {
      ext.runtime.sendMessage({ type: 'state', enabled }).catch(() => {});
    } catch {
      // extension was reloaded; nothing to do
    }
  };

  async function enable() {
    if (enabled || !document.body) return;
    enabled = true;
    const myGeneration = ++generation;

    try {
      const fresh = await ext.runtime.sendMessage({ type: 'getPublicSettings' });
      if (fresh) settings = { ...settings, ...fresh };
    } catch {
      // keep defaults
    }
    if (!enabled || myGeneration !== generation) return;

    document.documentElement.dataset.btStyle = settings.style;
    observer = new IntersectionObserver(onIntersect, { rootMargin: '600px 0px' });
    mutations = new MutationObserver(onMutations);
    scan(document.body);
    mutations.observe(document.body, { childList: true, subtree: true, characterData: true });
    report();
  }

  function disable() {
    enabled = false;
    generation++;
    observer?.disconnect();
    mutations?.disconnect();
    observer = mutations = null;
    clearTimeout(flushTimer);
    clearTimeout(rescanTimer);
    flushTimer = rescanTimer = 0;
    queue.clear();
    dirty.clear();
    document.querySelectorAll(`${U.TAG},${U.TOAST_TAG}`).forEach((el) => el.remove());
    states = new WeakMap();
    errorStreak = 0;
    halted = false;
    report();
  }

  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== ext.runtime.id) return false;
    switch (message?.type) {
      case 'getState':
        sendResponse({ enabled });
        return false;
      case 'toggle':
        (enabled ? Promise.resolve(disable()) : enable()).then(() => sendResponse({ enabled }));
        return true;
      case 'restart':
        disable();
        enable().then(() => sendResponse({ enabled }));
        return true;
      default:
        return false;
    }
  });

  // Auto-translate sites chosen in the settings.
  (async () => {
    try {
      const fresh = await ext.runtime.sendMessage({ type: 'getPublicSettings' });
      if (fresh) {
        settings = { ...settings, ...fresh };
        if (fresh.autoTranslate && fresh.configured) enable();
      }
    } catch {
      // background not reachable
    }
  })();
})();
