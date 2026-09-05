const DAY_MS = 86_400_000;
export const CURRENCY_NAMES = Object.freeze({
  CNY: '人民币', USD: '美元', EUR: '欧元', GBP: '英镑', HKD: '港币', JPY: '日元',
  SGD: '新加坡元', TWD: '新台币', AUD: '澳元', CAD: '加元', KRW: '韩元',
  INR: '印度卢比', CHF: '瑞士法郎', RUB: '俄罗斯卢布', MYR: '马来西亚林吉特', THB: '泰铢',
});
export const CURRENCIES = Object.freeze(Object.keys(CURRENCY_NAMES));

// Intl supplies each allowed currency's minor units (JPY/KRW: 0; others: 2).
// Browser and PNG deliberately share the same locale, symbols and rounding.
export function formatMoney(value, currency) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: normalizeCurrency(currency) }).format(value);
}
export const MAX_CUSTOM_DAYS = 36500;
export const BILLING_CYCLES = Object.freeze([
  { value: 'monthly', label: '月付', months: 1 },
  { value: 'quarterly', label: '季付', months: 3 },
  { value: 'semiannual', label: '半年付', months: 6 },
  { value: 'annual', label: '年付', months: 12 },
  { value: 'biennial', label: '两年付', months: 24 },
  { value: 'triennial', label: '三年付', months: 36 },
  { value: 'custom', label: '自定义天数', months: null },
].map(Object.freeze));

// Construct UTC serial days explicitly: Date.UTC maps years 0–99 to 1900–1999.
function civilSerial(year, month, day) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getTime() / DAY_MS;
}

export function daysInMonth(year, month) {
  return new Date(civilSerial(year, month + 1, 0) * DAY_MS).getUTCDate();
}

export function parseDateOnly(value, label = '日期') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${label}必须为 YYYY-MM-DD 日期`);
  }
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`${label}无效`);
  }
  return civilSerial(year, month, day);
}

export function serialToDate(serial) {
  const date = new Date(serial * DAY_MS);
  const year = date.getUTCFullYear();
  if (!Number.isInteger(serial) || !Number.isFinite(date.getTime()) || year < 1 || year > 9999) throw new RangeError('日期超出支持范围');
  return `${String(year).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function shiftMonthsSerial(value, months) {
  parseDateOnly(value);
  if (!Number.isInteger(months)) throw new TypeError('日期月份偏移必须为整数');
  const [year, month, day] = value.split('-').map(Number);
  const target = year * 12 + month - 1 + months;
  const targetYear = Math.floor(target / 12);
  const targetMonth = ((target % 12) + 12) % 12 + 1;
  return civilSerial(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)));
}

export function addCalendarMonths(value, months) {
  return serialToDate(shiftMonthsSerial(value, months));
}

export function localToday(date = new Date()) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function normalizeCurrency(value) {
  const currency = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!CURRENCIES.includes(currency)) throw new RangeError('请选择支持的币种');
  return currency;
}

function billingDefinition(billingCycle, customDays) {
  const definition = BILLING_CYCLES.find(({ value }) => value === billingCycle);
  if (!definition) throw new RangeError('请选择支持的账单周期');
  if (billingCycle === 'custom' && (!Number.isInteger(customDays) || customDays < 1 || customDays > MAX_CUSTOM_DAYS)) {
    throw new RangeError(`自定义天数必须为 1–${MAX_CUSTOM_DAYS} 的整数`);
  }
  return definition;
}

export function billingCycleLabel(billingCycle, customDays) {
  const definition = billingDefinition(billingCycle, customDays);
  return billingCycle === 'custom' ? `自定义 · ${customDays} 天` : definition.label;
}

export function calculateResidualValue({ amount, currency, endAt, valuedAt, billingCycle, customDays }) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) {
    throw new RangeError('金额必须大于 0 且不超过 10 亿');
  }
  normalizeCurrency(currency);
  const endDay = parseDateOnly(endAt, '到期日');
  const valuedDay = parseDateOnly(valuedAt, '估值日期');
  const definition = billingDefinition(billingCycle, customDays);
  const totalDays = billingCycle === 'custom' ? customDays : endDay - shiftMonthsSerial(endAt, -definition.months);
  const remainingDays = Math.min(totalDays, Math.max(0, endDay - valuedDay));
  const elapsedDays = totalDays - remainingDays;
  const remainingRatio = remainingDays / totalDays;
  return Object.freeze({
    amount, totalDays, elapsedDays, remainingDays,
    usedRatio: elapsedDays / totalDays,
    remainingRatio,
    remainingValue: amount * remainingRatio,
    dailyCost: amount / totalDays,
  });
}

export const FX_SOURCE = 'https://github.com/fawazahmed0/exchange-api';
export const MAX_FX_AGE_MS = 7 * DAY_MS;

// All rates are CNY per one source unit. Keep full precision until formatting.
export function convertResultToCny(result, currency, snapshot) {
  const sourceCurrency = normalizeCurrency(currency);
  const rate = sourceCurrency === 'CNY' ? 1 : snapshot?.rates?.[sourceCurrency];
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) throw new RangeError('缺少有效人民币汇率，请重试');
  const converted = { ...result, currency: 'CNY' };
  for (const key of ['amount', 'remainingValue', 'dailyCost']) {
    converted[key] = result[key] * rate;
    if (!Number.isFinite(converted[key])) throw new RangeError('汇率换算金额超出范围');
  }
  return Object.freeze(converted);
}

export function validateFxSnapshot(snapshot, now = Date.now()) {
  if (!snapshot || typeof snapshot !== 'object') throw new RangeError('汇率数据无效');
  const dateMs = parseDateOnly(snapshot.date, '汇率日期') * DAY_MS;
  if (dateMs > now || now - dateMs > MAX_FX_AGE_MS) throw new RangeError('汇率已过期或日期无效');
  if (typeof snapshot.id !== 'string' || !new RegExp(`^${snapshot.date}-[a-f0-9]{16}$`).test(snapshot.id) || snapshot.source !== FX_SOURCE) throw new RangeError('汇率来源无效');
  for (const currency of CURRENCIES) {
    const rate = snapshot.rates?.[currency];
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || !Number.isFinite(rate * 1_000_000_000)) throw new RangeError('汇率数据无效');
  }
  if (snapshot.rates.CNY !== 1) throw new RangeError('人民币汇率必须为 1');
  return snapshot;
}

export function formatDuration(days) {
  return `${Math.max(0, Math.floor(Number(days) || 0))} 天`;
}
