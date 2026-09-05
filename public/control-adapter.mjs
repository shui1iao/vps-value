import { BILLING_CYCLES, CURRENCIES, CURRENCY_NAMES, parseDateOnly, localToday } from './core.mjs';
import { createSelect, createDatePicker } from './controls.mjs';

// Primary interaction capability, not viewport size, UA, or secondary touch support.
export function nativeControlPreference(matchMedia = window.matchMedia?.bind(window)) {
  return matchMedia?.('(pointer: coarse) and (hover: none)') ?? { matches: false };
}

// Native date inputs sanitize invalid drafts to empty. Preserve them as text,
// without changing the user's preference for returning to the system picker.
export function dateInputType(native, manual, value) {
  if (!native || manual) return 'text';
  if (value) { try { parseDateOnly(value); } catch { return 'text'; } }
  return 'date';
}

// Replace, never overlay, the active fields. The shared fields object remains the
// app's single source of input values; native input/change events bubble to form.
export function createAdaptiveControls(fields, { onChange } = {}) {
  const preference = nativeControlPreference();
  const definitions = [
    { key: 'currency', label: '币种', value: 'CNY', options: CURRENCIES.map((value) => ({ value, label: value, description: CURRENCY_NAMES[value], nativeLabel: `${value} · ${CURRENCY_NAMES[value]}` })) },
    { key: 'billingCycle', label: '账单周期', value: 'annual', options: BILLING_CYCLES },
    { key: 'endAt', value: localToday() },
  ];
  let mode;
  let manualDate = false;
  let controllers = [];
  const picker = document.querySelector('#end-at-picker');
  const dateMode = document.querySelector('#end-at-mode');
  const dateAnchor = document.querySelector('#end-at-control');
  const preventDateSubmit = (event) => { if (event.key === 'Enter') event.preventDefault(); };

  function mount(force = false) {
    const nextMode = preference.matches ? 'native' : 'custom';
    if (mode === nextMode && force !== true) return;
    const active = document.activeElement;
    const focusedKey = active === picker || active === dateMode ? 'endAt' : definitions.find(({ key }) => fields[key] === active || active?.closest('.control-popover')?.id === `${fields[key].id}-popover`)?.key;
    const values = Object.fromEntries(definitions.map(({ key, value }) => [key, mode === undefined ? value : fields[key].value]));
    controllers.forEach((control) => control.destroy());
    controllers = [];

    for (const { key, label, options } of definitions) {
      const old = fields[key];
      let element;
      if (!options) {
        element = document.createElement('input');
        if (dateInputType(nextMode === 'native', manualDate, values[key]) === 'date') {
          element.type = 'date';
          element.min = '0001-01-01';
          element.max = '9999-12-31';
        } else {
          element.type = 'text';
          element.placeholder = 'YYYY-MM-DD';
          element.autocomplete = 'off';
          element.spellcheck = false;
          if (nextMode === 'custom') element.setAttribute('aria-keyshortcuts', 'Alt+ArrowDown');
        }
        element.required = true;
        element.addEventListener('keydown', preventDateSubmit);
        controllers.push({ destroy() { element.removeEventListener('keydown', preventDateSubmit); } });
      } else if (nextMode === 'native') {
        element = document.createElement('select');
        for (const option of options) {
          const item = document.createElement('option');
          item.value = option.value;
          item.textContent = option.nativeLabel || option.label;
          element.append(item);
        }
        element.required = true;
      } else {
        element = document.createElement('button');
        element.type = 'button';
        element.setAttribute('aria-haspopup', 'listbox');
        element.setAttribute('aria-expanded', 'false');
      }
      for (const attribute of ['id', 'name', 'aria-label', 'aria-describedby', 'aria-invalid']) {
        if (old.hasAttribute(attribute)) element.setAttribute(attribute, old.getAttribute(attribute));
      }
      element.className = nextMode === 'native' ? 'control-trigger native-control' : 'control-trigger';
      if (!options) element.classList.add('date-input');
      element.value = values[key];
      old.replaceWith(element);
      fields[key] = element;
      if (nextMode === 'custom') controllers.push(options
        ? createSelect(element, options, { value: values[key], label, onChange })
        : createDatePicker(picker, { input: element, anchor: dateAnchor, value: values[key], onChange }));
    }
    picker.hidden = nextMode !== 'custom';
    dateMode.hidden = nextMode !== 'native';
    dateMode.textContent = fields.endAt.type === 'date' ? '手动输入' : '选择日期';

    mode = nextMode;
    document.documentElement.dataset.controlMode = mode;
    if (focusedKey) fields[focusedKey].focus({ preventScroll: true });
  }

  function toggleDateMode() {
    if (mode !== 'native') return;
    const wantsManual = fields.endAt.type === 'date';
    if (!wantsManual && dateInputType(true, false, fields.endAt.value) !== 'date') {
      onChange?.();
      fields.endAt.setAttribute('aria-invalid', 'true');
      document.querySelector('#form-error').textContent = '请先输入有效日期（YYYY-MM-DD）或清空，再选择日期';
      fields.endAt.focus({ preventScroll: true });
      return;
    }
    manualDate = wantsManual;
    mount(true);
  }

  dateMode.addEventListener('click', toggleDateMode);
  mount();
  if (preference.addEventListener) preference.addEventListener('change', mount);
  else preference.addListener?.(mount);
  return {
    destroy() {
      dateMode.removeEventListener('click', toggleDateMode);
      if (preference.removeEventListener) preference.removeEventListener('change', mount);
      else preference.removeListener?.(mount);
      controllers.forEach((control) => control.destroy());
      controllers = [];
    },
  };
}
