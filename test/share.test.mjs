import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  createShare,
  normalizeSharePayload,
  renderShareSvg,
} from '../src/share.mjs';

const validPayload = {
  name: 'Tokyo & <Edge>',
  amount: 120,
  currency: 'CNY',
  billingCycle: 'custom',
  customDays: 30,
  endAt: '2026-01-31',
  valuedAt: '2026-01-16',
};

test('share model retains billing while SVG shows only five key fields in eight text nodes', () => {
  const model = normalizeSharePayload(validPayload);
  assert.equal(model.billingCycle, 'custom');
  assert.equal(model.customDays, 30);
  assert.equal(model.endAt, '2026-01-31');
  assert.equal(model.valuedAt, '2026-01-16');
  assert.doesNotMatch(JSON.stringify(model), /startAt|startMs/);
  const svg = renderShareSvg(model);
  const texts = [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
  assert.deepEqual(texts, ['Tokyo &amp; &lt;Edge&gt;', '剩余金额 · 人民币', '¥60.00', '到期日', '2026-01-31', '剩余天数', '15 天', '交易日期 2026-01-16']);
  assert.doesNotMatch(svg, /小时|UTC|开始时间|估值时间|\d{2}:\d{2}|2026-01-01/);
  assert.doesNotMatch(texts.join(' '), /原价|日均|已使用|账单周期|自定义|汇率|无需换算|剩余周期|%|VPS Value|RESIDUAL VALUE|估值完成|到期当天/);
});

test('share normalization rejects missing billing, nonstring names and timestamp dates', () => {
  for (const invalid of [ { billingCycle: undefined }, { name: {} }, { endAt: '2026-01-31T00:00:00Z' }, { valuedAt: null } ]) {
    assert.throws(() => normalizeSharePayload({ ...validPayload, ...invalid }));
  }
});

test('normalizes share data and recalculates value on the server', () => {
  const normalized = normalizeSharePayload({
    ...validPayload,
    remainingValue: 999999,
  });

  assert.equal(normalized.name, 'Tokyo & <Edge>');
  assert.equal(normalized.result.remainingValue, 60);
  assert.equal(normalized.currency, 'CNY');
  assert.equal(normalized.result.currency, 'CNY');
});

test('rejects oversized names and unsupported currencies', () => {
  assert.throws(() => normalizeSharePayload({ ...validPayload, name: 'x'.repeat(81) }), /名称/);
  assert.throws(() => normalizeSharePayload({ ...validPayload, currency: 'BTC' }), /币种/);
});

test('escapes user content in the exported SVG', () => {
  const model = normalizeSharePayload(validPayload);
  const svg = renderShareSvg(model);

  assert.match(svg, /^<svg[^>]+width="1200"[^>]+height="630"/);
  assert.doesNotMatch(svg, /<Edge>/);
  assert.match(svg, /Tokyo &amp; &lt;Edge&gt;/);
  assert.match(svg, /剩余价值/);
  assert.doesNotMatch(svg, />50\.00%<|¥4\.00|¥120\.00/);
  assert.match(svg, /¥60\.00/);
});

test('remaining days and value stay accurate with a nonvisual timeline label', () => {
  const model = normalizeSharePayload({
    ...validPayload,
    customDays: 10,
    endAt: '2026-01-11',
    valuedAt: '2026-01-03',
  });
  const svg = renderShareSvg(model);

  assert.match(svg, />8 天<\/text>/);
  assert.match(svg, />¥96\.00<\/text>/);
  assert.match(svg, /aria-label="剩余周期 80\.00%"/);
  assert.doesNotMatch(svg, />[^<]*(?:剩余周期|80\.00%)[^<]*<\/text>/);
});

test('SVG has a full pale gradient and restrained geometric texture with readable text', () => {
  const svg = renderShareSvg(normalizeSharePayload(validPayload));
  assert.match(svg, /^<svg[^>]+width="1200" height="630" viewBox="0 0 1200 630"/);
  const gradient = svg.match(/<linearGradient\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/linearGradient>/);
  assert.ok(gradient, 'full-canvas soft gradient exists');
  assert.ok(svg.includes(`<rect width="1200" height="630" fill="url(#${gradient[1]})"/>`));
  assert.deepEqual([...gradient[2].matchAll(/stop-color="([^"]+)"/g)].map((m) => m[1]), ['#edf3ff', '#f1f6fb', '#edf7f9']);
  assert.equal([...svg.matchAll(/<rect\b/g)].length, 3, 'gradient canvas plus track and proportional fill');
  const circles = [...svg.matchAll(/<circle\b([^>]*)\/>/g)];
  assert.ok(circles.length >= 2 && circles.length <= 4, 'a few large circular accents');
  for (const [, attributes] of circles) {
    const attr = Object.fromEntries([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    assert.ok(Number(attr.r) >= 100, 'large calm arcs rather than small marks');
    for (const color of [attr.fill, attr.stroke].filter((value) => value && value !== 'none')) {
      assert.match(color, /^#[a-f\d]{6}$/i);
      assert.ok(color.slice(1).match(/../g).every((channel) => parseInt(channel, 16) >= 210), 'geometry stays pale near all text');
    }
  }
  const lines = [...svg.matchAll(/<path\b[^>]*fill="none"[^>]*stroke="([^"]+)"[^>]*\/>/g)];
  assert.ok(lines.length >= 1 && lines.length <= 3, 'a few subtle geometric lines enrich the canvas');
  for (const [, color] of lines) assert.ok(color.slice(1).match(/../g).every((channel) => parseInt(channel, 16) >= 210));
  assert.doesNotMatch(svg, /halo|shadow|<filter|feDropShadow|<image|<use|#07111f|#334764/i);
  const layout = [
    [72, 115, 38, 'Tokyo &amp; &lt;Edge&gt;'],
    [72, 185, 30, '剩余金额 · 人民币'],
    [72, 325, 104, '¥60.00'],
    [72, 428, 30, '到期日'],
    [72, 495, 44, '2026-01-31'],
    [760, 428, 30, '剩余天数'],
    [760, 495, 44, '15 天'],
    [72, 567, 26, '交易日期 2026-01-16'],
  ];
  const nodes = [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)];
  assert.equal(nodes.length, layout.length);
  for (const [index, [x, y, size, text]] of layout.entries()) {
    const [, attributes, content] = nodes[index];
    for (const attribute of [`x="${x}"`, `y="${y}"`, `font-size="${size}"`]) assert.ok(attributes.includes(attribute), attribute);
    assert.equal(content, text);
  }
  assert.match(svg, /<text x="72" y="115" fill="#0f172a"[^>]*>Tokyo &amp; &lt;Edge&gt;<\/text>/);
  assert.match(svg, /<text x="72" y="325" fill="#2563eb"[^>]*>¥60\.00<\/text>/);
  for (const text of svg.matchAll(/<text\b[^>]*fill="([^"]+)"/g)) {
    assert.ok(['#0f172a', '#475569', '#2563eb'].includes(text[1]), `readable text: ${text[1]}`);
  }
});

test('blank or missing names default to VPS and custom names retain 80-character validation', () => {
  for (const name of [undefined, null, '', '  \n\t ']) assert.equal(normalizeSharePayload({ ...validPayload, name }).name, 'VPS');
  assert.equal(normalizeSharePayload({ ...validPayload, name: '  自定义   VPS  ' }).name, '自定义 VPS');
  assert.equal(normalizeSharePayload({ ...validPayload, name: '长'.repeat(80) }).name, '长'.repeat(80));
  assert.throws(() => normalizeSharePayload({ ...validPayload, name: '长'.repeat(81) }), /80/);
});

test('PNG timeline has exact zero, half, full and tiny widths with no fake minimum', () => {
  for (const [valuedAt, customDays, expectedRatio] of [
    ['2026-01-31', 30, 0], ['2026-02-01', 30, 0], ['2026-01-16', 30, 0.5],
    ['2026-01-01', 30, 1], ['2025-12-01', 30, 1], ['2026-01-30', 36500, 1 / 36500],
  ]) {
    const model = normalizeSharePayload({ ...validPayload, valuedAt, customDays });
    assert.equal(model.result.remainingRatio, expectedRatio);
    const svg = renderShareSvg(model);
    const rects = [...svg.matchAll(/<rect\b([^>]*)\/>/g)].map(([, attrs]) => Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]])));
    const [track, fill] = rects.filter((r) => r.y === '378');
    assert.ok(track && fill, 'track and fill replace the old divider');
    for (const rect of [track, fill]) { assert.equal(rect.x, '72'); assert.equal(rect.height, '8'); }
    assert.equal(Number(track.width), 1056);
    assert.equal(Number(fill.width), expectedRatio * 1056);
    assert.match(svg, new RegExp(`aria-label="剩余周期 ${(expectedRatio * 100).toFixed(2)}%"`));
    assert.equal([...svg.matchAll(/<text\b/g)].length, 8, 'progress adds no visible text');
  }
});

