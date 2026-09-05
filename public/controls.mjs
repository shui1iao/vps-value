import { parseDateOnly, serialToDate, addCalendarMonths, daysInMonth, localToday } from './core.mjs';

export function nextOptionIndex(key, index, count) {
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowUp') return (index - 1 + count) % count;
  return null;
}

const weekday = (serial) => ((serial + 4) % 7 + 7) % 7;
export function calendarCells(value) {
  const first = parseDateOnly(`${value.slice(0, 7)}-01`);
  const initial = first - weekday(first);
  return Array.from({ length: 42 }, (_, index) => {
    try { return serialToDate(initial + index); } catch { return null; }
  });
}

export function moveCalendarDate(value, key, shift = false) {
  const day = parseDateOnly(value);
  const deltas = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday(day), End: 6 - weekday(day) };
  try {
    if (key === 'PageUp' || key === 'PageDown') return addCalendarMonths(value, (key === 'PageUp' ? -1 : 1) * (shift ? 12 : 1));
    return key in deltas ? serialToDate(day + deltas[key]) : null;
  } catch { return value; }
}

const chevron = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg>';
const calendarIcon = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="4.5" width="14" height="12.5" rx="3"/><path d="M6.5 3v3M13.5 3v3M3 8.5h14"/></svg>';
const check = '<svg class="option-check" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 10 3.5 3.5L15 7"/></svg>';
let activePopover = null;

export function hideNativePopover(panel) {
  if (typeof panel.hidePopover === 'function' && panel.matches(':popover-open')) panel.hidePopover();
}

function focusElement(element) { element?.focus({ preventScroll: true }); }
function movePastTrigger(trigger, backwards) {
  const items = [...document.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), [tabindex="0"]')]
    .filter((item) => item.getClientRects().length && !item.closest('.control-popover') && item.tabIndex >= 0);
  const index = items.indexOf(trigger);
  focusElement(items[index + (backwards ? -1 : 1)] || trigger);
}

function createPopover(trigger, kind, label, { anchor = trigger, returnFocus = trigger, id = `${trigger.id}-popover` } = {}) {
  const panel = document.createElement('div');
  panel.id = id;
  panel.className = `control-popover ${kind}-popover`;
  panel.hidden = true;
  panel.setAttribute('role', kind === 'select' ? 'listbox' : 'dialog');
  panel.setAttribute('aria-label', label);
  if (typeof panel.showPopover === 'function') panel.setAttribute('popover', 'manual');
  document.body.append(panel);
  trigger.setAttribute('aria-controls', panel.id);
  let opened = false;

  function position() {
    if (!opened) return;
    const viewport = window.visualViewport;
    const width = viewport?.width || document.documentElement.clientWidth;
    const height = viewport?.height || window.innerHeight;
    const left = viewport?.offsetLeft || 0;
    const top = viewport?.offsetTop || 0;
    const rect = anchor.getBoundingClientRect();
    panel.style.width = `${Math.min(kind === 'date' ? 312 : Math.max(trigger.id === 'currency' ? 296 : 224, rect.width), width - 24)}px`;
    panel.style.maxHeight = `${Math.max(80, height - 24)}px`;
    const size = panel.getBoundingClientRect();
    const below = rect.bottom + 7;
    const above = rect.top - size.height - 7;
    const y = below + size.height <= top + height - 12 ? below : above;
    const preferredLeft = kind === 'select' && size.width > rect.width ? rect.right - size.width : rect.left;
    panel.style.left = `${Math.max(left + 12, Math.min(preferredLeft, left + width - size.width - 12))}px`;
    panel.style.top = `${Math.max(top + 12, Math.min(y, top + height - size.height - 12))}px`;
  }
  function outside(event) {
    if (!panel.contains(event.target) && !trigger.contains(event.target)) close(true);
  }
  function focusOutside(event) {
    if (!panel.contains(event.target) && !trigger.contains(event.target)) close(false);
  }
  function close(restore = true) {
    if (!opened) return;
    opened = false;
    hideNativePopover(panel);
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (activePopover === api) activePopover = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('focusin', focusOutside);
    document.removeEventListener('keydown', escape, true);
    window.removeEventListener('resize', position);
    window.removeEventListener('scroll', position, true);
    window.visualViewport?.removeEventListener('resize', position);
    window.visualViewport?.removeEventListener('scroll', position);
    if (restore) focusElement(returnFocus);
  }
  function escape(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }
  function open(render) {
    if (opened) return;
    activePopover?.close(false);
    activePopover = api;
    opened = true;
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    render();
    if (typeof panel.showPopover === 'function') panel.showPopover();
    position();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', focusOutside);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
  }
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const buttons = [...panel.querySelectorAll('button:not(:disabled)')].filter((button) => button.tabIndex >= 0);
    const edge = event.shiftKey ? buttons[0] : buttons.at(-1);
    if (kind === 'select' || document.activeElement === edge) {
      event.preventDefault();
      close(false);
      movePastTrigger(trigger, event.shiftKey);
    }
  });
  const api = { panel, open, close, position, destroy() { close(false); panel.remove(); }, get opened() { return opened; } };
  return api;
}

