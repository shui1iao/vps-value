// The cache belongs to a revision, not merely to a value. Editing A → B → A
// must still invalidate a request that began before either edit.
export function createShareClient({ fetcher = globalThis.fetch } = {}) {
  let payload = null;
  let revision = 0;
  let cache = null;
  let pending = null;
  const isCurrent = (share) => Boolean(payload && share?.revision === revision);
  return {
    setPayload(next) {
      const snapshot = next ? Object.freeze({ ...next }) : null;
      if (JSON.stringify(snapshot) === JSON.stringify(payload)) return;
      payload = snapshot;
      revision++;
      cache = null;
      pending = null;
    },
    isCurrent,
    async get() {
      if (!payload) throw new Error('请先完成计算');
      if (cache) return cache;
      if (pending) return pending;
      const snapshot = payload;
      const requestedRevision = revision;
      const request = (async () => {
        const response = await fetcher('/api/shares', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(snapshot),
        });
        const body = await response.json().catch(() => ({}));
        if (requestedRevision !== revision) throw new Error('信息已更新，请重新导出');
        if (!response.ok || !body.ok) throw Object.assign(new Error(body.error || '图片生成失败'), { statusCode: response.status });
        cache = Object.freeze({ ...body, payload: snapshot, revision: requestedRevision });
        return cache;
      })();
      pending = request;
      try { return await request; }
      finally { if (pending === request) pending = null; }
    },
  };
}