test('display names fit 26 Unicode characters including an ellipsis without changing the model', () => {
  for (const name of ['长'.repeat(26), '长'.repeat(27), '😀'.repeat(80)]) {
    const model = normalizeSharePayload({ ...validPayload, name });
    const svg = renderShareSvg(model);
    const displayed = svg.match(/<text\b[^>]*>([^<]*)<\/text>/)?.[1];
    const characters = Array.from(name);
    assert.equal(model.name, name);
    assert.equal(displayed, characters.length > 26 ? `${characters.slice(0, 25).join('')}…` : name);
    assert.equal(Array.from(displayed).length, 26);
  }
});

async function createTestPng(t, payload = validPayload, exchangeRates) {
  const storageDir = await mkdtemp(path.join(tmpdir(), 'vps-value-render-'));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  const share = await createShare(payload, {
    storageDir,
    publicBaseUrl: 'https://calc.example.test',
    idFactory: () => 'render-fixture',
    exchangeRates,
  });
  return { share, png: await readFile(path.join(storageDir, 'render-fixture.png')) };
}

test('real PNG has 3600×1890 native pixels', async (t) => {
  const { png } = await createTestPng(t);
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 3600);
  assert.equal(metadata.height, 1890);
});

test('real PNG is opaque with pale nonwhite background across the canvas and visible gradient variation', async (t) => {
  const { png } = await createTestPng(t);
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const scale = info.width / 1200;
  // Sample background away from the unchanged text and timeline positions.
  const regions = [[0, 0, 1000, 60], [0, 590, 1060, 40], [0, 0, 60, 630], [1130, 135, 70, 400], [72, 135, 1056, 10], [72, 340, 1056, 25], [72, 515, 1056, 20]];
  for (const [left, top, width, height] of regions) {
    for (let y = top * scale; y < (top + height) * scale; y++) {
      const row = data.subarray((y * info.width + left * scale) * 4, (y * info.width + (left + width) * scale) * 4);
      for (let offset = 0; offset < row.length; offset += 4) {
        const rgb = row.subarray(offset, offset + 3);
        assert.ok(rgb.every((channel) => channel >= 210), `background stays pale in ${left},${top},${width},${height} at row ${y}`);
        assert.ok(rgb.some((channel) => channel < 253), 'full canvas is tinted, not a white main area');
      }
    }
  }
  for (let offset = 3; offset < data.length; offset += 4) assert.equal(data[offset], 255, 'entire PNG is opaque');
  const samples = [[400, 30], [400, 605], [1180, 10], [1180, 610]].map(([x, y]) => {
    const offset = (y * scale * info.width + x * scale) * 4;
    return [...data.subarray(offset, offset + 3)].join(',');
  });
  assert.ok(new Set(samples).size >= 3, 'gradient and geometry yield distinguishable pale tones');
});

