import test from 'node:test';
import assert from 'node:assert/strict';

const moduleUrl = new URL('../public/share-client.mjs', import.meta.url);
const response = (id) => ({ ok: true, json: async () => ({ ok: true, imageUrl: `/shares/${id}.png`, markdown: id }) });

test('stale in-flight shares are discarded after an edit, including editing back', async () => {
  const { createShareClient } = await import(moduleUrl);
  const pending = [];
  const client = createShareClient({ fetcher: (...args) => new Promise((resolve) => pending.push({ args, resolve })) });
  const original = { name: 'A', amount: 10 };
  client.setPayload(original);
  const oldRequest = client.get();
  client.setPayload({ name: 'B', amount: 20 });
  client.setPayload(original);
  pending[0].resolve(response('stale'));
  await assert.rejects(oldRequest, /信息已更新/);
  const current = client.get();
  assert.equal(pending.length, 2);
  pending[1].resolve(response('fresh'));
  assert.equal((await current).imageUrl, '/shares/fresh.png');
});

test('shares snapshot payload and filename; identical requests deduplicate and cache', async () => {
  const { createShareClient } = await import(moduleUrl);
  let requests = 0;
  let resolve;
  const client = createShareClient({ fetcher: () => { requests++; return new Promise((done) => { resolve = done; }); } });
  const payload = { name: 'Original', amount: 10 };
  client.setPayload(payload);
  payload.name = 'Changed behind the client';
  const first = client.get();
  const second = client.get();
  resolve(response('snapshot'));
  const share = await first;
  assert.equal(share.payload.name, 'Original');
  assert.equal(share, await second);
  assert.equal(share, await client.get());
  assert.equal(requests, 1);
  assert.equal(client.isCurrent(share), true);
  client.setPayload({ name: 'Next', amount: 10 });
  assert.equal(client.isCurrent(share), false);
});

test('failed share requests can retry and invalid payloads cannot export', async () => {
  const { createShareClient } = await import(moduleUrl);
  let requests = 0;
  const client = createShareClient({ fetcher: async () => ++requests === 1 ? { ok: false, json: async () => ({ error: '失败' }) } : response('retry') });
  await assert.rejects(client.get(), /请先完成计算/);
  client.setPayload({ name: 'A' });
  await assert.rejects(client.get(), /失败/);
  assert.equal((await client.get()).imageUrl, '/shares/retry.png');
  client.setPayload(null);
  await assert.rejects(client.get(), /请先完成计算/);
});
