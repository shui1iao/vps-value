import { validateFxSnapshot } from './core.mjs';

// One all-currency snapshot, never a currency-specific async response. Callers
// render their current input on change, so an old USD request cannot overwrite CNY.
export function createExchangeClient({ fetcher = globalThis.fetch, now = Date.now, onChange = () => {}, refreshMs = 3_600_000, timeoutMs = 18_000 } = {}) {
  let state = Object.freeze({ snapshot: null, stale: false, loading: false, error: '' });
  let checkedAt = 0;
  let nextAttempt = 0;
  let pending = null;
  function snapshotValid() {
    try { validateFxSnapshot(state.snapshot, now()); return true; } catch { return false; }
  }
  const getState = () => {
    if (state.snapshot && !snapshotValid()) return { ...state, snapshot: null, error: '汇率已过期，请重试' };
    return Object.freeze({ ...state, stale: state.stale || Boolean(state.snapshot && state.snapshot.date < new Date(now()).toISOString().slice(0, 10)) });
  };
  return Object.freeze({
    getState,
    async refresh({ force = false } = {}) {
      if (pending) return pending;
      if (!force && ((snapshotValid() && now() - checkedAt < refreshMs) || now() < nextAttempt)) return getState();
      state = Object.freeze({ ...state, loading: true, error: '' });
      pending = Promise.resolve().then(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetcher('/api/exchange-rates', { cache: 'no-store', signal: controller.signal });
          const body = await response.json();
          if (!response.ok || !body.ok) throw new Error('汇率暂不可用');
          const snapshot = validateFxSnapshot(body.snapshot, now());
          state = Object.freeze({ snapshot: Object.freeze({ ...snapshot, rates: Object.freeze({ ...snapshot.rates }) }), stale: Boolean(body.stale), loading: false, error: '' });
          checkedAt = now(); nextAttempt = 0;
        } catch {
          state = Object.freeze({ snapshot: null, stale: false, loading: false, error: '汇率暂不可用，请重试；人民币输入不受影响' });
          nextAttempt = now() + 60_000;
        } finally {
          clearTimeout(timer);
          pending = null;
          onChange();
        }
        return getState();
      });
      onChange();
      return pending;
    },
  });
}
