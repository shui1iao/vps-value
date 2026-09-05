import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as core from '../src/core.mjs';
import { createAppServer } from '../server.mjs';

// Deliberately synthetic unit fixtures; not market-rate evidence.
const nowMs = Date.parse('2026-09-05T12:00:00Z');
const raw = () => ({ date: '2026-09-05', cny: Object.fromEntries(core.CURRENCIES.map((c, i) => [c.toLowerCase(), c === 'CNY' ? 1 : (i + 1) / 10])) });
const response = (data = raw()) => new Response(JSON.stringify(data), { status: 200 });
const payload = { name: 'FX', amount: 1234.56, currency: 'USD', endAt: '2026-09-11', valuedAt: '2026-09-06', billingCycle: 'custom', customDays: 10 };
const snapshotFixture = () => ({ id: '2026-09-05-0123456789abcdef', date: '2026-09-05', source: 'https://github.com/fawazahmed0/exchange-api', rates: Object.fromEntries(core.CURRENCIES.map((c, i) => [c, c === 'CNY' ? 1 : 1 / ((i + 1) / 10)])) });

async function withService(fn, options = {}) {
  const storageDir = await mkdtemp(path.join(tmpdir(), 'vps-fx-'));
  try {
    const { createExchangeRateService } = await import('../src/exchange-rates.mjs');
    const service = createExchangeRateService({ storageDir, fetcher: async () => response(), now: () => nowMs, ...options });
    await fn(service, storageDir, createExchangeRateService);
  } finally { await rm(storageDir, { recursive: true, force: true }); }
}

test('CNY conversion exists, preserves civil-day arithmetic and converts every monetary field for all 16 currencies', () => {
  assert.equal(typeof core.convertResultToCny, 'function', 'missing shared CNY converter');
  const snapshot = snapshotFixture();
  for (const currency of core.CURRENCIES) {
    const input = core.calculateResidualValue({ ...payload, currency });
    const result = core.convertResultToCny(input, currency, snapshot);
    assert.equal(result.currency, 'CNY');
    for (const key of ['amount', 'dailyCost', 'remainingValue']) assert.equal(result[key], input[key] * snapshot.rates[currency]);
    for (const key of ['totalDays', 'remainingDays', 'elapsedDays', 'remainingRatio', 'usedRatio']) assert.equal(result[key], input[key]);
    assert.equal(input.amount, payload.amount);
    assert.ok(Object.isFrozen(result));
    assert.match(core.formatMoney(result.remainingValue, result.currency), /\.\d{2}$/);
  }
});

test('CNY is offline identity; foreign missing/nonfinite/zero/negative rates fail closed', () => {
  assert.equal(typeof core.convertResultToCny, 'function');
  const input = core.calculateResidualValue(payload);
  assert.equal(core.convertResultToCny(input, 'CNY').amount, payload.amount);
  assert.throws(() => core.convertResultToCny(input, 'USD'), /汇率/);
  for (const rate of [undefined, 0, -1, Infinity, NaN, '5']) {
    assert.throws(() => core.convertResultToCny(input, 'USD', { rates: { USD: rate } }), /汇率/);
  }
});

test('fixed upstream fallback, inversion, no-store API snapshot shape and atomic disk persistence', async () => {
  const calls = [];
  await withService(async (service, storageDir) => {
    const latest = await service.getLatest();
    assert.equal(latest.snapshot.rates.USD, 5);
    assert.equal(latest.snapshot.rates.CNY, 1);
    assert.equal(latest.stale, false);
    assert.match(latest.snapshot.id, /^2026-09-05-[a-f0-9]{16}$/);
    assert.equal(latest.snapshot.source, 'https://github.com/fawazahmed0/exchange-api');
    assert.deepEqual(Object.keys(latest.snapshot.rates), core.CURRENCIES);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].startsWith('https://cdn.jsdelivr.net/'));
    assert.ok(calls[1].startsWith('https://latest.currency-api.pages.dev/'));
    assert.deepEqual(await service.getById(latest.snapshot.id), latest);
    const disk = JSON.parse(await readFile(path.join(storageDir, '.fx-cache.json'), 'utf8'));
    assert.equal(disk.snapshots.length, 1);
    assert.equal(disk.snapshots[0].id, latest.snapshot.id);
    assert.deepEqual(await readdir(storageDir), ['.fx-cache.json']);
  }, { fetcher: async (url, options) => { calls.push(url); assert.ok(options.signal); if (calls.length === 1) throw new Error('network down'); return response(); } });
});

