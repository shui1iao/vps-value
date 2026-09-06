import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import * as core from '../src/core.mjs';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

async function harness(device) {
  const source = await read('public/control-adapter.mjs');
  const element = (id, type = 'button') => ({
    id, type, value: '', attributes: {}, listeners: new Map(),
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(key, fn) { const list = this.listeners.get(key) ?? []; list.push(fn); this.listeners.set(key, list); },
    removeEventListener(key, fn) { this.listeners.set(key, (this.listeners.get(key) ?? []).filter((item) => item !== fn)); },
    dispatch(key, event) { for (const fn of this.listeners.get(key) ?? []) fn(event); },
  });
  const fields = { currency: element('currency'), billingCycle: element('billing-cycle'), endAt: element('end-at', 'text') };
  fields.endAt.setAttribute('aria-describedby', 'expiry-help form-error');
  const ports = new Map(['#end-at-picker', '#end-at-control'].map((id) => [id, element(id.slice(1))]));
  const calls = [];
  let todayReads = 0;
  const context = vm.createContext({
    ...core, localToday() { todayReads++; return core.localToday(); },
    window: { innerWidth: device.width, matchMedia() { assert.fail('control type must not depend on device capability'); } },
    navigator: { userAgent: device.ua, maxTouchPoints: device.touch },
    document: { querySelector: (selector) => ports.get(selector), documentElement: { dataset: {} } },
    createSelect(trigger, options, config) {
      trigger.value = config.value;
      const call = { kind: 'select', trigger, options, config, destroyed: 0 };
      calls.push(call);
      return { destroy() { call.destroyed++; } };
    },
    createDatePicker(trigger, config) {
      config.input.value = config.value;
      const call = { kind: 'date', trigger, config, destroyed: 0 };
      calls.push(call);
      return { destroy() { call.destroyed++; } };
    },
  });
  vm.runInContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), context);
  assert.equal(typeof context.createCustomControls, 'function', 'one custom initializer must replace the adaptive/native API');
  return { context, fields, ports, calls, todayReads: () => todayReads };
}

const devices = [
  { label: 'desktop mouse', width: 1440, touch: 0, ua: 'desktop' },
  { label: 'narrow mouse', width: 320, touch: 0, ua: 'desktop' },
  { label: 'touch phone', width: 390, touch: 5, ua: 'iPhone' },
  { label: 'touch tablet', width: 1024, touch: 5, ua: 'iPad' },
];
for (const device of devices) test(`always mounts the same custom controls (${device.label})`, async () => {
  const h = await harness(device);
  const original = { ...h.fields };
  let changes = 0;
  const onChange = () => { changes++; };
  const controls = h.context.createCustomControls(h.fields, { onChange });
  assert.deepEqual(h.calls.map((call) => call.kind), ['select', 'select', 'date']);
  assert.equal(h.fields.currency.type, 'button');
  assert.equal(h.fields.billingCycle.type, 'button');
  assert.equal(h.fields.endAt.type, 'text');
  for (const key of Object.keys(original)) assert.equal(h.fields[key], original[key], 'do not replace stable HTML fields');
  assert.equal(h.fields.currency.value, 'CNY');
  assert.equal(h.fields.billingCycle.value, 'annual');
  assert.equal(h.fields.endAt.value, core.localToday());
  assert.equal(h.todayReads(), 1, 'initialize local expiry exactly once');
  assert.equal(changes, 0, 'initialization does not invent an input revision');
  assert.deepEqual(Array.from(h.calls[0].options, (option) => option.value), core.CURRENCIES);
  for (const option of h.calls[0].options) assert.equal(option.description, core.CURRENCY_NAMES[option.value]);
  assert.equal(h.calls[1].options, core.BILLING_CYCLES);
  assert.equal(h.calls[2].trigger, h.ports.get('#end-at-picker'));
  assert.equal(h.calls[2].config.input, h.fields.endAt);
  assert.equal(h.calls[2].config.anchor, h.ports.get('#end-at-control'));
  assert.equal(h.fields.endAt.attributes['aria-describedby'], 'expiry-help form-error');
  assert.equal(h.fields.endAt.attributes['aria-keyshortcuts'], 'Alt+ArrowDown');
  for (const call of h.calls) { assert.equal(call.config.onChange, onChange); call.config.onChange(); }
  assert.equal(changes, 3, 'all custom controllers retain the shared calculation/export callback');
  let prevented = 0;
  for (const key of ['ArrowDown', '1', 'Enter']) h.fields.endAt.dispatch('keydown', { key, preventDefault() { prevented++; } });
  assert.equal(prevented, 1, 'plain typing does not open a picker and Enter does not submit');
  assert.equal(h.fields.endAt.listeners.get('click'), undefined, 'typing/focusing the text field is not a calendar click proxy');
  for (const draft of ['2028-02-29', '', '2028-', '2026-02-30']) {
    h.fields.endAt.value = draft;
    onChange();
    assert.equal(h.fields.endAt.value, draft, 'shared callback never sanitizes or backfills the user draft');
  }
  assert.equal(h.todayReads(), 1);
  controls.destroy();
  controls.destroy();
  assert.deepEqual(h.calls.map((call) => call.destroyed), [1, 1, 1], 'teardown is idempotent');
  assert.equal(h.fields.endAt.listeners.get('keydown').length, 0);
  assert.equal(h.fields.endAt.value, '2026-02-30', 'teardown leaves input intact');
});