test('real PNG preserves checked CNY text and longest-name ellipsis through lossless 216-DPI vector rendering', async (t) => {
  // Synthetic server-side fixture, not a current or historical market quote.
  const snapshot = { id: '2026-01-16-0123456789abcdef', date: '2026-01-16', source: 'https://github.com/fawazahmed0/exchange-api', rates: { CNY: 1, USD: 7.25 } };
  const payload = { ...validPayload, name: '长'.repeat(80), currency: 'USD', fxSnapshotId: snapshot.id, rate: 999 };
  const exchangeRates = { getById: async (id) => { assert.equal(id, snapshot.id); return { snapshot, stale: false }; } };
  const { png, share } = await createTestPng(t, payload, exchangeRates);
  const svg = renderShareSvg(normalizeSharePayload(payload, { snapshot }));
  assert.ok(svg.includes(`${'长'.repeat(25)}…</text>`));
  assert.ok(!svg.includes('长'.repeat(26)));
  for (const text of ['¥435.00', '剩余金额 · 人民币', '15 天', '到期日', '2026-01-31', '交易日期 2026-01-16']) assert.ok(svg.includes(text), text);
  assert.doesNotMatch(svg, /US\$|999\.000000|小时|UTC|原价|¥870\.00|¥29\.00|汇率|USD|fawazahmed0/);
  assert.equal(share.result.remainingValue, 435);
  assert.equal(share.result.amount, 870);
  assert.equal(share.result.dailyCost, 29);
  assert.equal(share.fx.snapshotId, snapshot.id);
  assert.equal(share.fx.rate, snapshot.rates.USD);
  assert.equal(share.fx.date, snapshot.date);
  const actual = await sharp(png).ensureAlpha().raw().toBuffer();
  const vector = await sharp(Buffer.from(svg), { density: 216 }).ensureAlpha().raw().toBuffer();
  assert.ok(actual.equals(vector), 'PNG must preserve every pixel from the 216-DPI SVG rasterization');
  const defaultRaster = await sharp(Buffer.from(svg)).png().toBuffer();
  const upscaled = await sharp(defaultRaster).resize(3600, 1890).ensureAlpha().raw().toBuffer();
  assert.ok(!actual.equals(upscaled), 'enlarging a 72-DPI bitmap is not high-resolution vector rendering');
});

test('creates a real PNG and returns an embeddable Markdown URL', async () => {
  const storageDir = await mkdtemp(path.join(tmpdir(), 'vps-value-share-'));
  try {
    const share = await createShare(validPayload, {
      storageDir,
      publicBaseUrl: 'https://calc.example.test',
      idFactory: () => 'fixed-id',
    });
    const png = await readFile(path.join(storageDir, 'fixed-id.png'));

    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(share.imageUrl, 'https://calc.example.test/shares/fixed-id.png');
    assert.equal(share.markdown, '![Tokyo & <Edge> · VPS 剩余价值](https://calc.example.test/shares/fixed-id.png)');
    assert.equal(share.result.remainingValue, 60);
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
});