function button(label, className = '') {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  return node;
}

export function createSelect(trigger, options, { value, label, onChange }) {
  const popover = createPopover(trigger, 'select', `${label}选项`);
  const { panel } = popover;
  let current = value;
  function setValue(next) {
    const option = options.find((item) => item.value === next);
    if (!option) return;
    current = next;
    trigger.value = next;
    trigger.innerHTML = '<span data-control-value></span>' + chevron;
    trigger.querySelector('span').textContent = option.label;
  }
  function select(next) {
    setValue(next);
    popover.close();
    onChange?.(next);
  }
  function render() {
    panel.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'popover-heading';
    heading.setAttribute('role', 'presentation');
    heading.textContent = `选择${label}`;
    panel.append(heading);
    options.forEach((option) => {
      const item = button('', 'control-option');
      item.dataset.value = option.value;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.value === current));
      item.tabIndex = option.value === current ? 0 : -1;
      item.innerHTML = '<span></span>' + check;
      item.querySelector('span').textContent = option.label;
      if (option.description) {
        const description = document.createElement('small');
        description.textContent = option.description;
        item.querySelector('span').append(description);
      }
      item.addEventListener('click', () => select(option.value));
      panel.append(item);
    });
  }
  function open(key) {
    popover.open(render);
    const items = [...panel.querySelectorAll('[role="option"]')];
    const initial = key === 'Home' ? 0 : key === 'End' ? items.length - 1 : options.findIndex((item) => item.value === current);
    focusElement(items[Math.max(0, initial)]);
  }
  const handleClick = () => popover.opened ? popover.close() : open();
  const handleKeydown = (event) => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      open(event.key);
    }
  };
  trigger.addEventListener('click', handleClick);
  trigger.addEventListener('keydown', handleKeydown);
  panel.addEventListener('keydown', (event) => {
    const items = [...panel.querySelectorAll('[role="option"]')];
    const currentIndex = items.indexOf(document.activeElement);
    const index = nextOptionIndex(event.key, currentIndex, items.length);
    if (index !== null) {
      event.preventDefault();
      items.forEach((item, i) => { item.tabIndex = i === index ? 0 : -1; });
      focusElement(items[index]);
    }
    // Enter / Space activate the focused native button, never the closed trigger.
  });
  setValue(value);
  return {
    setValue, get value() { return current; },
    destroy() {
      popover.destroy();
      trigger.removeEventListener('click', handleClick);
      trigger.removeEventListener('keydown', handleKeydown);
    },
  };
}

