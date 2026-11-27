import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script, createContext } from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

let esbuildPromise;
async function loadEsbuild() {
  if (!esbuildPromise) {
    esbuildPromise = import('esbuild').catch(() => null);
  }
  return esbuildPromise;
}

async function bundleTsModule(t, entryRel, format = 'cjs') {
  const esbuild = await loadEsbuild();
  if (!esbuild) {
    t.skip('esbuild is absent in zero-dependency release environment');
    return null;
  }
  const result = await esbuild.build({
    entryPoints: [resolve(ROOT, entryRel)],
    bundle: true,
    format,
    platform: 'browser',
    target: 'es2023',
    loader: { '.css': 'text' },
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

function loadCjsInSandbox(code, filename, globals = {}) {
  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    Promise,
    URL,
    URLSearchParams,
    Error,
    Map,
    Set,
    WeakMap,
    Date,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    performance,
    ...globals,
  };
  createContext(sandbox);
  new Script(code, { filename }).runInContext(sandbox);
  return { exports: mod.exports, sandbox };
}

function createFakeEventTarget(tag = 'div') {
  const listeners = new Map();
  const attrs = new Map();
  const classes = new Set();
  const children = [];
  const target = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    id: '',
    hidden: false,
    open: false,
    disabled: false,
    isConnected: true,
    tabIndex: 0,
    dataset: {},
    style: {
      props: new Map(),
      cssText: '',
      visibility: '',
      setProperty(k, v) { this.props.set(k, String(v)); },
      getPropertyValue(k) { return this.props.get(k) || ''; },
      removeProperty(k) { this.props.delete(k); },
    },
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, force) => (force === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : force ? classes.add(c) : classes.delete(c)),
    },
    children,
    parentElement: null,
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((x) => classes.add(x)); },
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    hasAttribute(k) { return attrs.has(k); },
    removeAttribute(k) { attrs.delete(k); },
    addEventListener(type, fn, opts) {
      const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture);
      const passive = typeof opts === 'object' && opts !== null && 'passive' in opts ? opts.passive : undefined;
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push({ fn, capture, passive });
    },
    removeEventListener(type, fn, opts) {
      const capture = typeof opts === 'boolean' ? opts : Boolean(opts?.capture);
      const list = listeners.get(type);
      if (!list) return;
      const idx = list.findIndex((item) => item.fn === fn && item.capture === capture);
      if (idx >= 0) list.splice(idx, 1);
    },
    dispatchEvent(event) {
      const list = [...(listeners.get(event.type) || [])];
      for (const item of list) item.fn(event);
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
    allListeners() {
      const out = [];
      for (const [type, list] of listeners) {
        for (const item of list) out.push({ type, ...item });
      }
      return out;
    },
    append(...nodes) {
      for (const n of nodes) {
        if (n && typeof n === 'object') {
          n.parentElement = target;
          children.push(n);
        }
      }
    },
    after(...nodes) {
      if (this.parentElement) this.parentElement.append(...nodes);
    },
    remove() {
      this.isConnected = false;
      if (this.parentElement) {
        const idx = this.parentElement.children.indexOf(this);
        if (idx >= 0) this.parentElement.children.splice(idx, 1);
      }
      this.parentElement = null;
    },
    focus() { this.focused = true; },
    matches() { return false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 10, right: 200, top: 10, bottom: 200, width: 190, height: 190 }; },
    getClientRects() { return [{}]; },
    contains(other) { return other === this || children.some((c) => c === other || c.contains?.(other)); },
  };
  return target;
}

