import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import * as core from '../src/core.mjs';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

async function withAdapter(fn) {
  const source = new URL('../public/control-adapter.mjs', import.meta.url);
  assert.ok(await access(source).then(() => true, () => false), 'a small capability adapter must exist');
  const dir = await mkdtemp(path.join(tmpdir(), 'vps-adapter-'));
  try {
    for (const name of ['controls.mjs', 'control-adapter.mjs']) await cp(new URL(`../public/${name}`, import.meta.url), path.join(dir, name));
    await cp(new URL('../src/core.mjs', import.meta.url), path.join(dir, 'core.mjs'));
    await fn(await import(pathToFileURL(path.join(dir, 'control-adapter.mjs'))));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('native control preference uses primary coarse pointer AND no hover, never width or user agent', () => withAdapter(({ nativeControlPreference }) => {
  for (const pointer of ['coarse', 'fine']) for (const hover of ['none', 'hover']) {
    const mql = { matches: pointer === 'coarse' && hover === 'none' };
    assert.equal(nativeControlPreference((query) => {
      assert.equal(query, '(pointer: coarse) and (hover: none)');
      return mql;
    }), mql);
  }
}));

test('date mode preserves empty values, invalid drafts and explicit manual intent', () => withAdapter(({ dateInputType }) => {
  assert.equal(typeof dateInputType, 'function', 'adapter needs a date type policy that never discards drafts');
  for (const value of ['', '2028-02-29', '0001-01-01', '9999-12-31']) {
    assert.equal(dateInputType(true, false, value), 'date', value);
    assert.equal(dateInputType(true, true, value), 'text', 'manual intent survives valid values');
    assert.equal(dateInputType(false, false, value), 'text', 'desktop is always editable');
  }
  for (const value of ['2028-', '2026-02-30', '2026-2-03', '0000-01-01', '10000-01-01', '2028-02-29T12:00', ' 2028-02-29', 'bad']) {
    assert.equal(dateInputType(true, false, value), 'text', `do not lose ${value} to native sanitization`);
  }
}));

test('expiry defaults to local today in both modes and never replaces subsequent user drafts', async () => {
  const source = await read('public/control-adapter.mjs');
  for (const native of [false, true]) {
    const element = () => ({
      value: '', attributes: {}, listeners: {}, classList: { add() {} },
      setAttribute(key, value) { this.attributes[key] = value; if (key === 'id') this.id = value; },
      hasAttribute(key) { return key in this.attributes; },
      getAttribute(key) { return this.attributes[key]; },
      addEventListener(key, fn) { this.listeners[key] = fn; },
      removeEventListener(key) { delete this.listeners[key]; },
      append() {}, replaceWith() {}, focus() {},
    });
    const fields = Object.fromEntries(['currency', 'billingCycle', 'endAt'].map((key) => [key, element()]));
    const ports = new Map(['#end-at-picker', '#end-at-mode', '#end-at-control'].map((id) => [id, element()]));
    let changeMode;
    const preference = { matches: native, addEventListener: (_, fn) => { changeMode = fn; }, removeEventListener() {} };
    const context = vm.createContext({
      ...core,
      window: { matchMedia: () => preference },
      document: { querySelector: (selector) => ports.get(selector), createElement: element, documentElement: { dataset: {} } },
      createSelect: () => ({ destroy() {} }), createDatePicker: () => ({ destroy() {} }),
    });
    vm.runInContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''), context);
    const today = core.localToday();
    const controls = context.createAdaptiveControls(fields);
    assert.equal(fields.endAt.value, today, `${native ? 'native' : 'desktop'} expiry starts with local today`);
    assert.equal(fields.billingCycle.value, 'annual');
    assert.equal(fields.currency.value, 'CNY');
    preference.matches = !preference.matches;
    changeMode();
    assert.equal(fields.endAt.value, today, 'initial local-today expiry survives mode change');
    for (const draft of ['2028-02-29', '', '2028-']) {
      fields.endAt.value = draft;
      preference.matches = !preference.matches;
      changeMode();
      assert.equal(fields.endAt.value, draft, 'mode changes preserve user input, including empty and invalid drafts');
    }
    controls.destroy();
  }
});

test('date controller reads latest input on open and supports a separate keyboard opener', async () => {
  const controls = await read('public/controls.mjs');
  assert.match(controls, /current\s*=\s*input\?\.value\s*\?\?\s*current/);
  assert.match(controls, /returnFocus:\s*input\s*\|\|\s*trigger/);
  assert.match(controls, /event\.altKey\s*&&\s*event\.key\s*===\s*'ArrowDown'/);
  assert.match(controls, /input\?\.addEventListener\('keydown'/);
  assert.match(controls, /input\?\.removeEventListener\('keydown'/);
});

test('adapter mounts actual native fields with full date range and reuses desktop controls', async () => {
  const adapter = await read('public/control-adapter.mjs').catch(() => '');
  assert.match(adapter, /createElement\(['"]select['"]\)/);
  assert.match(adapter, /createElement\(['"]input['"]\)/);
  assert.match(adapter, /\.type\s*=\s*['"]date['"]/);
  assert.match(adapter, /0001-01-01/);
  assert.match(adapter, /9999-12-31/);
  assert.match(adapter, /from '\.\/controls.mjs'/);
  assert.match(adapter, /createSelect/);
  assert.match(adapter, /createDatePicker/);
  assert.match(adapter, /replaceWith/);
  assert.match(adapter, /destroy/);
  assert.match(adapter, /addEventListener\('change'/);
  assert.match(adapter, /removeEventListener\('change'/);
  assert.doesNotMatch(adapter, /showPicker|innerWidth|userAgent|max-width|min-width|any-pointer/);
  const app = await read('public/app.mjs');
  assert.match(app, /createAdaptiveControls\(fields/);
});

test('desktop controllers have teardown and empty dates remain unselected', async () => {
  const controls = await read('public/controls.mjs');
  assert.equal((controls.match(/destroy\(\)/g) || []).length >= 3, true, 'popover and both controllers must clean up');
  assert.match(controls, /removeEventListener\('click'/);
  assert.match(controls, /removeEventListener\('keydown'/);
  assert.match(controls, /next \|\| '选择日期'/);
});

test('native fields retain 44px hit areas, iOS-safe fonts and date intrinsic-width guards', async () => {
  const css = await read('public/styles.css');
  assert.match(css, /\.native-control\s*\{[^}]*font-size:\s*16px/s);
  assert.match(css, /\.native-control\s*\{[^}]*min-width:\s*0/s);
  assert.match(css, /\.native-control\s*\{[^}]*max-width:\s*100%/s);
  assert.match(css, /\.native-control\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /::-webkit-date-and-time-value/);
  assert.match(css, /::-webkit-datetime-edit/);
  assert.match(css, /#currency-popover\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
});