test('older primary mirror checks fallback for a newer date, but remains usable if fallback fails', async () => {
  for (const fallbackFails of [false, true]) {
    let calls = 0;
    await withService(async (service) => {
      const latest = await service.getLatest();
      assert.equal(calls, 2, 'stale-date primary must not skip the second mirror');
      assert.equal(latest.snapshot.date, fallbackFails ? '2026-09-04' : '2026-09-05');
      assert.equal(latest.stale, fallbackFails);
    }, { fetcher: async () => {
      calls++;
      if (calls === 1) { const d = raw(); d.date = '2026-09-04'; return response(d); }
      if (fallbackFails) throw new Error('offline');
      return response();
    } });
  }
});

test('same-process requests singleflight; fresh cache prevents fetch per keystroke; failed refresh backs off', async () => {
  let clock = nowMs, calls = 0, fail = false;
  await withService(async (service) => {
    const initial = await Promise.all(Array.from({ length: 20 }, () => service.getLatest()));
    assert.equal(calls, 1);
    assert.equal(new Set(initial.map((s) => s.snapshot.id)).size, 1);
    await service.getLatest(); assert.equal(calls, 1);
    clock += 3_600_001; fail = true;
    const cached = await service.getLatest();
    assert.equal(cached.stale, true);
    assert.equal(calls, 3);
    await service.getLatest(); assert.equal(calls, 3);
    clock += 60_001;
    await service.getLatest(); assert.equal(calls, 5);
  }, { now: () => clock, fetcher: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); if (fail) throw new Error('offline'); return response(); } });
});

test('trusted cached snapshots survive restart offline; unknown and expired IDs return 409', async () => {
  await withService(async (service, storageDir, factory) => {
    const latest = await service.getLatest();
    let clock = nowMs + 86_400_000;
    const restarted = factory({ storageDir, now: () => clock, fetcher: async () => { throw new Error('offline'); } });
    const cached = await restarted.getLatest();
    assert.deepEqual(cached.snapshot, latest.snapshot);
    assert.equal(cached.stale, true);
    for (const id of [null, 'unknown', { id: latest.snapshot.id }]) await assert.rejects(restarted.getById(id), { statusCode: 409 });
    clock += 7 * 86_400_000;
    await assert.rejects(restarted.getById(latest.snapshot.id), { statusCode: 409 });
    await assert.rejects(restarted.getLatest(), { statusCode: 503 });
  });
});

test('invalid upstream dates, incomplete currencies and unsafe rates never become trusted snapshots', async () => {
  const invalids = [
    (d) => { d.date = '2026-09-06'; }, (d) => { d.date = '2026-08-01'; }, (d) => { d.date = '2026-02-30'; },
    (d) => { delete d.cny.usd; }, (d) => { d.cny.cny = 2; }, (d) => { d.cny.usd = 0; },
    (d) => { d.cny.jpy = -1; }, (d) => { d.cny.krw = '1'; }, (d) => { d.cny.usd = 1e-320; },
  ];
  for (const mutate of invalids) {
    const data = raw(); mutate(data);
    await withService(async (service) => { await assert.rejects(service.getLatest(), { statusCode: 503 }); }, { fetcher: async () => response(data) });
  }
});

