import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createShareClient } from '../public/share-client.mjs';
import { calculateResidualValue } from '../src/core.mjs';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const exports = ['download-png', 'create-link', 'copy-markdown'];

// Execute real core, adapter and app together. Only DOM/popup/FX ports and the
// clock are controlled; localToday retains the real Date getters in each TZ.
async function harness(t, { native, tz = 'Asia/Shanghai', instant = '2026-09-05T16:30:00Z' }) {
  const previousTZ = process.env.TZ;
  process.env.TZ = tz;
  t.after(() => { if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ; });
  let now = Date.parse(instant);
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const [html, core, adapter, app] = await Promise.all([
    read('public/index.html'), read('src/core.mjs'), read('public/control-adapter.mjs'), read('public/app.mjs'),
  ]);
  const elements = new Map();
  const document = {
    documentElement: { dataset: {} }, activeElement: null, hidden: false, listeners: {},
    querySelector: (selector) => elements.get(selector.slice(1)),
    createElement: () => element(),
    addEventListener(key, fn) { this.listeners[key] = fn; },
  };
  function element(tag = '') {
    const attributes = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
    return {
      id: attributes.id, value: attributes.value ?? '', type: attributes.type, attributes,
      textContent: '', title: '', style: {}, listeners: {}, lastChild: { textContent: '' },
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(key, value) { this.attributes[key] = value; if (key === 'id') this.id = value; },
      hasAttribute(key) { return key in this.attributes; },
      getAttribute(key) { return this.attributes[key]; },
      addEventListener(key, fn) { this.listeners[key] = fn; },
      removeEventListener(key) { delete this.listeners[key]; },
      replaceWith(next) { elements.set(this.id, next); },
      focus() { document.activeElement = this; }, closest() { return null; }, append() {},
    };
  }
  for (const [tag, id] of html.matchAll(/<[^/!][^>]*\bid="([^"]+)"[^>]*>/g)) elements.set(id, element(tag));
  const preference = {
    matches: native, addEventListener(_, fn) { this.change = fn; }, removeEventListener() {},
  };
  const window = { listeners: {}, matchMedia: () => preference, addEventListener(key, fn) { this.listeners[key] = fn; } };
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    Date: Clock, document, window, createShareClient,
    createSelect: () => ({ destroy() {} }), createDatePicker: () => ({ destroy() {} }),
    createExchangeClient: () => ({ getState: () => ({ snapshot: null, loading: false, error: '', stale: false }) }),
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
  });
  for (const source of [core, adapter, app]) vm.runInContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), context);
  return {
    context, preference, get: (id) => elements.get(id),
    today: () => context.localToday(), utcToday: () => new Clock().toISOString().slice(0, 10),
    advanceDay() { now += 86_400_000; },
    refresh(kind) {
      if (kind === 'midnight') [...timers.values()].find((fn) => fn.name === 'refreshToday')();
      else if (kind === 'focus') window.listeners.focus();
      else document.listeners.visibilitychange();
    },
  };
}

for (const fixture of [
  { tz: 'Asia/Shanghai', instant: '2026-09-05T16:30:00Z', expected: '2026-09-06' },
  { tz: 'America/Los_Angeles', instant: '2026-09-05T01:30:00Z', expected: '2026-09-04' },
]) for (const native of [false, true]) {
  test(`both dates initially use local, not UTC, today (${fixture.tz}, ${native ? 'native' : 'desktop'})`, async (t) => {
    const h = await harness(t, { ...fixture, native });
    assert.notEqual(h.utcToday(), fixture.expected, 'fixture distinguishes local and UTC dates');
    assert.equal(h.get('end-at').value, fixture.expected, 'expiry defaults to browser-local today');
    assert.equal(h.get('valued-label').textContent, fixture.expected, 'read-only transaction date uses the same local day');
    assert.equal(h.get('valued-label').dateTime, fixture.expected);
    assert.equal(h.get('valued-at'), undefined, 'no editable transaction date');
    assert.equal(h.get('amount').value, '', 'amount remains empty');
    assert.equal(h.get('billing-cycle').value, 'annual');
    assert.equal(h.get('name').value, 'VPS');
    assert.equal(h.get('currency').value, 'CNY');
    assert.equal(h.get('end-at').attributes['aria-invalid'], 'false');
    assert.equal(h.get('form-error').textContent, '');
    for (const id of exports) assert.equal(h.get(id).disabled, true, 'empty amount disables exports');
    h.get('amount').value = '120';
    h.context.onInputChange();
    assert.equal(h.get('remaining-value').textContent, '¥0.00');
    assert.equal(h.get('remaining-duration').textContent, '0 天');
    assert.equal(h.context.readPayload().endAt, fixture.expected);
    assert.equal(h.context.readPayload().valuedAt, fixture.expected);
    for (const id of exports) assert.equal(h.get(id).disabled, false, 'today is a valid zero-day expiry');
  });
}

