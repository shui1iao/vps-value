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
async function harness(t, { tz = 'Asia/Shanghai', instant = '2026-09-05T16:30:00Z' } = {}) {
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
  const window = { listeners: {}, addEventListener(key, fn) { this.listeners[key] = fn; } };
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    Date: Clock, document, window, createShareClient,
    createSelect: (trigger, options, config) => { trigger.value = config.value; return { destroy() {} }; },
    createDatePicker: (trigger, config) => { config.input.value = config.value; return { destroy() {} }; },
    createExchangeClient: () => ({ getState: () => ({ snapshot: null, loading: false, error: '', stale: false }) }),
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
  });
  for (const source of [core, adapter, app]) vm.runInContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), context);
  return {
    context, get: (id) => elements.get(id),
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
]) {
  test(`both dates initially use local, not UTC, today (${fixture.tz})`, async (t) => {
    const h = await harness(t, fixture);
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

test('chosen, cleared, partial and impossible expiry survive day/focus/visibility refresh', async (t) => {
  const h = await harness(t);
  h.get('amount').value = '120';
  for (const draft of ['2028-02-29', '', '2028-', '2026-02-30']) {
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
    check();
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
