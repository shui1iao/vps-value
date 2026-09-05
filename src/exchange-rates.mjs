import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { CURRENCIES, FX_SOURCE, validateFxSnapshot } from './core.mjs';

const UPSTREAMS = Object.freeze([
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/cny.json',
  'https://latest.currency-api.pages.dev/v1/currencies/cny.json',
]);
const unavailable = () => Object.assign(new Error('暂时无法取得可信汇率，请稍后重试；人民币输入不受影响'), { statusCode: 503 });
const unknownSnapshot = () => Object.assign(new Error('汇率快照已失效，请刷新汇率后重新导出'), { statusCode: 409 });
const snapshotId = (date, rates) => `${date}-${crypto.createHash('sha256').update(JSON.stringify([date, CURRENCIES.map((c) => rates[c])])).digest('hex').slice(0, 16)}`;

function fromUpstream(data, now) {
  const rates = Object.fromEntries(CURRENCIES.map((currency) => {
    const rate = data?.cny?.[currency.toLowerCase()];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) throw unavailable();
    return [currency, 1 / rate];
  }));
  return freezeSnapshot(validateFxSnapshot({ id: snapshotId(data.date, rates), date: data.date, rates, source: FX_SOURCE }, now));
}

function freezeSnapshot(snapshot) {
  return Object.freeze({ id: snapshot.id, date: snapshot.date, rates: Object.freeze(Object.fromEntries(CURRENCIES.map((c) => [c, snapshot.rates[c]]))), source: FX_SOURCE });
}

// No background timers: CNY never triggers a fetch. The service only trusts its
// own validated, content-addressed snapshots and persists before publishing one.
export function createExchangeRateService({ storageDir, fetcher = globalThis.fetch, now = Date.now, refreshMs = 3_600_000, backoffMs = 60_000, timeoutMs = 8_000 } = {}) {
  const filename = path.join(storageDir, '.fx-cache.json');
  let snapshots = [];
  let fetchedAt = 0;
  let nextAttempt = 0;
  let refreshFailed = false;
  let pending = null;
  let loading = null;

  function valid(snapshot) {
    try { validateFxSnapshot(snapshot, now()); return true; } catch { return false; }
  }
  function metadata(snapshot) {
    const today = new Date(now()).toISOString().slice(0, 10);
    return { snapshot, stale: refreshFailed || snapshot.date < today || now() - fetchedAt >= refreshMs };
  }
  async function load() {
    if (!loading) loading = (async () => {
      try {
        const text = await readFile(filename, 'utf8');
        if (text.length > 100_000) return;
        const disk = JSON.parse(text);
        if (disk.version !== 1 || !Array.isArray(disk.snapshots)) return;
        const seen = new Set();
        snapshots = disk.snapshots.filter((s) => {
          if (!valid(s) || s.id !== snapshotId(s.date, s.rates) || seen.has(s.id)) return false;
          seen.add(s.id); return true;
        }).slice(0, 8).map(freezeSnapshot);
        if (Number.isFinite(disk.fetchedAt) && disk.fetchedAt <= now()) fetchedAt = disk.fetchedAt;
      } catch { /* Absent, corrupt or expired cache must not authorize a rate. */ }
    })();
    await loading;
  }
  async function persist(next, fetched) {
    await mkdir(storageDir, { recursive: true, mode: 0o750 });
    const temporary = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, fetchedAt: fetched, snapshots: next }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, filename);
    } finally { await rm(temporary, { force: true }); }
  }
  async function refresh() {
    let best = null;
    const today = new Date(now()).toISOString().slice(0, 10);
    for (const url of UPSTREAMS) {
      try {
        const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: { accept: 'application/json' } });
        if (!response.ok) throw unavailable();
        const text = await response.text();
        if (text.length > 100_000) throw unavailable();
        const snapshot = fromUpstream(JSON.parse(text), now());
        // Don't roll the latest snapshot back if one mirror lags the cache.
        if (snapshots[0] && valid(snapshots[0]) && snapshot.date < snapshots[0].date) throw unavailable();
        if (!best || snapshot.date > best.date) best = snapshot;
        if (best.date === today) break;
      } catch { /* Try the second fixed mirror; retain any valid first result. */ }
    }
    if (best) {
      try {
        const next = [best, ...snapshots.filter((s) => s.id !== best.id && valid(s))].slice(0, 8);
        const fetched = now();
        await persist(next, fetched);
        snapshots = next; fetchedAt = fetched; refreshFailed = false; nextAttempt = fetched + refreshMs;
        return;
      } catch { /* Do not publish a snapshot that cannot survive a restart. */ }
    }
    refreshFailed = true;
    nextAttempt = now() + backoffMs;
  }
  return Object.freeze({
    async getLatest() {
      await load();
      if ((!snapshots[0] || !valid(snapshots[0]) || now() - fetchedAt >= refreshMs) && now() >= nextAttempt) {
        if (!pending) pending = refresh().finally(() => { pending = null; });
        await pending;
      }
      const snapshot = snapshots.find(valid);
      if (!snapshot) throw unavailable();
      return metadata(snapshot);
    },
    async getById(id) {
      await load();
      const snapshot = typeof id === 'string' && snapshots.find((s) => s.id === id && valid(s));
      if (!snapshot) throw unknownSnapshot();
      return metadata(snapshot);
    },
  });
}
