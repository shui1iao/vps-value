import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as core from '../src/core.mjs';

const base = { amount: 120, currency: 'USD', billingCycle: 'custom', customDays: 30, endAt: '2026-01-31', valuedAt: '2026-01-16' };

test('uses integer civil days for a midpoint valuation without exposing a start date', () => {
  const result = core.calculateResidualValue(base);
  assert.equal(result.totalDays, 30);
  assert.equal(result.elapsedDays, 15);
  assert.equal(result.remainingDays, 15);
  assert.equal(result.remainingValue, 60);
  assert.equal(result.dailyCost, 4);
  assert.equal(result.remainingRatio, 0.5);
  assert.equal(result.usedRatio, 0.5);
  assert.doesNotMatch(JSON.stringify(result), /startAt|startMs|totalMs|remainingMs/);
});

for (const [billingCycle, endAt, totalDays] of [
  ['monthly', '2026-03-31', 31], ['monthly', '2026-02-28', 31],
  ['monthly', '2024-03-31', 31], ['monthly', '2024-02-29', 31],
  ['quarterly', '2024-05-31', 92], ['semiannual', '2024-08-31', 184],
  ['annual', '2024-02-29', 366], ['annual', '2025-02-28', 366],
  ['biennial', '2025-02-28', 731], ['triennial', '2027-02-28', 1096],
]) {
  test(`${billingCycle} ending ${endAt} derives a clamped calendar cycle (${totalDays} days)`, () => {
    const result = core.calculateResidualValue({ ...base, billingCycle, endAt, valuedAt: endAt });
    assert.equal(result.totalDays, totalDays);
    assert.equal(result.remainingDays, 0);
    assert.equal(result.remainingValue, 0);
  });
}

test('expiry day and past dates are zero; dates beyond the cycle clamp to full', () => {
  for (const valuedAt of ['2026-01-31', '2027-01-01']) {
    assert.equal(core.calculateResidualValue({ ...base, valuedAt }).remainingValue, 0);
  }
  const result = core.calculateResidualValue({ ...base, valuedAt: '2025-01-01' });
  assert.equal(result.remainingValue, 120);
  assert.equal(result.elapsedDays, 0);
  assert.equal(result.remainingDays, 30);
  assert.equal(core.calculateResidualValue({ ...base, valuedAt: '2026-01-30' }).remainingDays, 1);
});

test('date-only parsing rejects timestamps, nonexistent dates, whitespace and nonstrings', () => {
  for (const key of ['endAt', 'valuedAt']) {
    for (const value of ['2026-02-29', '2024-02-30', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-1-01', '2026-01-01T00:00:00Z', ' 2026-01-01', '0000-01-01', '', null, true, 0, {}, [], new Date()]) {
      assert.throws(() => core.calculateResidualValue({ ...base, [key]: value }), key === 'endAt' ? /到期日/ : /日期/, `${key}: ${String(value)}`);
    }
  }
});

test('requires a supported billing cycle and bounded integer custom days', () => {
  for (const billingCycle of [undefined, '', 'week', null, [], {}]) {
    assert.throws(() => core.calculateResidualValue({ ...base, billingCycle }), /账单周期/);
  }
  for (const customDays of [undefined, 0, -1, 1.5, '30', true, null, [], {}, 36501, Infinity, NaN]) {
    assert.throws(() => core.calculateResidualValue({ ...base, customDays }), /自定义天数/);
  }
  for (const customDays of [1, 36500]) {
    assert.equal(core.calculateResidualValue({ ...base, customDays }).totalDays, customDays);
  }
});

test('rejects invalid numeric amount types and accepts supported currency strings only', () => {
  for (const amount of [0, -1, 1_000_000_001, NaN, Infinity, '', '120', true, null, [], {}]) {
    assert.throws(() => core.calculateResidualValue({ ...base, amount }), /金额/);
  }
  assert.equal(core.normalizeCurrency('usd'), 'USD');
  for (const currency of ['BTC', null, 1, ['USD'], {}]) {
    assert.throws(() => core.calculateResidualValue({ ...base, currency }), /币种/);
  }
  assert.equal(core.calculateResidualValue({ ...base, amount: 0.01 }).amount, 0.01);
});

test('day arithmetic is identical across DST and timezone boundaries', () => {
  const payload = { ...base, billingCycle: 'monthly', endAt: '2026-03-31', valuedAt: '2026-03-01' };
  const moduleUrl = new URL('../src/core.mjs', import.meta.url).href;
  const code = `import {calculateResidualValue as c} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(c(${JSON.stringify(payload)})))`;
  const values = ['UTC', 'America/New_York', 'Asia/Shanghai', 'Pacific/Apia'].map((TZ) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ }, encoding: 'utf8' })));
  for (const value of values) {
    assert.deepEqual(value, values[0]);
    assert.equal(value.remainingDays, 30);
    assert.equal(value.totalDays, 31);
  }
});

test('date helpers clamp leap-day defaults and use local civil today', () => {
  assert.equal(core.addCalendarMonths('2024-02-29', 12), '2025-02-28');
  assert.equal(core.addCalendarMonths('2026-03-31', -1), '2026-02-28');
  assert.equal(core.addCalendarMonths('0099-12-31', 1), '0100-01-31');
  assert.equal(core.localToday(new Date(2026, 0, 2, 23, 59)), '2026-01-02');
  assert.equal(core.formatDuration(0), '0 天');
  assert.equal(core.formatDuration(31), '31 天');
  assert.equal(core.billingCycleLabel('annual'), '年付');
  assert.equal(core.billingCycleLabel('custom', 45), '自定义 · 45 天');
});
