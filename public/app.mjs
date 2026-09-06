import { calculateResidualValue, convertResultToCny, formatDuration, formatMoney, normalizeCurrency, localToday, parseDateOnly } from './core.mjs';
import { createCustomControls } from './control-adapter.mjs';
import { createShareClient } from './share-client.mjs';
import { createExchangeClient } from './fx-client.mjs';

const $ = (selector) => document.querySelector(selector);
const form = $('#calculator');
const fields = {
  name: $('#name'), amount: $('#amount'), currency: $('#currency'),
  endAt: $('#end-at'), billingCycle: $('#billing-cycle'), customDays: $('#custom-days'),
};
const exportButtons = [$('#download-png'), $('#create-link'), $('#copy-markdown')];
const busyButtons = new Set();
const shareClient = createShareClient();
const fxClient = createExchangeClient({ onChange: updateResult });
let inputRevision = 0;
let currentPayload = null;
let toastTimer;
let midnightTimer;
let displayedToday = localToday();


function readPayload() {
  return {
    name: fields.name.value.trim().replace(/\s+/gu, ' ') || 'VPS',
    amount: Number(fields.amount.value),
    currency: normalizeCurrency(fields.currency.value),
    ...(fields.currency.value !== 'CNY' ? { fxSnapshotId: fxClient.getState().snapshot?.id } : {}),
    endAt: fields.endAt.value,
    billingCycle: fields.billingCycle.value,
    ...(fields.billingCycle.value === 'custom' ? { customDays: Number(fields.customDays.value) } : {}),
    valuedAt: localToday(),
  };
}

function setReady(ready) {
  const state = $('#result-state');
  state.classList.toggle('is-ready', ready);
  state.classList.toggle('is-waiting', !ready);
  state.lastChild.textContent = ready ? '已计算' : '待填写';
  for (const button of exportButtons) button.disabled = !ready || busyButtons.has(button);
}

function resetResult(message = '') {
  currentPayload = null;
  shareClient.setPayload(null);
  setReady(false);
  $('#form-error').textContent = message;
  $('#remaining-value').textContent = '—';
  $('#remaining-percent').textContent = '—';
  $('#timeline-progress').style.width = '0%';
  for (const id of ['remaining-duration', 'end-label']) $(`#${id}`).textContent = '—';
  $('#share-output').hidden = true;
}

function updateFxCaption() {
  const state = fxClient.getState();
  const foreign = fields.currency.value !== 'CNY';
  $('#fx-source').hidden = !foreign || !state.snapshot || state.loading;
  $('#fx-retry').hidden = !foreign || !state.error;
  $('#fx-retry').disabled = state.loading;
  $('#fx-description').textContent = !foreign ? '人民币 · 无需换算' : state.loading ? '正在获取人民币参考汇率…' : state.error || (state.snapshot
    ? `1 ${fields.currency.value} = ¥${state.snapshot.rates[fields.currency.value].toFixed(6)} · 汇率日期 ${state.snapshot.date} · ${state.stale ? '缓存参考汇率' : '参考汇率'}`
    : '选择外币后按参考汇率折算人民币');
  return state;
}

function updateResult() {
  const today = localToday();
  displayedToday = today;
  $('#valued-label').textContent = today;
  $('#valued-label').dateTime = today;
  const custom = fields.billingCycle.value === 'custom';
  $('#custom-days-field').hidden = !custom;
  fields.customDays.disabled = !custom;
  fields.customDays.required = custom;
  $('#result-name').textContent = fields.name.value.trim() || 'VPS';
  $('#result-name').title = fields.name.value.trim();
  $('#result-currency').textContent = 'CNY · 人民币';
  const fx = updateFxCaption();
  fields.endAt.setAttribute('aria-invalid', String(!fields.endAt.value));
  if (!fields.endAt.value) { resetResult('请选择到期日'); return; }
  try { parseDateOnly(fields.endAt.value); }
  catch {
    fields.endAt.setAttribute('aria-invalid', 'true');
    resetResult('请输入有效到期日（YYYY-MM-DD）');
    return;
  }
  if (!fields.amount.value) { resetResult(''); return; }
  try {
    const payload = readPayload();
    const original = calculateResidualValue(payload);
    if (payload.currency !== 'CNY' && (fx.loading || !fx.snapshot)) {
      resetResult(fx.error);
      if (!fx.loading && !fx.error) void fxClient.refresh();
      return;
    }
    const result = convertResultToCny(original, payload.currency, fx.snapshot);
    if (Array.from(payload.name).length > 80) throw new RangeError('VPS 名称不能超过 80 个字符');
    if (JSON.stringify(payload) !== JSON.stringify(currentPayload)) $('#share-output').hidden = true;
    currentPayload = Object.freeze(payload);
    shareClient.setPayload(payload);
    $('#form-error').textContent = '';
    $('#result-name').textContent = payload.name;
    $('#remaining-value').textContent = formatMoney(result.remainingValue, result.currency);
    $('#remaining-value').classList.toggle('is-long', $('#remaining-value').textContent.length > 13);
    $('#remaining-percent').textContent = `${(result.remainingRatio * 100).toFixed(2)}% 剩余`;
    $('#timeline-progress').style.width = `${(result.remainingRatio * 100).toFixed(4)}%`;
    $('#remaining-duration').textContent = formatDuration(result.remainingDays);
    $('#end-label').textContent = payload.endAt;
    $('#end-label').dateTime = payload.endAt;
    setReady(true);
  } catch (error) {
    resetResult(error instanceof RangeError || error instanceof TypeError ? error.message : '请检查输入内容');
  }
}