test('focus-trap attaches document listeners only during present() and detaches idempotently on conceal()/dispose()', async (t) => {
  const code = await bundleTsModule(t, 'src/ui/usage-modal/focus-trap.ts');
  if (!code) return;
  const doc = createFakeEventTarget('document');
  const dialog = createFakeEventTarget('dialog');
  let popoverOpen = false;
  dialog.matches = (sel) => sel === ':popover-open' && popoverOpen;
  dialog.showPopover = () => { popoverOpen = true; dialog.open = true; };
  dialog.hidePopover = () => { popoverOpen = false; dialog.open = false; };
  dialog.setAttribute = (k, v) => { if (k === 'open') dialog.open = true; createFakeEventTarget().setAttribute.call(dialog, k, v); };
  dialog.removeAttribute = (k) => { if (k === 'open') dialog.open = false; };
  const localeBtn = createFakeEventTarget('button');
  const elements = new Map([['locale', localeBtn]]);
  const view = {
    activeElement: null,
    querySelectorAll: () => [],
    getElementById: (id) => elements.get(id) || null,
  };
  const { exports } = loadCjsInSandbox(code, 'focus-trap.ts', {
    document: doc,
    getComputedStyle: () => ({ visibility: 'visible' }),
  });
  const ctx = {
    dialog,
    view,
    state: { disposed: false, opener: createFakeEventTarget('button') },
    options: { displayMode: 'modal' },
    $: (id) => elements.get(id) || null,
  };
  const trap = exports.createFocusTrap(ctx, {
    onCloseYear: () => {},
    onIsYearOpen: () => false,
    onCloseSubPopovers: () => false,
    onCloseManualModal: () => {},
  });

  // Zero listeners before present()
  assert.equal(doc.allListeners().length, 0);

  // present() attaches capture listeners (and repeated present() does not duplicate)
  trap.present();
  trap.present();
  const activeTypes = doc.allListeners().map((l) => `${l.type}:${l.capture}:${l.passive}`).sort();
  assert.deepEqual(activeTypes, [
    'click:true:undefined',
    'focusin:true:undefined',
    'keydown:true:undefined',
    'mousedown:true:undefined',
    'pointerdown:true:undefined',
    'touchmove:true:false',
    'wheel:true:false',
  ]);

  // Esc closes modal and detaches all listeners
  let prevented = false;
  doc.dispatchEvent({
    type: 'keydown',
    key: 'Escape',
    preventDefault() { prevented = true; },
    stopImmediatePropagation() {},
  });
  assert.equal(prevented, true);
  assert.equal(popoverOpen, false);
  assert.equal(doc.allListeners().length, 0);

  // Re-open, then idempotent conceal() and dispose()
  trap.present();
  assert.equal(doc.allListeners().length, 7);
  trap.conceal();
  trap.conceal();
  assert.equal(doc.allListeners().length, 0);
  trap.dispose();
  trap.dispose();
  assert.equal(doc.allListeners().length, 0);
});

