import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as core from '../src/core.mjs';
import { createShareClient } from '../public/share-client.mjs';

const read = (file) => readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');

test('name has a real VPS default, and transaction date stays read-only', async () => {
  const [html, app] = await Promise.all([read('index.html'), read('app.mjs')]);
  const name = html.match(/<input\b[^>]*id="name"[^>]*>/)?.[0];
  assert.match(name, /value="VPS"/);
  assert.match(name, /maxlength="80"/);
  assert.match(html, /交易日期\s*<time id="valued-label"/);
  assert.doesNotMatch(html + app, /估值日期|未命名服务器|自动使用本地今天/);
  assert.doesNotMatch(html, /<(?:input|select|button)[^>]*(?:id="valued-at"|name="valuedAt")/);
  assert.match(app, /valuedAt:\s*localToday\(/);
});

test('FX is directly visible after transaction date, with no calculation details or secondary values', async () => {
  const [html, app] = await Promise.all([read('index.html'), read('app.mjs')]);
  const card = html.match(/<article\b[^>]*id="value-card"[^>]*>([\s\S]*?)<\/article>/)?.[1];
  assert.ok(card);
  assert.doesNotMatch(html + app, /result-details|original-value|daily-cost|used-duration|billing-label|billingCycleLabel|计算详情/);
  assert.doesNotMatch(card, /<details\b|<summary\b/);
  assert.match(card, /<p class="valued-caption">交易日期 <time id="valued-label">—<\/time><\/p>\s*<p class="fx-caption" aria-live="polite">/);
  for (const id of ['fx-description', 'fx-source', 'fx-retry']) {
    assert.ok(card.includes(`id="${id}"`), `${id} stays directly visible`);
    assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1, `${id} stays uniquely bound`);
  }
  for (const id of ['result-name', 'result-currency', 'remaining-value', 'timeline-progress', 'end-label', 'remaining-duration', 'valued-label']) assert.ok(card.includes(`id="${id}"`), `${id} remains visible`);
  assert.doesNotMatch(card, /server-icon|server-identity|currency-badge|<svg\b/);
  assert.equal([...card.matchAll(/>VPS</g)].length, 1, 'only the actual default name, no repeated VPS identifier');
});