function refreshToday() {
  if (localToday() !== displayedToday) updateResult();
  clearTimeout(midnightTimer);
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  // Local midnight scheduling, but all valuation arithmetic remains civil-day based.
  midnightTimer = setTimeout(refreshToday, Math.max(100, midnight.getTime() - now.getTime() + 100));
}

function showToast(message) {
  const toast = $('#toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2200);
}

function assertCurrentShare(share) {
  refreshToday();
  if (!shareClient.isCurrent(share)) throw new Error('信息已更新，请重新导出');
}

async function getShare() {
  refreshToday();
  const revision = inputRevision;
  if (fields.currency.value !== 'CNY') {
    const fx = await fxClient.refresh();
    if (revision !== inputRevision) throw new Error('信息已更新，请重新导出');
    updateResult();
    if (!fx.snapshot || fx.error) throw new Error(fx.error || '请先获取汇率');
  }
  let share;
  try { share = await shareClient.get(); }
  catch (error) {
    if (error.statusCode === 409) await fxClient.refresh({ force: true });
    throw error;
  }
  assertCurrentShare(share);
  const link = $('#share-link');
  link.href = share.imageUrl;
  link.textContent = share.imageUrl;
  $('#share-output').hidden = false;
  return share;
}

async function copyText(text, successMessage) {
  let copied = false;
  if (navigator.clipboard && document.hasFocus()) {
    try { await navigator.clipboard.writeText(text); copied = true; }
    catch { copied = false; }
  }
  if (!copied) {
    const previousFocus = document.activeElement;
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.className = 'clipboard-fallback';
    document.body.append(textarea);
    textarea.focus();
    textarea.select();
    try { copied = document.execCommand('copy'); }
    finally { textarea.remove(); previousFocus?.focus({ preventScroll: true }); }
  }
  if (!copied) throw new Error('复制失败，请长按复制下方链接');
  showToast(successMessage);
}

async function withBusy(button, task) {
  if (busyButtons.has(button)) return;
  const original = button.innerHTML;
  busyButtons.add(button);
  button.disabled = true;
  button.textContent = '处理中…';
  try { await task(); }
  catch (error) { showToast(error instanceof Error ? error.message : '操作失败'); }
  finally {
    busyButtons.delete(button);
    button.innerHTML = original;
    button.disabled = !currentPayload;
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadPng() {
  const share = await getShare();
  const response = await fetch(share.imageUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error('图片下载失败');
  const blob = await response.blob();
  assertCurrentShare(share);
  const safeName = share.payload.name.replace(/[\\/:*?"<>|]/g, '-').slice(0, 50);
  downloadBlob(blob, `${safeName}-剩余价值.png`);
  showToast('PNG 已下载');
}

function onInputChange() { inputRevision++; updateResult(); }
createCustomControls(fields, { onChange: onInputChange });
form.addEventListener('submit', (event) => event.preventDefault());
form.addEventListener('input', onInputChange);
form.addEventListener('change', onInputChange);
$('#fx-retry').addEventListener('click', () => { void fxClient.refresh({ force: true }); });
window.addEventListener('focus', refreshToday);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshToday(); });
$('#download-png').addEventListener('click', (event) => withBusy(event.currentTarget, downloadPng));
$('#create-link').addEventListener('click', (event) => withBusy(event.currentTarget, async () => {
  const share = await getShare();
  await copyText(share.imageUrl, '图片直链已复制');
}));
$('#copy-markdown').addEventListener('click', (event) => withBusy(event.currentTarget, async () => {
  const share = await getShare();
  await copyText(share.markdown, 'Markdown 已复制');
}));
updateResult();
refreshToday();