test('inline-widget polling uses includeUsage:false when closed, reads usageTotals fallback, and fetches usage on demand', async (t) => {
  const pollingCode = await bundleTsModule(t, 'src/ui/inline-widget/polling-state.ts');
  if (!pollingCode) return;
  const speedCode = await bundleTsModule(t, 'src/ui/inline-widget/speed-card.ts');
  const mountCode = await bundleTsModule(t, 'src/ui/inline-widget/mount-dom.ts');
  if (!speedCode || !mountCode) return;

  const metricCalls = [];
  let modalOpen = false;
  const fullUsage = {
    accountKey: 'acc-1',
    today: '2026-11-27',
    todayTokens: 1234,
    monthTokens: 98765,
    totalTokens: 99999,
    weekTokens: 5000,
    models: [],
    days: [],
    requests: 1,
    firstDate: '2026-11-27',
  };
  const host = {
    async getMetrics(input) {
      metricCalls.push(input);
      if (input.includeUsage) {
        return { connection: 'live', error: null, serverTime: '2026-11-27T00:00:00Z', groups: [], speed: null, usage: fullUsage };
      }
      return {
        connection: 'live',
        error: null,
        serverTime: '2026-11-27T00:00:00Z',
        groups: [],
        speed: null,
        usageTotals: { todayTokens: 1234, monthTokens: 98765 },
      };
    },
    getPreferences: async () => ({ language: 'en', revision: 1 }),
    setPreferences: async (x) => x,
    clearTimeline: async () => ({ cleared: true }),
    updatePlugin: async () => ({ state: 'idle', host: 'app', currentVersion: '0.12.7' }),
  };

  const doc = createFakeEventTarget('document');
  doc.hidden = false;
  const node = createFakeEventTarget('div');
  const rootNodes = new Map([
    ['usage-entry', createFakeEventTarget('div')],
    ['usage-today', createFakeEventTarget('strong')],
    ['usage-month', createFakeEventTarget('strong')],
    ['dot', createFakeEventTarget('span')],
    ['cache-card', createFakeEventTarget('section')],
    ['context-card', createFakeEventTarget('section')],
    ['speed-card', createFakeEventTarget('section')],
  ]);
  const cacheChip = createFakeEventTarget('button');
  const root = {
    getElementById: (id) => rootNodes.get(id) || null,
    querySelector: (sel) => (sel === '[data-card="cache"]' ? cacheChip : null),
    querySelectorAll: () => [],
  };
  const { exports: pollingExports } = loadCjsInSandbox(pollingCode, 'polling-state.ts', { document: doc });
  const { exports: speedExports } = loadCjsInSandbox(speedCode, 'speed-card.ts', { document: doc });
  const { exports: mountExports } = loadCjsInSandbox(mountCode, 'mount-dom.ts', {
    document: doc,
    window: { innerWidth: 1280, innerHeight: 800 },
    MutationObserver: class { observe() {} disconnect() {} },
  });

  let renders = 0;
  const polling = new pollingExports.WidgetPollingState(host, {
    getConversationId: () => null,
    getRoot: () => root,
    getNode: () => node,
    getLanguage: () => ({ language: 'en', t: (k) => k, rateNote: () => '', countdown: () => '—', elapsed: () => '—', resetDate: () => '—', errorMessage: () => '' }),
    isUsageOpen: () => modalOpen,
    onConversationReset: () => {},
    onRender: () => { renders++; },
    onHide: () => {},
    onPreferencesSync: () => {},
    onThemeSync: () => {},
  });

  await polling.refresh();
  assert.equal(metricCalls.length, 1);
  assert.equal(metricCalls[0].includeUsage, false);
  assert.equal(polling.data.usage, undefined);
  assert.deepEqual(polling.data.usageTotals, { todayTokens: 1234, monthTokens: 98765 });

  // Render cards & usage summary from usageTotals while full usage is absent
  const updatedUsageCalls = [];
  const fakeDashboard = {
    get isOpen() { return modalOpen; },
    update(u) { updatedUsageCalls.push(u); },
    open() { modalOpen = true; },
  };
  const language = { language: 'en', t: (k) => k, rateNote: () => '', countdown: () => '—', elapsed: () => '—', resetDate: () => '—', errorMessage: () => '' };
  mountExports.renderWidgetTree({
    root,
    polling,
    usageDashboard: fakeDashboard,
    cards: { hasOpenGroupMenu: false },
    chosen: null,
    composer: null,
    surface: undefined,
    language,
    onSelectGroup: () => {},
    onAfterRender: () => {},
  });
  speedExports.renderSpeedContextCacheCards({ root, data: polling.data, composer: null, lastConversation: null, surface: undefined, language });
  assert.equal(rootNodes.get('usage-entry').hidden, false);
  assert.equal(rootNodes.get('usage-today').textContent, '1.2K');
  assert.equal(rootNodes.get('usage-month').textContent, '98.8K');
  assert.equal(cacheChip.hidden, false);

  // On-demand fetchUsage dedupes concurrent requests and populates polling.data.usage
  const [u1, u2] = await Promise.all([polling.fetchUsage(), polling.fetchUsage()]);
  assert.equal(u1, fullUsage);
  assert.equal(u2, fullUsage);
  assert.equal(metricCalls.length, 2);
  assert.equal(metricCalls[1].includeUsage, true);
  assert.equal(polling.data.usage, fullUsage);

  // While open, polling sends includeUsage: true; after closing, drops usage
  modalOpen = true;
  await polling.refresh();
  assert.equal(metricCalls[2].includeUsage, true);
  modalOpen = false;
  await polling.refresh();
  assert.equal(metricCalls[3].includeUsage, false);
  assert.equal(polling.data.usage, undefined);
  assert.ok(renders >= 3);
  polling.dispose();
});

