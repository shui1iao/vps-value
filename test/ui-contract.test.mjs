import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (file) => readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');

test('only date and billing inputs remain; all devices use accessible custom controls', async () => {
  const html = await read('index.html');
  assert.doesNotMatch(html, /datetime-local|start-at|valued-at|use-now|精确到时|小时/);
  for (const id of ['currency', 'billing-cycle']) {
    assert.match(html, new RegExp(`<button[^>]+id="${id}"[^>]+aria-haspopup="(?:listbox|dialog)"[^>]+aria-expanded="false"`));
  }
  assert.match(html, /<input[^>]+id="end-at"[^>]+type="text"[^>]+placeholder="YYYY-MM-DD"/);
  assert.match(html, /<button[^>]+id="end-at-picker"[^>]+type="button"[^>]+aria-label="选择到期日"[^>]+aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /end-at-mode|<select\b|type="date"/);
  assert.match(html, /id="custom-days"[^>]+min="1"[^>]+max="36500"[^>]+step="1"/);
  assert.match(html, /到期当天按 0 天计算/);
  assert.match(html, /账单周期天数/);
});

test('expanded surfaces are solid viewport-safe portals with keyboard controls', async () => {
  const [css, controls] = await Promise.all([read('styles.css'), read('controls.mjs')]);
  assert.match(css, /\.control-popover\s*\{[^}]*position:\s*fixed[^}]*border:\s*1px solid var\(--border\)[^}]*background:\s*var\(--page-surface\)/s);
  assert.match(css, /\.control-option[^}]*min-height:\s*40px/s);
  assert.match(css, /\[aria-selected="true"\]/);
  assert.match(controls, /document\.body\.append/);
  assert.match(controls, /showPopover/);
  for (const key of ['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' ', 'PageUp', 'PageDown']) assert.ok(controls.includes(`'${key}'`), key);
  assert.match(controls, /pointerdown/);
  assert.match(controls, /\.focus\(/);
  assert.match(controls, /data-month|dataset\.month/);
  assert.match(controls, /data-year|dataset\.year/);
});

test('adjacent-month calendar dates stay muted without reduced opacity', async () => {
  const css = await read('styles.css');
  const rule = css.match(/\.calendar-day\.is-outside\s*\{([^}]*)\}/)?.[1];
  assert.ok(rule, 'adjacent-month styling exists');
  assert.match(rule, /color:\s*var\(--muted\)/);
  const opacity = rule.match(/(?:^|;)\s*opacity:\s*([^;]+)/)?.[1] ?? '1';
  assert.equal(Number(opacity), 1, 'interactive adjacent-month dates are fully opaque');
});

test('valuation auto-refreshes on day change and exports use a payload snapshot', async () => {
  const app = await read('app.mjs');
  assert.match(app, /valuedAt:\s*localToday\(/);
  assert.match(app, /visibilitychange/);
  assert.match(app, /addEventListener\('focus'/);
  assert.match(app, /setTimeout\(refreshToday/);
  assert.match(app, /share\.payload\.name/);
  assert.doesNotMatch(app, /startAt|startMs|elapsedMs|remainingMs|valuedMs|toISOString/);
});

test('page exposes only the calculator and the three requested exports', async () => {
  const html = await read('index.html');
  assert.match(html, /VPS 剩余价值/);
  assert.match(html, /id="download-png"/);
  assert.match(html, /id="create-link"/);
  assert.match(html, /id="copy-markdown"/);
  assert.doesNotMatch(html, /AI|登录|注册/);
  assert.match(html, /汇率来源/);
});

test('form controls have explicit labels and accessible status regions', async () => {
  const html = await read('index.html');
  for (const id of ['name', 'amount', 'currency', 'end-at', 'billing-cycle', 'custom-days']) {
    assert.match(html, new RegExp(`<label[^>]+for="${id}"`));
  }
  assert.match(html, /id="form-error"[^>]+role="alert"/);
  assert.match(html, /id="toast"[^>]+role="status"/);
});

test('Zeno visual contract and mobile overflow guards are present', async () => {
  const css = await read('styles.css');
  assert.match(css, /--background:\s*#f5f6f8/);
  assert.match(css, /--page-surface:\s*#fff/);
  assert.match(css, /--blue:\s*#2563eb/);
  assert.doesNotMatch(css, /--radius-card:|--shadow-card:/, 'removed inner-card tokens do not linger');
  assert.match(css, /--radius-panel:\s*20px/);
  assert.match(css, /max-width:\s*1024px/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.match(css, /min-width:\s*0/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /prefers-color-scheme:\s*dark/);
});

test('the live timeline uses the remaining ratio without semantic ambiguity', async () => {
  const [html, app] = await Promise.all([read('index.html'), read('app.mjs')]);
  assert.match(html, /<span>剩余周期<\/span>/);
  assert.match(app, /result\.remainingRatio \* 100/);
});

test('desktop form keeps date and currency controls readable', async () => {
  const css = await read('styles.css');
  assert.match(css, /#calculator\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /\.amount-control\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+108px/s);
});

test('desktop outer panels are equal grid tracks and stretch, mobile remains natural height', async () => {
  const css = await read('styles.css');
  const workspace = css.match(/\.workspace\s*\{([^}]*)\}/)?.[1];
  assert.match(workspace, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(workspace, /align-items:\s*stretch/);
  assert.match(css, /@media\s*\(max-width:\s*800px\)[\s\S]*?\.workspace\s*\{[^}]*grid-template-columns:\s*1fr[^}]*align-items:\s*start/);
});

test('custom currency options expose full Chinese descriptions without clipping on every device', async () => {
  const [adapter, controls, css] = await Promise.all([read('control-adapter.mjs'), read('controls.mjs'), read('styles.css')]);
  assert.match(adapter, /description:\s*CURRENCY_NAMES\[value\]/);
  assert.match(controls, /textContent\s*=\s*option\.description/);
  const rule = css.match(/#currency-popover\s+\.control-option\s*>\s*span\s*\{([^}]*)\}/)?.[1];
  assert.ok(rule, 'currency labels override the generic single-line option');
  assert.match(rule, /white-space:\s*normal/);
  assert.match(rule, /overflow:\s*visible/);
  assert.doesNotMatch(rule, /ellipsis/);
});

test('invalid typed expiry is parsed before amount validation and marked invalid', async () => {
  const app = await read('app.mjs');
  const parse = app.indexOf('parseDateOnly(fields.endAt.value)');
  assert.ok(parse > 0 && parse < app.indexOf('if (!fields.amount.value)'));
  assert.match(app, /setAttribute\('aria-invalid', 'true'\)/);
  assert.match(app, /YYYY-MM-DD/);
});

test('empty expiry is validated before the untouched amount short-circuit', async () => {
  const app = await read('app.mjs');
  const expiryGuard = app.indexOf("if (!fields.endAt.value)");
  assert.ok(expiryGuard >= 0 && expiryGuard < app.indexOf('if (!fields.amount.value)'));
  assert.match(app, /resetResult\('请选择到期日'\)/);
});

test('copying has a restricted-browser fallback and friendly failure copy', async () => {
  const app = await read('app.mjs');
  assert.match(app, /document\.execCommand\('copy'\)/);
  assert.match(app, /复制失败，请长按复制/);
  assert.doesNotMatch(app, /showToast\(error\.message\)/);
});
