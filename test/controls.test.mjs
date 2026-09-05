import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function withControls(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'vps-controls-'));
  try {
    await cp(new URL('../src/core.mjs', import.meta.url), path.join(dir, 'core.mjs'));
    await cp(new URL('../public/controls.mjs', import.meta.url), path.join(dir, 'controls.mjs'));
    await fn(await import(pathToFileURL(path.join(dir, 'controls.mjs'))));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('fallback closes without evaluating an unsupported native popover selector', () => withControls(({ hideNativePopover }) => {
  let hidden = 0;
  hideNativePopover({ matches: () => { throw new Error('Unsupported selector'); } });
  hideNativePopover({ matches: () => true, hidePopover: () => hidden++ });
  hideNativePopover({ matches: () => false, hidePopover: () => hidden++ });
  assert.equal(hidden, 1);
}));

test('list navigation supports arrows, Home and End without changing selection', () => withControls(({ nextOptionIndex }) => {
  assert.equal(nextOptionIndex('ArrowDown', 5, 6), 0);
  assert.equal(nextOptionIndex('ArrowUp', 0, 6), 5);
  assert.equal(nextOptionIndex('Home', 3, 6), 0);
  assert.equal(nextOptionIndex('End', 3, 6), 5);
  assert.equal(nextOptionIndex('Enter', 3, 6), null);
}));

test('calendar returns complete Sunday-first weeks with leap day and adjacent dates', () => withControls(({ calendarCells }) => {
  const days = calendarCells('2024-02-15');
  assert.equal(days.length, 42);
  assert.equal(days[0], '2024-01-28');
  assert.equal(days[41], '2024-03-09');
  assert.ok(days.includes('2024-02-29'));
}));

test('calendar keyboard moves by days, week edges and clamped calendar months', () => withControls(({ moveCalendarDate }) => {
  assert.equal(moveCalendarDate('2026-03-31', 'ArrowRight'), '2026-04-01');
  assert.equal(moveCalendarDate('2026-03-01', 'ArrowLeft'), '2026-02-28');
  assert.equal(moveCalendarDate('2026-03-10', 'ArrowUp'), '2026-03-03');
  assert.equal(moveCalendarDate('2026-03-10', 'ArrowDown'), '2026-03-17');
  assert.equal(moveCalendarDate('2026-03-10', 'Home'), '2026-03-08');
  assert.equal(moveCalendarDate('2026-03-10', 'End'), '2026-03-14');
  assert.equal(moveCalendarDate('2024-03-31', 'PageUp'), '2024-02-29');
  assert.equal(moveCalendarDate('2024-02-29', 'PageDown', true), '2025-02-28');
}));
