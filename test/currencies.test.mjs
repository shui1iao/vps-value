import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as core from '../src/core.mjs';
import { normalizeSharePayload, renderShareSvg } from '../src/share.mjs';
import { createAppServer } from '../server.mjs';
import { createExchangeRateService } from '../src/exchange-rates.mjs';

const currencies = ['CNY', 'USD', 'EUR', 'GBP', 'HKD', 'JPY', 'SGD', 'TWD', 'AUD', 'CAD', 'KRW', 'INR', 'CHF', 'RUB', 'MYR', 'THB'];
const payload = { name: '常见币种', amount: 1234.56, currency: 'CNY', endAt: '2026-01-11', valuedAt: '2026-01-06', billingCycle: 'custom', customDays: 10 };
// Synthetic rates for deterministic tests, never used as actual market evidence.
const snapshot = { id: '2026-09-05-0123456789abcdef', date: '2026-09-05', source: core.FX_SOURCE, rates: Object.fromEntries(currencies.map((c, i) => [c, i + 1])) };

test('shared allowlist has exactly 16 unique currencies in requested order, each with a Chinese name', () => {
  assert.deepEqual(core.CURRENCIES, currencies);
  assert.equal(new Set(core.CURRENCIES).size, 16);
  assert.ok(Object.isFrozen(core.CURRENCIES));
  assert.deepEqual(Object.keys(core.CURRENCY_NAMES), currencies);
  for (const currency of currencies) {
    assert.match(core.CURRENCY_NAMES[currency], /\p{Script=Han}/u);
    assert.equal(core.normalizeCurrency(currency.toLowerCase()), currency);
    assert.equal(core.calculateResidualValue({ ...payload, currency }).remainingValue, 617.28);
  }
  assert.throws(() => core.normalizeCurrency('BTC'), /币种/);
});

test('generic formatter retains Intl input precision; every result including JPY/KRW is converted and formatted in CNY', () => {
  assert.equal(typeof core.formatMoney, 'function');
  for (const currency of currencies) {
    const expected = new Intl.NumberFormat('zh-CN', { style: 'currency', currency });
    assert.equal(expected.resolvedOptions().maximumFractionDigits, ['JPY', 'KRW'].includes(currency) ? 0 : 2);
    for (const amount of [0, 0.125, 1234.56, 1_000_000_000]) assert.equal(core.formatMoney(amount, currency), expected.format(amount));
    const model = normalizeSharePayload({ ...payload, currency }, { snapshot });
    const svg = renderShareSvg(model);
    assert.ok(svg.includes(core.formatMoney(model.result.remainingValue, 'CNY')), `PNG converts ${currency} to the shared CNY format`);
    for (const amount of [model.result.remainingValue, model.result.amount, model.result.dailyCost]) {
      assert.match(core.formatMoney(amount, 'CNY'), /\.\d{2}$/);
    }
    assert.doesNotMatch(svg, /undefined|NaN/);
  }
  assert.throws(() => core.formatMoney(1, 'BTC'), /币种/);
});

test('browser and PNG import rather than duplicate money formatting', async () => {
  for (const file of ['public/app.mjs', 'src/share.mjs']) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /import\s*\{[^}]*formatMoney[^}]*\}\s*from '\.\/core.mjs'/);
    assert.doesNotMatch(source, /new Intl.NumberFormat|function formatAmount|function formatMoney|const CURRENCY_LABELS/);
  }
});

test('real API supports every input currency and serves each PNG with trusted CNY conversion', async () => {
  const storageDir = await mkdtemp(path.join(tmpdir(), 'vps-currencies-'));
  const exchangeRates = createExchangeRateService({ storageDir, now: () => Date.parse('2026-09-05T12:00:00Z'), fetcher: async () => new Response(JSON.stringify({ date: snapshot.date, cny: Object.fromEntries(currencies.map((c) => [c.toLowerCase(), 1 / snapshot.rates[c]])) })) });
  const server = createAppServer({ publicDir: path.resolve('public'), storageDir, exchangeRates, rateLimit: { max: 20 } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { snapshot: trusted } = await (await fetch(`${base}/api/exchange-rates`)).json();
    for (const currency of currencies) {
      const response = await fetch(`${base}/api/shares`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, currency, fxSnapshotId: trusted.id }),
      });
      const body = await response.json();
      assert.equal(response.status, 201, `${currency}: ${JSON.stringify(body)}`);
      assert.equal(body.result.remainingValue, 617.28 * trusted.rates[currency]);
      assert.equal(body.result.currency, 'CNY');
      const image = await fetch(body.imageUrl);
      assert.equal(image.status, 200);
      assert.equal(image.headers.get('content-type'), 'image/png');
      const png = Buffer.from(await image.arrayBuffer());
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(png.readUInt32BE(16), 3600);
      assert.equal(png.readUInt32BE(20), 1890);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(storageDir, { recursive: true, force: true });
  }
});