export function createDatePicker(trigger, { value, onChange, input, anchor = trigger }) {
  const popover = createPopover(trigger, 'date', '选择到期日', { anchor, returnFocus: input || trigger, id: `${(input || trigger).id}-popover` });
  const { panel } = popover;
  let current = value;
  let cursor = value;
  let view = 'days';
  let yearPage = 0;
  function setValue(next) {
    // Keep blank/out-of-range native input intact for shared form validation.
    // Only choosing a date commits a new value; opening is never a default.
    current = next;
    if (input) {
      input.value = next;
      trigger.innerHTML = calendarIcon;
    } else {
      trigger.value = next;
      trigger.innerHTML = '<span data-control-value></span>' + calendarIcon;
      trigger.querySelector('span').textContent = next || '选择日期';
    }
  }
  function choose(next) { setValue(next); popover.close(); onChange?.(next); }
  function setMonthYear(year, month) {
    const day = Math.min(Number(cursor.slice(8)), daysInMonth(year, month));
    cursor = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  function focusCursor() {
    const selector = view === 'days' ? `[data-date="${cursor}"]` : view === 'months' ? `[data-month="${Number(cursor.slice(5, 7))}"]` : `[data-year="${Number(cursor.slice(0, 4))}"]`;
    focusElement(panel.querySelector(selector) || panel.querySelector('.calendar-options button'));
  }
  function navigate(direction, refocus) {
    if (view === 'years') yearPage = Math.min(9988, Math.max(1, yearPage + direction * 12));
    else {
      try { cursor = addCalendarMonths(cursor, direction * (view === 'months' ? 12 : 1)); } catch { return; }
    }
    render();
    if (refocus) focusElement(panel.querySelector(refocus));
    else focusCursor();
  }
  function render() {
    panel.replaceChildren();
    const [year, month] = cursor.split('-').map(Number);
    const header = document.createElement('div');
    header.className = 'calendar-header';
    const previous = button('‹', 'calendar-nav');
    const next = button('›', 'calendar-nav');
    previous.dataset.action = 'previous';
    next.dataset.action = 'next';
    previous.setAttribute('aria-label', view === 'years' ? '前 12 年' : view === 'months' ? '上一年' : '上个月');
    next.setAttribute('aria-label', view === 'years' ? '后 12 年' : view === 'months' ? '下一年' : '下个月');
    previous.addEventListener('click', () => navigate(-1, '[data-action="previous"]'));
    next.addEventListener('click', () => navigate(1, '[data-action="next"]'));
    const titles = document.createElement('div');
    titles.className = 'calendar-title';
    const yearButton = button(view === 'years' ? `${yearPage}–${Math.min(9999, yearPage + 11)}` : `${year} 年`);
    yearButton.dataset.action = 'choose-year';
    yearButton.setAttribute('aria-label', '选择年份');
    yearButton.addEventListener('click', () => {
      view = view === 'years' ? 'days' : 'years';
      yearPage = Math.min(9988, Math.max(1, year - year % 12));
      render(); focusCursor();
    });
    const monthButton = button(`${month} 月`);
    monthButton.dataset.action = 'choose-month';
    monthButton.setAttribute('aria-label', '选择月份');
    monthButton.addEventListener('click', () => { view = view === 'months' ? 'days' : 'months'; render(); focusCursor(); });
    titles.append(yearButton, monthButton);
    header.append(previous, titles, next);
    const announcement = document.createElement('span');
    announcement.className = 'sr-only';
    announcement.setAttribute('aria-live', 'polite');
    announcement.textContent = view === 'years' ? `${yearPage} 至 ${Math.min(9999, yearPage + 11)} 年` : `${year} 年 ${month} 月`;
    panel.append(header, announcement);
    if (view === 'days') {
      const grid = document.createElement('div');
      grid.className = 'calendar-grid';
      grid.setAttribute('role', 'grid');
      grid.setAttribute('aria-label', `${year} 年 ${month} 月`);
      const weekdays = document.createElement('div');
      weekdays.className = 'calendar-week';
      weekdays.setAttribute('role', 'row');
      for (const label of ['日', '一', '二', '三', '四', '五', '六']) {
        const day = document.createElement('span'); day.setAttribute('role', 'columnheader'); day.textContent = label; weekdays.append(day);
      }
      grid.append(weekdays);
      const cells = calendarCells(cursor);
      for (let row = 0; row < 6; row++) {
        const week = document.createElement('div'); week.className = 'calendar-week'; week.setAttribute('role', 'row');
        for (const date of cells.slice(row * 7, row * 7 + 7)) {
          const day = button(date ? String(Number(date.slice(8))) : '', 'calendar-day');
          day.setAttribute('role', 'gridcell');
          day.tabIndex = date === cursor ? 0 : -1;
          if (!date) day.disabled = true;
          else {
            day.dataset.date = date;
            day.setAttribute('aria-label', date);
            day.setAttribute('aria-selected', String(date === current));
            if (date === localToday()) day.setAttribute('aria-current', 'date');
            day.classList.toggle('is-outside', date.slice(0, 7) !== cursor.slice(0, 7));
            day.addEventListener('click', () => choose(date));
          }
          week.append(day);
        }
        grid.append(week);
      }
      panel.append(grid);
    } else {
      const choices = document.createElement('div');
      choices.className = 'calendar-options';
      choices.setAttribute('role', 'listbox');
      choices.setAttribute('aria-label', view === 'months' ? '选择月份' : '选择年份');
      for (let index = 0; index < 12; index++) {
        const number = view === 'months' ? index + 1 : yearPage + index;
        const item = button(view === 'months' ? `${number} 月` : `${number}`, 'control-option');
        const selected = number === (view === 'months' ? month : year);
        item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(selected));
        item.tabIndex = selected || (view === 'years' && (year < yearPage || year > yearPage + 11) && index === 0) ? 0 : -1;
        if (view === 'months') item.dataset.month = number; else item.dataset.year = number;
        item.addEventListener('click', () => {
          setMonthYear(view === 'months' ? year : number, view === 'months' ? number : month);
          view = view === 'years' ? 'months' : 'days';
          render(); focusCursor();
        });
        choices.append(item);
      }
      panel.append(choices);
    }
    const footer = document.createElement('div'); footer.className = 'calendar-footer';
    const today = button('今天'); today.dataset.action = 'today';
    today.addEventListener('click', () => choose(localToday()));
    const help = document.createElement('span'); help.textContent = '仅选择日期';
    footer.append(today, help); panel.append(footer);
    popover.position();
  }
  function open() {
    current = input?.value ?? current;
    try { parseDateOnly(current); cursor = current; }
    catch { cursor = localToday(); }
    view = 'days';
    popover.open(render); focusCursor();
  }
  const handleClick = () => popover.opened ? popover.close() : open();
  const handleKeydown = (event) => {
    if (['ArrowDown', 'Enter', ' '].includes(event.key)) { event.preventDefault(); open(); }
  };
  const handleInputKeydown = (event) => {
    if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); open(); }
  };
  trigger.addEventListener('click', handleClick);
  trigger.addEventListener('keydown', handleKeydown);
  input?.addEventListener('keydown', handleInputKeydown);
  panel.addEventListener('keydown', (event) => {
    const target = event.target;
    if (target.dataset.date) {
      const next = moveCalendarDate(target.dataset.date, event.key, event.shiftKey);
      if (next) { event.preventDefault(); cursor = next; render(); focusCursor(); }
    } else if (target.closest('.calendar-options')) {
      const choices = [...panel.querySelectorAll('.calendar-options button')];
      const index = choices.indexOf(target);
      const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 };
      let next = null;
      if (event.key in offsets) next = (index + offsets[event.key] + choices.length) % choices.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = choices.length - 1;
      if (next !== null) {
        event.preventDefault(); choices.forEach((item, i) => { item.tabIndex = i === next ? 0 : -1; }); focusElement(choices[next]);
      }
      if (event.key === 'PageUp' || event.key === 'PageDown') { event.preventDefault(); navigate(event.key === 'PageUp' ? -1 : 1); }
    }
  });
  setValue(value);
  return {
    setValue, get value() { return current; },
    destroy() {
      popover.destroy();
      trigger.removeEventListener('click', handleClick);
      trigger.removeEventListener('keydown', handleKeydown);
      input?.removeEventListener('keydown', handleInputKeydown);
    },
  };
}