test('adapter exports only the custom initializer, not native policy or mode switches', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'vps-custom-adapter-'));
  try {
    for (const name of ['controls.mjs', 'control-adapter.mjs']) await cp(new URL(`../public/${name}`, import.meta.url), path.join(dir, name));
    await cp(new URL('../src/core.mjs', import.meta.url), path.join(dir, 'core.mjs'));
    assert.deepEqual(Object.keys(await import(pathToFileURL(path.join(dir, 'control-adapter.mjs')))), ['createCustomControls']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('HTML and CSS contain no system select/date or date mode, and retain touch-safe text', async () => {
  const [html, css, app, adapter] = await Promise.all(['public/index.html', 'public/styles.css', 'public/app.mjs', 'public/control-adapter.mjs'].map(read));
  assert.doesNotMatch(html, /<select\b|type="date"|end-at-mode|date-mode|field-label/);
  assert.match(html, /<input[^>]+id="end-at"[^>]+type="text"/);
  const picker = html.match(/<button[^>]+id="end-at-picker"[^>]*>/)?.[0];
  assert.ok(picker);
  assert.doesNotMatch(picker, /\bhidden\b/);
  assert.doesNotMatch(css, /native-control|data-control-mode|date-mode|field-label|::-webkit-(?:date|calendar-picker)/);
  assert.match(css, /@media\s*\(pointer:\s*coarse\)\s*and\s*\(hover:\s*none\)\s*\{\s*#calculator input,\s*#calculator \.control-trigger\s*\{[^}]*font-size:\s*16px/s);
  assert.match(css, /input,\s*\.control-trigger\s*\{[^}]*height:\s*44px/s);
  assert.match(css, /\.control-trigger\s*\{[^}]*text-align:\s*left/s);
  assert.match(css, /#currency-popover\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(app, /createCustomControls\(fields/);
  assert.doesNotMatch(adapter + app, /nativeControlPreference|dateInputType|createAdaptiveControls|matchMedia|end-at-mode|nativeLabel|createElement\(['"]select['"]\)/);
});

test('date controller reads latest input on open and keeps independent keyboard opener and teardown', async () => {
  const controls = await read('public/controls.mjs');
  assert.match(controls, /current\s*=\s*input\?\.value\s*\?\?\s*current/);
  assert.match(controls, /returnFocus:\s*input\s*\|\|\s*trigger/);
  assert.match(controls, /event\.altKey\s*&&\s*event\.key\s*===\s*'ArrowDown'/);
  assert.match(controls, /input\?\.addEventListener\('keydown'/);
  assert.match(controls, /input\?\.removeEventListener\('keydown'/);
  assert.equal((controls.match(/destroy\(\)/g) || []).length >= 3, true);
  assert.match(controls, /removeEventListener\('click'/);
  assert.match(controls, /next \|\| '选择日期'/);
});
