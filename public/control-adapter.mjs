import { BILLING_CYCLES, CURRENCIES, CURRENCY_NAMES, localToday } from './core.mjs';
import { createSelect, createDatePicker } from './controls.mjs';

// All devices share the existing custom controllers and stable HTML fields.
// Expiry defaults once here; subsequent edits and day refreshes never remount it.
export function createCustomControls(fields, { onChange } = {}) {
  const input = fields.endAt;
  const preventDateSubmit = (event) => { if (event.key === 'Enter') event.preventDefault(); };
  input.setAttribute('aria-keyshortcuts', 'Alt+ArrowDown');
  input.addEventListener('keydown', preventDateSubmit);
  let controllers = [
    createSelect(fields.currency, CURRENCIES.map((value) => ({ value, label: value, description: CURRENCY_NAMES[value] })), { value: 'CNY', label: '币种', onChange }),
    createSelect(fields.billingCycle, BILLING_CYCLES, { value: 'annual', label: '账单周期', onChange }),
    createDatePicker(document.querySelector('#end-at-picker'), {
      input, anchor: document.querySelector('#end-at-control'), value: localToday(), onChange,
    }),
  ];
  document.documentElement.dataset.controlMode = 'custom';
  return {
    destroy() {
      input.removeEventListener('keydown', preventDateSubmit);
      controllers.forEach((control) => control.destroy());
      controllers = [];
    },
  };
}