test('mount-dom skips scroll layout when idle and skips unrelated style/class mutations with node connected', async (t) => {
  const mountCode = await bundleTsModule(t, 'src/ui/inline-widget/mount-dom.ts');
  if (!mountCode) return;
  const doc = createFakeEventTarget('document');
  doc.documentElement = createFakeEventTarget('html');
  const win = createFakeEventTarget('window');
  let observerCb = null;
  class FakeMutationObserver {
    constructor(cb) { observerCb = cb; }
    observe() {}
    disconnect() {}
  }
  const { exports } = loadCjsInSandbox(mountCode, 'mount-dom.ts', {
    document: doc,
    window: win,
    MutationObserver: FakeMutationObserver,
  });

  const node = createFakeEventTarget('div');
  const parent = createFakeEventTarget('div');
  parent.append(node);
  let trackScroll = false;
  let layouts = 0;
  const unbind = exports.bindHostLifecycleListeners({
    getNode: () => node,
    shouldTrackScroll: () => trackScroll,
    scheduleLayout: () => { layouts++; },
    hideCards: () => {},
  });

  // Ordinary scroll when node is connected and no card/guide is open -> 0 layouts
  doc.dispatchEvent({ type: 'scroll' });
  assert.equal(layouts, 0);

  // Scroll when card/guide is active -> triggers scheduleLayout()
  trackScroll = true;
  doc.dispatchEvent({ type: 'scroll' });
  assert.equal(layouts, 1);

  // Unrelated div style/class mutation must NOT call querySelector or scheduleLayout
  trackScroll = false;
  let querySelectorCalled = false;
  const unrelatedDiv = createFakeEventTarget('div');
  unrelatedDiv.matches = () => false;
  unrelatedDiv.querySelector = () => { querySelectorCalled = true; return null; };
  observerCb([{ type: 'attributes', attributeName: 'style', target: unrelatedDiv, addedNodes: [], removedNodes: [] }]);
  observerCb([{ type: 'attributes', attributeName: 'class', target: unrelatedDiv, addedNodes: [], removedNodes: [] }]);
  assert.equal(querySelectorCalled, false);
  assert.equal(layouts, 1);

  // Direct contenteditable element style mutation still triggers layout without subtree querySelector
  const editorEl = createFakeEventTarget('div');
  editorEl.matches = (sel) => sel.includes('[contenteditable="true"]');
  editorEl.querySelector = () => { querySelectorCalled = true; return null; };
  observerCb([{ type: 'attributes', attributeName: 'style', target: editorEl, addedNodes: [], removedNodes: [] }]);
  assert.equal(querySelectorCalled, false);
  assert.equal(layouts, 2);

  // Disconnected node triggers layout on scroll and mutation
  node.isConnected = false;
  doc.dispatchEvent({ type: 'scroll' });
  assert.equal(layouts, 3);
  unbind();
});

