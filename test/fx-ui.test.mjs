import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { formatMoney } from '../src/core.mjs';
import { normalizeSharePayload, renderShareSvg } from '../src/share.mjs';
import { createShareClient } from '../public/share-client.mjs';

// Synthetic fixtures, deliberately unrelated to actual market values.
const now = () => Date.parse('2026-09-05T12:00:00Z');
const fixture = (id = '2026-09-05-0123456789abcdef', rate = 7.123456789) => ({ id, date: '2026-09-05', source: 'https://github.com/fawazahmed0/exchange-api', rates: { CNY: 1, USD: rate, EUR: 8, GBP: 10.123456, HKD: 0.8, JPY: 0.05, SGD: 5, TWD: 0.2, AUD: 4, CAD: 5, KRW: 0.005, INR: 0.07, CHF: 11.123456, RUB: 0.08, MYR: 1.5, THB: 0.2 } });
const payload = { name: 'FX', amount: 1234.56, currency: 'USD', endAt: '2026-09-11', valuedAt: '2026-09-06', billingCycle: 'custom', customDays: 10 };
const waitable = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function withFxClient(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'vps-fx-client-'));
  try {
    await cp(new URL('../src/core.mjs', import.meta.url), path.join(dir, 'core.mjs'));
    await cp(new URL('../public/fx-client.mjs', import.meta.url), path.join(dir, 'fx-client.mjs'));
    await fn(await import(pathToFileURL(path.join(dir, 'fx-client.mjs'))));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('PNG shows only CNY remaining money while the model retains all trusted FX details', () => {
  const snapshot = fixture();
  const model = normalizeSharePayload(payload, { snapshot });
  const svg = renderShareSvg(model);
  assert.ok(svg.includes(formatMoney(model.result.remainingValue, 'CNY')));
  for (const key of ['amount', 'dailyCost']) assert.ok(!svg.includes(formatMoney(model.result[key], 'CNY')), `${key} is not on the PNG`);
  assert.match(svg, /剩余金额 · 人民币/);
  assert.doesNotMatch(svg, /US\$|USD|CNY|汇率|fawazahmed0|7\.123457/);
  assert.equal(model.amount, payload.amount);
  assert.equal(model.currency, 'USD');
  assert.equal(model.result.currency, 'CNY');
  assert.equal(model.fx.rate, snapshot.rates.USD);
  assert.equal(model.fx.date, snapshot.date);
  assert.equal(model.fx.source, snapshot.source);
  assert.equal(model.fx.snapshotId, snapshot.id);
});

test('billion GBP/CHF values shrink within a 1000px budget while cached FX remains in the model', async () => {
  for (const currency of ['GBP', 'CHF']) {
    const model = normalizeSharePayload({ ...payload, amount: 1e9, currency, customDays: 1 }, { snapshot: fixture(), stale: true });
    const svg = renderShareSvg(model);
    assert.equal(model.fx.stale, true);
    assert.equal(model.fx.rate, fixture().rates[currency]);
    assert.doesNotMatch(svg, /缓存|汇率|日均|原价/);
    const hero = svg.match(/x="72" y="325"[^>]*font-size="([\d.]+)"/);
    const size = Number(hero?.[1]);
    const money = formatMoney(model.result.remainingValue, 'CNY');
    assert.ok(size > 0 && size < 104, 'long CNY hero shrinks from 104px');
    assert.ok(money.length * size * 0.65 <= 1000, 'conservative text-width budget');
    assert.ok(svg.includes(money));
    const { data, info } = await sharp(Buffer.from(svg), { density: 216 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let left = info.width, right = -1, top = info.height, bottom = -1;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const offset = (y * info.width + x) * 4;
        if (data[offset] === 37 && data[offset + 1] === 99 && data[offset + 2] === 235) {
          left = Math.min(left, x); right = Math.max(right, x);
          top = Math.min(top, y); bottom = Math.max(bottom, y);
        }
      }
    }
    assert.ok(right >= left, 'rendered blue amount is present');
    assert.ok(left >= 72 * 3 && right < (72 + 1000) * 3, `rendered amount fits its horizontal budget: ${left}..${right}`);
    assert.ok(top > 205 * 3 && bottom < 382 * 3, 'amount stays between its label and divider');
  }
});

test('CNY PNG needs no snapshot or conversion caption', () => {
  const model = normalizeSharePayload({ ...payload, currency: 'CNY' });
  const svg = renderShareSvg(model);
  assert.match(svg, /剩余金额 · 人民币/);
  assert.ok(svg.includes(formatMoney(model.result.remainingValue, 'CNY')));
  assert.doesNotMatch(svg, /汇率|无需换算|US\$/);
  assert.equal(model.fx.rate, 1);
  assert.equal(model.fx.snapshotId, null);
});

test('UI result currency fixed CNY, shared conversion and rate states are wired into versioned graph', async () => {
  const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  const [app, html, build] = await Promise.all([read('public/app.mjs'), read('public/index.html'), read('scripts/build.mjs')]);
  assert.match(app, /convertResultToCny/);
  assert.match(app, /fxSnapshotId:/);
  assert.doesNotMatch(app, /formatMoney\([^\n]+payload\.currency/);
  assert.match(html, /id="result-currency"[^>]*>CNY · 人民币/);
  for (const id of ['fx-description', 'fx-source', 'fx-retry']) assert.ok(html.includes(`id="${id}"`));
  assert.match(app, /await fxClient\.refresh\(/);
  assert.match(build, /'fx-client\.mjs'/);
});

test('browser FX fetch is lazy, deduplicated and validates snapshot before publishing', () => withFxClient(async ({ createExchangeClient }) => {
  let calls = 0; const gate = waitable(); const changes = [];
  const client = createExchangeClient({ now, onChange: () => changes.push(client.getState()), fetcher: async (url, options) => {
    calls++; assert.equal(url, '/api/exchange-rates'); assert.equal(options.cache, 'no-store'); await gate.promise;
    return new Response(JSON.stringify({ ok: true, snapshot: fixture(), stale: false }));
  } });
  assert.equal(calls, 0); assert.equal(client.getState().snapshot, null);
  const pending = [client.refresh(), client.refresh()];
  assert.equal(client.getState().loading, true);
  gate.resolve(); await Promise.all(pending);
  assert.equal(calls, 1); assert.equal(client.getState().snapshot.rates.USD, fixture().rates.USD);
  assert.equal(client.getState().loading, false); assert.equal(changes.length, 2);
  await client.refresh(); assert.equal(calls, 1);
}));

test('browser FX failure clears old values, exposes retry and recovers without reload', () => withFxClient(async ({ createExchangeClient }) => {
  let mode = 'success', calls = 0;
  const client = createExchangeClient({ now, fetcher: async () => {
    calls++;
    if (mode === 'failure') throw new Error('offline');
    const snapshot = fixture(); if (mode === 'invalid') delete snapshot.rates.KRW;
    return new Response(JSON.stringify({ ok: true, snapshot }));
  } });
  await client.refresh(); assert.ok(client.getState().snapshot);
  for (mode of ['failure', 'invalid']) {
    await client.refresh({ force: true });
    assert.equal(client.getState().snapshot, null); assert.match(client.getState().error, /汇率/);
    const before = calls; await client.refresh(); assert.equal(calls, before, 'failure does not retry for each input');
  }
  mode = 'success'; await client.refresh({ force: true });
  assert.equal(client.getState().error, ''); assert.ok(client.getState().snapshot);
}));

test('browser FX marks prior-day data cached and refuses snapshots older than seven days', () => withFxClient(async ({ createExchangeClient }) => {
  let clock = now();
  const client = createExchangeClient({ now: () => clock, fetcher: async () => new Response(JSON.stringify({ ok: true, snapshot: fixture(), stale: false })) });
  await client.refresh(); assert.equal(client.getState().stale, false);
  clock += 86_400_000;
  assert.equal(client.getState().stale, true);
  clock += 7 * 86_400_000;
  assert.equal(client.getState().snapshot, null);
  assert.match(client.getState().error, /汇率已过期/);
}));

test('browser FX timeout fails closed and is retryable', () => withFxClient(async ({ createExchangeClient }) => {
  const client = createExchangeClient({ now, timeoutMs: 10, fetcher: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })) });
  await client.refresh();
  assert.equal(client.getState().loading, false);
  assert.equal(client.getState().snapshot, null);
  assert.match(client.getState().error, /汇率/);
}));

test('FX snapshot A→B→A increments export revision even when the amount and input currency never change', async () => {
  const gate = waitable();
  const client = createShareClient({ fetcher: async () => { await gate.promise; return new Response(JSON.stringify({ ok: true, imageUrl: '/old.png' })); } });
  const a = { ...payload, fxSnapshotId: fixture().id };
  client.setPayload(a); const pending = client.get();
  client.setPayload({ ...a, fxSnapshotId: '2026-09-05-fedcba9876543210' }); client.setPayload(a);
  gate.resolve(); await assert.rejects(pending, /信息已更新/);
});