test('corrupted persistent snapshots fail closed instead of accepting client-editable hashes', async () => {
  await withService(async (service, storageDir, factory) => {
    const latest = await service.getLatest();
    const filename = path.join(storageDir, '.fx-cache.json');
    const disk = JSON.parse(await readFile(filename, 'utf8'));
    disk.snapshots[0].rates.USD = 999;
    await writeFile(filename, JSON.stringify(disk));
    const restarted = factory({ storageDir, now: () => nowMs, fetcher: async () => { throw new Error('offline'); } });
    await assert.rejects(restarted.getById(latest.snapshot.id), { statusCode: 409 });
    await assert.rejects(restarted.getLatest(), { statusCode: 503 });
  });
});

test('same-date changed rates have distinct IDs; cache retains at most 8 and never silently substitutes snapshots', async () => {
  let clock = nowMs, value = 0.2;
  await withService(async (service, storageDir) => {
    const ids = [];
    for (let i = 0; i < 10; i++) { ids.push((await service.getLatest()).snapshot.id); value += 0.001; clock += 10; }
    assert.equal(new Set(ids).size, 10);
    const disk = JSON.parse(await readFile(path.join(storageDir, '.fx-cache.json'), 'utf8'));
    assert.equal(disk.snapshots.length, 8);
    await assert.rejects(service.getById(ids[0]), { statusCode: 409 });
    assert.equal((await service.getById(ids[9])).snapshot.id, ids[9]);
  }, { now: () => clock, refreshMs: 1, fetcher: async () => { const d = raw(); d.cny.usd = value; return response(d); } });
});

test('real HTTP foreign shares require server snapshot, ignore forged fields and expose matching CNY result/metadata', async () => {
  await withService(async (service, storageDir) => {
    const server = createAppServer({ publicDir: path.resolve('public'), storageDir, exchangeRates: service, rateLimit: { max: 30 } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (data) => fetch(`${base}/api/shares`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    try {
      const ratesResponse = await fetch(`${base}/api/exchange-rates`);
      assert.equal(ratesResponse.status, 200);
      assert.equal(ratesResponse.headers.get('cache-control'), 'no-store');
      const rates = await ratesResponse.json();
      for (const fxSnapshotId of [undefined, 'unknown']) assert.equal((await post({ ...payload, fxSnapshotId, rate: 999 })).status, 409);
      for (const currency of core.CURRENCIES) {
        const forged = { ...payload, currency, fxSnapshotId: rates.snapshot.id, rate: 999, date: '9999-01-01', rates: { [currency]: 999 }, result: { remainingValue: 999999 }, snapshot: snapshotFixture() };
        const res = await post(forged); const body = await res.json();
        assert.equal(res.status, 201, JSON.stringify(body));
        const expected = core.convertResultToCny(core.calculateResidualValue(forged), currency, rates.snapshot);
        assert.deepEqual(body.result, expected);
        assert.equal(body.fx.rate, rates.snapshot.rates[currency]);
        assert.equal(body.fx.sourceCurrency, currency);
        assert.equal(body.fx.snapshotId, currency === 'CNY' ? null : rates.snapshot.id);
        const image = await fetch(body.imageUrl); assert.equal(image.status, 200);
        const png = Buffer.from(await image.arrayBuffer()); assert.equal(png.readUInt32BE(16), 3600); assert.equal(png.readUInt32BE(20), 1890);
      }
      assert.equal((await fetch(`${base}/shares/.fx-cache.json`)).status, 404);
    } finally { await new Promise((r) => server.close(r)); }
  });
});

test('HTTP rates fail 503 offline while CNY shares remain fully available with no FX calls', async () => {
  let calls = 0;
  await withService(async (service, storageDir) => {
    const server = createAppServer({ publicDir: path.resolve('public'), storageDir, exchangeRates: service });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const cny = await fetch(`${base}/api/shares`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, currency: 'CNY' }) });
      assert.equal(cny.status, 201); assert.equal(calls, 0);
      assert.equal((await cny.json()).result.currency, 'CNY');
      assert.equal((await fetch(`${base}/api/exchange-rates`)).status, 503);
      assert.equal(calls, 2);
    } finally { await new Promise((r) => server.close(r)); }
  }, { fetcher: async () => { calls++; throw new Error('offline'); } });
});