test('result styling uses open space, a thin track and accessible direct FX controls without dead detail styles', async () => {
  const css = await read('styles.css');
  const rule = (selector) => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
  const card = rule('.value-card');
  assert.match(card, /padding:\s*0/);
  assert.doesNotMatch(card, /(?:border(?:-radius)?|box-shadow|background):/);
  assert.doesNotMatch(css, /\.value-card::|\.server-icon|\.server-identity|\.currency-badge|\.metrics\b|\.metric\b|\.value-card-top|\.date-labels/);
  assert.match(rule('.hero-value strong'), /max-width:\s*100%/);
  assert.match(rule('.hero-value strong'), /overflow-wrap:\s*anywhere/);
  assert.match(rule('.hero-value strong.is-long'), /clamp\(/);
  assert.match(rule('.track'), /height:\s*[4-6]px/);
  assert.doesNotMatch(rule('.track'), /border:\s*1px/);
  assert.doesNotMatch(css, /\.result-details|\.original-value|\.calculation-facts/);
  assert.match(rule('.fx-caption'), /color:\s*var\(--muted\)/);
  assert.match(rule('.fx-caption a'), /text-decoration:\s*underline/);
  assert.match(rule('#fx-retry'), /min-height:\s*44px/);
  assert.match(rule('#fx-retry:focus-visible'), /outline:/);
  assert.match(rule('.result-facts'), /repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
});

test('long result names use a bounded single-line ellipsis instead of wrapping', async () => {
  const css = await read('styles.css');
  const name = css.match(/#result-name\s*\{([^}]*)\}/)?.[1];
  assert.ok(name, 'result name has an explicit CSS rule');
  const declarations = Object.fromEntries(name.split(';').filter((entry) => entry.trim()).map((entry) => entry.split(':').map((part) => part.trim())));
  for (const [property, value] of Object.entries({
    display: 'block', 'min-width': '0', 'max-width': '100%',
    overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap',
  })) assert.equal(declarations[property], value, `result name ${property}`);
  assert.doesNotMatch(name, /(?:overflow-wrap|word-break)\s*:/, 'no conflicting multiline wrapping');
});

// Run the real app controller with minimal DOM ports; arithmetic and share client
// are real modules. FX state is controlled here to isolate visible rate states.
async function appHarness() {
  const [html, source] = await Promise.all([read('index.html'), read('app.mjs')]);
  const elements = new Map([...html.matchAll(/<[^/!][^>]*\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => [id, {
    value: tag.match(/\bvalue="([^"]*)"/)?.[1] ?? '', textContent: '', title: '', style: {},
    hidden: /\shidden(?:\s|>)/.test(tag), open: /\sopen(?:\s|>)/.test(tag), disabled: false,
    lastChild: { textContent: '' }, classList: { toggle() {}, add() {}, remove() {} },
    attributes: {}, listeners: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(key, callback) { this.listeners[key] = callback; },
  }]));
  const state = { snapshot: null, loading: false, error: '', stale: false };
  const retries = [];
  const context = vm.createContext({
    ...core, localToday: () => '2026-01-16', createShareClient,
    createExchangeClient: () => ({ getState: () => state, refresh: async (options) => { retries.push(options); return state; } }),
    createCustomControls: (fields) => { fields.currency.value = 'CNY'; fields.billingCycle.value = 'custom'; fields.customDays.value = '30'; fields.endAt.value = '2026-01-31'; },
    document: { querySelector: (selector) => elements.get(selector.slice(1)), addEventListener() {} },
    window: { addEventListener() {} }, setTimeout() {}, clearTimeout() {},
  });
  vm.runInContext(source.replace(/^import .*;\n/gm, ''), context);
  return { elements, state, retries, context, get: (id) => elements.get(id) };
}

test('real controller preserves VPS fallback, custom names, CNY money, plain expiry and local transaction date', async () => {
  const { get, context } = await appHarness();
  assert.equal(get('result-name').textContent, 'VPS');
  get('name').value = '   ';
  context.updateResult();
  assert.equal(get('result-name').textContent, 'VPS', 'empty-state fallback');
  get('amount').value = '120';
  context.updateResult();
  assert.equal(context.readPayload().name, 'VPS', 'export fallback');
  assert.equal(get('result-name').textContent, 'VPS');
  assert.equal(get('remaining-value').textContent, '¥60.00');
  assert.equal(get('remaining-duration').textContent, '15 天');
  assert.equal(get('remaining-percent').textContent, '50.00% 剩余');
  assert.equal(get('timeline-progress').style.width, '50.0000%');
  assert.equal(get('end-label').textContent, '2026-01-31');
  assert.equal(get('valued-label').textContent, '2026-01-16');
  assert.equal(context.readPayload().valuedAt, '2026-01-16');
  get('name').value = '  Tokyo   Custom  ';
  context.updateResult();
  assert.equal(get('result-name').textContent, 'Tokyo Custom');
  get('name').value = '长'.repeat(80);
  context.updateResult();
  assert.equal(get('name').value, '长'.repeat(80), 'full input name is preserved');
  assert.equal(get('result-name').textContent, '长'.repeat(80), 'ellipsis does not truncate the DOM name');
  assert.equal(get('result-name').title, '长'.repeat(80), 'title exposes the full name');
  assert.equal(context.readPayload().name, '长'.repeat(80), 'full model name is preserved');
  assert.equal(get('download-png').disabled, false);
  get('name').value += '长';
  context.updateResult();
  assert.match(get('form-error').textContent, /80/);
  assert.equal(get('download-png').disabled, true);
});

test('direct FX caption preserves failure, retry, loading, source, cached recovery and CNY independence', async () => {
  const { get, context, state, retries } = await appHarness();
  assert.equal(get('result-details'), undefined, 'no disclosure is needed to see FX');
  assert.equal(get('fx-description').textContent, '人民币 · 无需换算');
  assert.equal(get('fx-source').hidden, true);
  get('currency').value = 'USD';
  state.error = '汇率暂不可用，请重试';
  context.updateResult();
  assert.equal(get('fx-retry').hidden, false);
  assert.equal(get('fx-retry').disabled, false);
  assert.match(get('fx-description').textContent, /汇率暂不可用/);
  get('amount').value = '120';
  context.updateResult();
  assert.equal(get('download-png').disabled, true);
  for (const id of ['remaining-value', 'remaining-duration', 'remaining-percent', 'end-label']) assert.equal(get(id).textContent, '—', `${id} is cleared on FX failure`);
  assert.equal(get('timeline-progress').style.width, '0%');
  get('fx-retry').listeners.click();
  assert.equal(retries.length, 1);
  assert.equal(retries[0].force, true);
  state.error = ''; state.loading = true;
  context.updateResult();
  assert.match(get('fx-description').textContent, /正在获取/);
  assert.equal(get('fx-retry').disabled, true);
  assert.equal(get('fx-source').hidden, true);
  assert.equal(get('download-png').disabled, true);
  state.loading = false;
  state.snapshot = { id: 'fixture', rates: { CNY: 1, USD: 7.25 }, date: '2026-01-16' };
  context.updateResult();
  assert.equal(get('remaining-value').textContent, '¥435.00');
  assert.equal(get('download-png').disabled, false);
  assert.equal(get('fx-retry').hidden, true);
  assert.equal(get('fx-source').hidden, false);
  assert.match(get('fx-description').textContent, /1 USD = ¥7\.250000 · 汇率日期 2026-01-16 · 参考汇率/);
  assert.equal(context.readPayload().fxSnapshotId, 'fixture');
  state.stale = true;
  context.updateResult();
  assert.match(get('fx-description').textContent, /缓存参考汇率/);
  state.error = '汇率不可用'; get('currency').value = 'CNY';
  context.updateResult();
  assert.equal(get('remaining-value').textContent, '¥60.00');
  assert.equal(get('download-png').disabled, false);
  assert.equal(get('fx-description').textContent, '人民币 · 无需换算');
  assert.equal(get('fx-retry').hidden, true);
  assert.equal(get('fx-source').hidden, true);
  get('amount').value = '';
  context.updateResult();
  assert.equal(get('remaining-value').textContent, '—');
  assert.equal(get('download-png').disabled, true);
});

test('empty expiry blocks amount-only exports; manually selecting today yields zero without rewriting dates', async () => {
  const { get, context } = await appHarness();
  get('end-at').value = '';
  get('billing-cycle').value = 'annual';
  get('amount').value = '120';
  context.updateResult();
  assert.equal(get('end-at').value, '', 'amount entry does not fill expiry');
  assert.equal(get('form-error').textContent, '请选择到期日');
  assert.equal(get('end-at').attributes['aria-invalid'], 'true');
  assert.equal(get('remaining-value').textContent, '—');
  for (const id of ['download-png', 'create-link', 'copy-markdown']) assert.equal(get(id).disabled, true);
  get('end-at').value = '2026-01-16';
  context.updateResult();
  assert.equal(get('remaining-value').textContent, '¥0.00');
  assert.equal(get('remaining-duration').textContent, '0 天');
  assert.equal(get('remaining-percent').textContent, '0.00% 剩余');
  assert.equal(get('timeline-progress').style.width, '0.0000%');
  assert.equal(get('download-png').disabled, false);
  assert.equal(get('end-at').value, '2026-01-16');
  assert.equal(context.readPayload().valuedAt, '2026-01-16');
});
