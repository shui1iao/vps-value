import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAppServer } from '../server.mjs';

async function withServer(fn) {
  const storageDir = await mkdtemp(path.join(tmpdir(), 'vps-value-api-'));
  const server = createAppServer({
    publicDir: path.resolve('public'),
    storageDir,
    publicBaseUrl: '',
    idFactory: () => 'api-test',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await fn(`http://127.0.0.1:${address.port}`, storageDir);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(storageDir, { recursive: true, force: true });
  }
}

const payload = {
  name: 'Osaka VPS',
  amount: 100,
  currency: 'CNY',
  billingCycle: 'custom',
  customDays: 10,
  endAt: '2026-01-11',
  valuedAt: '2026-01-06',
};

test('API rejects missing billing, timestamps and bad custom days and never trusts supplied results', async () => withServer(async (base) => {
  for (const invalid of [{ billingCycle: undefined }, { customDays: 0 }, { endAt: '2026-02-30' }, { valuedAt: '2026-01-06T00:00:00Z' }]) {
    const response = await fetch(`${base}/api/shares`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, ...invalid }),
    });
    assert.equal(response.status, 400);
  }
  const response = await fetch(`${base}/api/shares`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, remainingValue: 99999 }),
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(body.result.remainingValue, 50);
  assert.equal(body.result.remainingDays, 5);
  assert.doesNotMatch(JSON.stringify(body.result), /startAt|startMs|totalMs/);
}));

test('health endpoint is available and hardened', async () => withServer(async (base) => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await response.json(), { ok: true });
}));

test('share endpoint returns a PNG link and markdown', async () => withServer(async (base, storageDir) => {
  const response = await fetch(`${base}/api/shares`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  const png = await readFile(path.join(storageDir, 'api-test.png'));

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.equal(body.imageUrl, `${base}/shares/api-test.png`);
  assert.match(body.markdown, /^!\[Osaka VPS · VPS 剩余价值\]\(http:/);
  assert.equal(body.result.remainingValue, 50);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
}));

test('share endpoint rejects invalid JSON and oversized bodies', async () => withServer(async (base) => {
  const badJson = await fetch(`${base}/api/shares`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{bad',
  });
  assert.equal(badJson.status, 400);

  const tooLarge = await fetch(`${base}/api/shares`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(20_000) }),
  });
  assert.equal(tooLarge.status, 413);
}));

test('does not expose dotfiles or traverse outside the public directory', async () => withServer(async (base) => {
  const dotfile = await fetch(`${base}/.env`);
  const traversal = await fetch(`${base}/..%2fpackage.json`);
  assert.equal(dotfile.status, 404);
  assert.equal(traversal.status, 404);
}));

test('mutable frontend assets are revalidated instead of served stale', async () => withServer(async (base) => {
  const script = await fetch(`${base}/app.mjs`);
  const stylesheet = await fetch(`${base}/styles.css`);
  assert.equal(script.status, 200);
  assert.equal(stylesheet.status, 200);
  assert.equal(script.headers.get('cache-control'), 'no-cache');
  assert.equal(stylesheet.headers.get('cache-control'), 'no-cache');
}));