for (const native of [false, true]) test(`chosen, cleared and partial expiry survive mode/day/focus refresh (${native ? 'native' : 'desktop'})`, async (t) => {
  const h = await harness(t, { native });
  h.get('amount').value = '120';
  for (const draft of ['2028-02-29', '', '2028-']) {
    h.get('end-at').value = draft;
    h.context.onInputChange();
    const check = () => {
      assert.equal(h.get('end-at').value, draft, 'never backfill or rewrite a user draft');
      if (draft !== '2028-02-29') {
        assert.equal(h.get('end-at').attributes['aria-invalid'], 'true');
        assert.equal(h.get('remaining-value').textContent, '—');
        for (const id of exports) assert.equal(h.get(id).disabled, true);
      }
    };
    for (const mode of [!native, native, true]) {
      h.preference.matches = mode;
      h.preference.change();
      check();
    }
    for (let count = 0; count < 2; count++) {
      h.get('end-at-mode').listeners.click();
      check();
    }
    for (const kind of ['midnight', 'focus', 'visibility']) {
      h.advanceDay();
      h.refresh(kind);
      assert.equal(h.get('valued-label').textContent, h.today(), `${kind} refreshes transaction date`);
      assert.equal(h.context.readPayload().valuedAt, h.today());
      check();
    }
  }
});

for (const file of ['public/index.html', 'public/app.mjs', 'public/controls.mjs', 'src/core.mjs', 'src/share.mjs']) {
  test(`expiry copy is consistently 到期日 (${file})`, async () => {
    const source = await read(file);
    assert.equal(source.includes('到期日期'), false, `${file}: remove old expiry wording, including accessible/error/help text`);
    assert.ok(source.includes('到期日'));
  });
}

test('strict expiry validation exposes the updated label without changing rejection rules', () => {
  const payload = { amount: 120, currency: 'CNY', valuedAt: '2026-09-05', billingCycle: 'annual' };
  assert.throws(() => calculateResidualValue({ ...payload, endAt: '' }), { name: 'TypeError', message: '到期日必须为 YYYY-MM-DD 日期' });
  assert.throws(() => calculateResidualValue({ ...payload, endAt: '2026-02-30' }), { name: 'RangeError', message: '到期日无效' });
});

// Geometry is accepted separately in a real browser; these scoped CSS contracts
// avoid Safari's temporal-input block-layout bottom gap, without centering horizontally.
test('native date centers vertically and stays left-aligned without changing manual text, desktop or picker access', async () => {
  const css = await read('public/styles.css');
  const rule = (selector) => Object.assign({}, ...[...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selectors]) => selectors.split(',').map((value) => value.trim()).includes(selector))
    .map(([, , body]) => Object.fromEntries(body.split(';').filter((value) => value.trim()).map((value) => value.split(':').map((part) => part.trim())))));
  const date = rule('.native-control[type="date"]');
  for (const [key, value] of Object.entries({ display: 'flex', 'align-items': 'center', 'justify-content': 'flex-start', 'text-align': 'left', position: 'relative', width: '100%' })) assert.equal(date[key], value, `native date vertical layout ${key}`);
  const native = rule('.native-control');
  const field = rule('.native-control.date-input');
  const manual = { ...rule('.control-trigger'), ...native, ...field, ...rule('.native-control[type="text"]') };
  assert.equal(manual['text-align'], 'left', 'manual text retains left alignment');
  assert.equal(manual.display, 'block', 'manual text retains native vertical layout');
  const safari = rule('.native-control::-webkit-date-and-time-value');
  assert.ok(['block', 'flex'].includes(safari.display), 'Safari value has an explicit layout');
  for (const [key, value] of Object.entries({ 'align-self': 'center', 'text-align': 'left', 'min-height': '0', 'line-height': 'normal' })) assert.equal(safari[key], value, `Safari value vertical layout ${key}`);
  const chromium = rule('.native-control::-webkit-datetime-edit');
  for (const [key, value] of Object.entries({ 'text-align': 'left', padding: '0', 'min-width': '0' })) assert.equal(chromium[key], value, `Chromium date fields ${key}`);
  for (const text of [field, date, safari, chromium]) {
    assert.equal(text.transform, undefined, 'center text through layout, not a pixel translation');
  }
  const indicator = rule('.native-control::-webkit-calendar-picker-indicator');
  for (const [key, value] of Object.entries({ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', margin: '0' })) assert.equal(indicator[key], value, `clickable native icon stays out of text flow: ${key}`);
  assert.notEqual(indicator.display, 'none');
  assert.notEqual(indicator['pointer-events'], 'none');
  assert.notEqual(indicator.opacity, '0');
  assert.equal(rule('.control-trigger')['text-align'], 'left', 'desktop unchanged');
  for (const [key, value] of Object.entries({ 'font-size': '16px', 'min-height': '44px', 'min-width': '0', 'max-width': '100%' })) assert.equal(native[key], value, `native size guard ${key}`);
});
