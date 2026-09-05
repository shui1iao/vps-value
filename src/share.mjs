import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, rename, rm } from 'node:fs/promises';
import sharp from 'sharp';
import { calculateResidualValue, convertResultToCny, formatDuration, formatMoney, normalizeCurrency } from './core.mjs';

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function displayName(name) {
  const characters = Array.from(name);
  return characters.length > 26 ? `${characters.slice(0, 25).join('')}…` : name;
}


export function normalizeSharePayload(payload, { snapshot, stale = false } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('请求内容无效');
  }

  if (payload.name != null && typeof payload.name !== 'string') throw new TypeError('VPS 名称必须为文本');
  const compactName = (payload.name ?? '').trim().replace(/\s+/gu, ' ') || 'VPS';
  if (Array.from(compactName).length > 80) {
    throw new RangeError('VPS 名称不能超过 80 个字符');
  }

  const currency = normalizeCurrency(payload.currency);
  const original = calculateResidualValue(payload);
  const result = convertResultToCny(original, currency, snapshot);
  const fx = Object.freeze({ sourceCurrency: currency, rate: currency === 'CNY' ? 1 : snapshot.rates[currency], snapshotId: currency === 'CNY' ? null : snapshot.id, date: currency === 'CNY' ? null : snapshot.date, source: currency === 'CNY' ? null : snapshot.source, stale: currency === 'CNY' ? false : stale });

  return Object.freeze({
    name: compactName,
    currency,
    amount: original.amount,
    billingCycle: payload.billingCycle,
    ...(payload.billingCycle === 'custom' ? { customDays: payload.customDays } : {}),
    endAt: payload.endAt,
    valuedAt: payload.valuedAt,
    result,
    fx,
  });
}

export function renderShareSvg(model) {
  const { result } = model;
  const name = escapeXml(displayName(model.name));
  const remainingValue = formatMoney(result.remainingValue, 'CNY');
  // Budget conservatively for the currency symbol, digits and punctuation.
  const amountFontSize = Math.min(104, Math.floor(1000 / (remainingValue.length * 0.65)));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${name} VPS 剩余价值">
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#edf3ff"/>
      <stop offset="0.52" stop-color="#f1f6fb"/>
      <stop offset="1" stop-color="#edf7f9"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#background)"/>
  <g aria-hidden="true">
    <circle cx="1190" cy="-80" r="300" fill="#e3ecfb" fill-opacity="0.68"/>
    <circle cx="1190" cy="-80" r="345" fill="none" stroke="#d9e6f7" stroke-width="2"/>
    <circle cx="1260" cy="720" r="310" fill="#dff0f3" fill-opacity="0.65"/>
    <circle cx="-110" cy="660" r="220" fill="#e8eafa" fill-opacity="0.55"/>
    <path d="M760 0 L890 130 H1200" fill="none" stroke="#dce6f4" stroke-width="2"/>
    <path d="M660 630 L770 520 H1200" fill="none" stroke="#d9ecef" stroke-width="2"/>
  </g>
  <g font-family="Noto Sans CJK SC, Noto Sans SC, Microsoft YaHei, sans-serif">
    <text x="72" y="115" fill="#0f172a" font-size="38" font-weight="700">${name}</text>
    <text x="72" y="185" fill="#475569" font-size="30">剩余金额 · 人民币</text>
    <text x="72" y="325" fill="#2563eb" font-size="${amountFontSize}" font-weight="700">${escapeXml(remainingValue)}</text>
    <g role="img" aria-label="剩余周期 ${(result.remainingRatio * 100).toFixed(2)}%">
      <rect x="72" y="378" width="1056" height="8" rx="4" fill="#e2e8f0"/>
      <rect x="72" y="378" width="${result.remainingRatio * 1056}" height="8" rx="4" fill="#60a5fa"/>
    </g>
    <text x="72" y="428" fill="#475569" font-size="30">到期日</text>
    <text x="72" y="495" fill="#0f172a" font-size="44" font-weight="600">${model.endAt}</text>
    <text x="760" y="428" fill="#475569" font-size="30">剩余天数</text>
    <text x="760" y="495" fill="#0f172a" font-size="44" font-weight="600">${escapeXml(formatDuration(result.remainingDays))}</text>
    <text x="72" y="567" fill="#475569" font-size="26">交易日期 ${model.valuedAt}</text>
  </g>
</svg>`;
}

export async function createShare(payload, { storageDir, publicBaseUrl, exchangeRates, idFactory = () => crypto.randomBytes(12).toString('hex') }) {
  const currency = normalizeCurrency(payload?.currency);
  let exchange;
  if (currency !== 'CNY') {
    if (!exchangeRates) throw Object.assign(new Error('汇率快照已失效，请刷新汇率后重新导出'), { statusCode: 409 });
    exchange = await exchangeRates.getById(payload.fxSnapshotId);
  }
  const model = normalizeSharePayload(payload, exchange);
  const id = String(idFactory());
  if (!/^[a-zA-Z0-9_-]{6,80}$/.test(id)) {
    throw new Error('图片标识无效');
  }

  await mkdir(storageDir, { recursive: true, mode: 0o750 });
  const target = path.join(storageDir, `${id}.png`);
  const temporary = path.join(storageDir, `.${id}.${process.pid}.tmp`);
  const svg = renderShareSvg(model);

  try {
    // Rasterize the 1200×630 vector at 3× (72 × 3 DPI), never enlarge a bitmap.
    await sharp(Buffer.from(svg), { density: 216 }).png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(temporary);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }

  const base = String(publicBaseUrl).replace(/\/+$/, '');
  const imageUrl = `${base}/shares/${id}.png`;
  const safeAlt = model.name.replace(/[\[\]\\]/g, '').slice(0, 80);
  return Object.freeze({
    id,
    imageUrl,
    markdown: `![${safeAlt} · VPS 剩余价值](${imageUrl})`,
    result: model.result,
    fx: model.fx,
  });
}