test('panel-webview excludes eager usage-modal bundle and lazy-loads /usage-ui.js with dedup and error retry', async (t) => {
  const panelCode = await bundleTsModule(t, 'src/ui/panel-webview/index.ts', 'iife');
  if (!panelCode) return;
  assert.doesNotMatch(panelCode, /usage-intro-history/);
  assert.doesNotMatch(panelCode, /录入远程用量/);
  assert.ok(Buffer.byteLength(panelCode, 'utf8') < 280 * 1024, `Expected slim panel bundle < 280 KB, got ${Buffer.byteLength(panelCode, 'utf8')}`);

  const doc = createFakeEventTarget('document');
  doc.readyState = 'complete';
  doc.documentElement = createFakeEventTarget('html');
  doc.head = createFakeEventTarget('head');
  doc.body = createFakeEventTarget('body');
  const injectedScripts = [];
  const metaVersion = { getAttribute: (k) => (k === 'content' ? 'abc123' : null) };

  const widgetEl = createFakeEventTarget('main');
  const openUsageBtn = createFakeEventTarget('button');
  const healthNote = createFakeEventTarget('p');
  const panelUsageHost = createFakeEventTarget('div');
  panelUsageHost.attachShadow = () => createFakeEventTarget('shadow');
  const byId = new Map([
    ['open-usage-button', openUsageBtn],
    ['health-note', healthNote],
    ['panel-usage-host', panelUsageHost],
    ['card-stage', createFakeEventTarget('section')],
    ['speed-card', createFakeEventTarget('article')],
    ['cache-card', createFakeEventTarget('article')],
    ['context-card', createFakeEventTarget('article')],
  ]);
  doc.getElementById = (id) => byId.get(id) || null;
  doc.querySelector = (sel) => {
    if (sel === '.widget') return widgetEl;
    if (sel === 'meta[name="ag-pulse-panel-assets"]') return metaVersion;
    if (sel === 'script[data-ag-pulse-usage-ui="1"]') return injectedScripts.find((s) => s.isConnected) || null;
    return null;
  };
  doc.querySelectorAll = () => [];
  doc.createElement = (tag) => {
    const el = createFakeEventTarget(tag);
    if (tag === 'script') injectedScripts.push(el);
    return el;
  };
  const win = createFakeEventTarget('window');
  win.document = doc;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const openedSnapshots = [];
  const fullUsage = { accountKey: 'a', today: '2026-11-27', todayTokens: 10, monthTokens: 20, totalTokens: 30, weekTokens: 10, models: [], days: [], requests: 1, firstDate: '2026-11-27' };
  let openedInHost = false;
  win.sidecar = {
    async fetch(url) {
      if (url === '/api/usage/open') return { ok: true, json: async () => ({ openedInHost }) };
      if (url.startsWith('/api/metrics')) {
        const inc = !url.includes('includeUsage=0');
        return {
          ok: true,
          json: async () => ({
            connection: 'live',
            error: null,
            serverTime: '2026-11-27T00:00:00Z',
            groups: [],
            speed: null,
            preferences: { language: 'en', revision: 1 },
            ...(inc ? { usage: fullUsage } : {}),
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    },
  };

  t.after(() => win.dispatchEvent({ type: 'pagehide' }));
  loadCjsInSandbox(panelCode, 'panel-webview.js', {
    window: win,
    document: doc,
    setTimeout: (fn, ms, ...args) => {
      const id = setTimeout(fn, ms, ...args);
      id?.unref?.();
      return id;
    },
    setInterval: (fn, ms, ...args) => {
      const id = setInterval(fn, ms, ...args);
      id?.unref?.();
      return id;
    },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '', opacity: '1' }),
    CSS: { supports: () => false },
    localStorage: { getItem: () => null, setItem() {} },
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(injectedScripts.length, 0, 'No /usage-ui.js script injected on cold start');

  // If host CDP modal opens it, /usage-ui.js is still not injected
  openedInHost = true;
  openUsageBtn.dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(injectedScripts.length, 0);

  // Fallback path: first click fails with script error -> error surfaced and retryable
  openedInHost = false;
  openUsageBtn.dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(injectedScripts.length, 1);
  assert.equal(injectedScripts[0].src, '/usage-ui.js?v=abc123');
  injectedScripts[0].dispatchEvent({ type: 'error' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(openUsageBtn.disabled, false);
  assert.equal(healthNote.classList.contains('warning'), true);
  assert.equal(injectedScripts[0].isConnected, false);

  // Retry succeeds and mounts modal
  openUsageBtn.dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(injectedScripts.length, 2);
  // Concurrent click while script #2 is still loading must dedupe and NOT inject a 3rd script
  openUsageBtn.disabled = false;
  openUsageBtn.dispatchEvent({ type: 'click' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(injectedScripts.length, 2, 'Concurrent clicks must share the in-flight /usage-ui.js script load');
  let usageFactoryCalls = 0;
  win.__agPulseUsageFactory = () => {
    usageFactoryCalls++;
    return {
      isOpen: false,
      open(data) { this.isOpen = true; openedSnapshots.push(data); },
      update() {},
      restoreModal() {},
      syncGuideDismissed() {},
      syncPreferences() {},
      dispose() {},
    };
  };
  injectedScripts[1].dispatchEvent({ type: 'load' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(usageFactoryCalls, 1);
  assert.ok(openedSnapshots.length >= 1);
  assert.equal(openedSnapshots[0], fullUsage);
  assert.equal(openUsageBtn.disabled, false);

  // Source contract check on tools/check-panel-ui.mjs
  const checkPanelSrc = await readFile(resolve(ROOT, 'tools/check-panel-ui.mjs'), 'utf8');
  assert.match(checkPanelSrc, /\/usage-ui\.js/);
});

test('inline-widget __agPulseOpenUsage fetches includeUsage:true on demand when absent and opens synchronously when cached', async (t) => {
  const widgetCode = await bundleTsModule(t, 'src/ui/inline-widget/index.ts');
  if (!widgetCode) return;
  const doc = createFakeEventTarget('document');
  doc.readyState = 'complete';
  doc.hidden = false;
  doc.documentElement = createFakeEventTarget('html');
  doc.body = createFakeEventTarget('body');
  const editor = createFakeEventTarget('div');
  editor.setAttribute('role', 'combobox');
  editor.setAttribute('contenteditable', 'true');
  const modelBtn = createFakeEventTarget('button');
  modelBtn.setAttribute('data-testid', 'model-selector-trigger');
  const left = createFakeEventTarget('div');
  const actions = createFakeEventTarget('div');
  const composer = createFakeEventTarget('div');
  left.append(modelBtn);
  actions.append(left);
  composer.append(editor, actions);
  doc.body.append(composer);

  doc.querySelectorAll = (sel) => {
    if (sel.includes('contenteditable')) return [editor];
    return [];
  };
  doc.createElement = (tag) => {
    const el = createFakeEventTarget(tag);
    el.attachShadow = () => {
      const nodes = new Map([
        ['cache-card', createFakeEventTarget('section')],
        ['context-card', createFakeEventTarget('section')],
        ['speed-card', createFakeEventTarget('section')],
        ['usage-entry', createFakeEventTarget('div')],
        ['usage-today', createFakeEventTarget('strong')],
        ['usage-month', createFakeEventTarget('strong')],
        ['dot', createFakeEventTarget('span')],
      ]);
      const shadow = createFakeEventTarget('shadow');
      shadow.getElementById = (id) => nodes.get(id) || null;
      shadow.querySelectorAll = () => [];
      shadow.querySelector = () => null;
      return shadow;
    };
    el.insertBefore = (child) => { el.children.push(child); child.parentElement = el; };
    return el;
  };
  const origAppend = actions.append;
  actions.insertBefore = (child) => { origAppend(child); };

  const metricCalls = [];
  const fullUsage = { accountKey: 'acc', today: '2026-11-27', todayTokens: 50, monthTokens: 100, totalTokens: 150, weekTokens: 50, models: [], days: [], requests: 1, firstDate: '2026-11-27' };
  const opened = [];
  let modalOpen = false;
  let resolveFetch = null;
  const win = createFakeEventTarget('window');
  win.document = doc;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  win.__agPulseI18nFactory = () => ({
    language: 'en',
    t: (k) => k,
    rateNote: () => '',
    countdown: () => '—',
    elapsed: () => '—',
    resetDate: () => '—',
    errorMessage: () => '',
    connectPreferences: () => ({ ready: Promise.resolve(), error: false, pending: false, sync() {}, choose: async () => {}, toggle: async () => {}, dispose() {} }),
  });
  win.__agPulseThemeFactory = () => ({
    shadowCss: () => '',
    attach: () => ({ update() {}, setHostTheme() {}, dispose() {} }),
  });
  win.__agPulseUsageFactory = () => ({
    get isOpen() { return modalOpen; },
    open(data) { modalOpen = true; opened.push(data); },
    update() {},
    restoreModal() {},
    syncGuideDismissed() {},
    syncPreferences() {},
    dispose() {},
  });
  win.__agPulseSurface = {
    findComposer: () => ({ editor, model: modelBtn, row: actions, branch: left, box: composer, kind: 'main' }),
    conversationId: () => '11111111-1111-1111-1111-111111111111',
    nativeReserve: () => 0,
    setMarkup: () => {},
  };
  win.agPulseHost = {
    getPreferences: async () => ({ language: 'en', revision: 1 }),
    setPreferences: async (x) => x,
    async getMetrics(input) {
      metricCalls.push(input);
      if (input.includeUsage) {
        return await new Promise((resolve) => {
          resolveFetch = () => resolve({
            connection: 'live',
            error: null,
            serverTime: '2026-11-27T00:00:00Z',
            groups: [],
            speed: null,
            usage: fullUsage,
          });
        });
      }
      return {
        connection: 'live',
        error: null,
        serverTime: '2026-11-27T00:00:00Z',
        groups: [],
        speed: null,
        usageTotals: { todayTokens: 50, monthTokens: 100 },
      };
    },
  };

  t.after(() => win.__agPulseDispose?.());
  const { exports } = loadCjsInSandbox(widgetCode, 'inline-widget.js', {
    window: win,
    document: doc,
    innerWidth: 1280,
    innerHeight: 800,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    setTimeout: (fn, ms, ...args) => { const id = setTimeout(fn, ms, ...args); id?.unref?.(); return id; },
    setInterval: (fn, ms, ...args) => { const id = setInterval(fn, ms, ...args); id?.unref?.(); return id; },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '', visibility: 'visible', opacity: '1', marginLeft: '0', marginRight: '0', paddingLeft: '0', paddingRight: '0', columnGap: '0', gap: '0' }),
    HTMLElement: class {},
  });
  exports.default();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(metricCalls.length, 1);
  assert.equal(metricCalls[0].includeUsage, false);

  // Calling __agPulseOpenUsage twice while usage is absent dedupes to one includeUsage:true fetch
  assert.equal(win.__agPulseOpenUsage(), true);
  assert.equal(win.__agPulseOpenUsage(), true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(metricCalls.filter((c) => c.includeUsage).length, 1);
  resolveFetch();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(opened.length, 1);
  assert.equal(opened[0], fullUsage);

  // When usage is already cached on polling.data, __agPulseOpenUsage opens synchronously with zero new fetch
  const beforeCalls = metricCalls.length;
  assert.equal(win.__agPulseOpenUsage(), true);
  assert.equal(metricCalls.length, beforeCalls);
  assert.equal(opened.length, 2);
});
