/**
 * The delay rules (section 2 of the brief) and the IST formatting, on their
 * own. The same rules.js runs in the browser, so these also cover what the
 * form shows while you type.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../public/rules.js');

const TODAY = '2026-10-10';
const delay = (task) => R.computeDelay(task, TODAY);

test('today is taken in IST, not UTC', () => {
  // 18:29 UTC on 9 Oct is 23:59 IST on 9 Oct; a minute later it is 10 Oct in India.
  assert.equal(R.todayIst(new Date('2026-10-09T18:29:00Z')), '2026-10-09');
  assert.equal(R.todayIst(new Date('2026-10-09T18:30:00Z')), '2026-10-10');
});

test('times are shown in IST in the agreed format', () => {
  assert.equal(R.formatIst('2026-10-09T20:11:00Z'), '10 Oct 2026, 01:41 AM');
  assert.equal(R.formatIst('2026-10-10T06:30:00Z'), '10 Oct 2026, 12:00 PM');
  assert.equal(R.formatIst('2026-10-10T18:29:00Z'), '10 Oct 2026, 11:59 PM');
  assert.equal(R.formatIst('2026-10-09T18:30:00Z'), '10 Oct 2026, 12:00 AM');
  assert.equal(R.formatIst(null), '');
  assert.equal(R.formatDate('2026-10-05'), '05 Oct 2026');
});

test('no dates, or dates still ahead: not delayed', () => {
  assert.equal(delay({ status: 'Not Started' }).delayed, false);
  assert.equal(delay({ status: 'Not Started', planned_start: '2026-10-11', planned_end: '2026-10-20' }).delayed, false);
});

test('a planned date of today has not passed yet', () => {
  const d = delay({ status: 'Not Started', planned_start: TODAY, planned_end: TODAY });
  assert.equal(d.delayed, false);
});

test('actual start after planned start is a late start', () => {
  const d = delay({ status: 'In Progress', planned_start: '2026-10-01', actual_start: '2026-10-04' });
  assert.deepEqual([d.delayed, d.startDays, d.startOpen, d.endDays], [true, 3, false, 0]);
});

test('actual start on or before planned start is on time', () => {
  assert.equal(delay({ status: 'In Progress', planned_start: '2026-10-01', actual_start: '2026-10-01' }).delayed, false);
  assert.equal(delay({ status: 'In Progress', planned_start: '2026-10-01', actual_start: '2026-09-25' }).delayed, false);
});

test('actual end after planned end is a late end', () => {
  const d = delay({ status: 'Completed', planned_start: '2026-09-01', planned_end: '2026-09-10',
    actual_start: '2026-09-01', actual_end: '2026-09-15' });
  assert.deepEqual([d.delayed, d.startDays, d.endDays, d.endOpen], [true, 0, 5, false]);
});

test('planned start passed with no actual start: late and counting', () => {
  const d = delay({ status: 'Not Started', planned_start: '2026-10-07' });
  assert.deepEqual([d.delayed, d.startDays, d.startOpen], [true, 3, true]);
});

test('planned end passed and the task is not completed: late and counting', () => {
  const d = delay({ status: 'In Progress', planned_start: '2026-10-01', actual_start: '2026-10-01', planned_end: '2026-10-08' });
  assert.deepEqual([d.delayed, d.startDays, d.endDays, d.endOpen], [true, 0, 2, true]);
});

test('both start and end late are reported separately', () => {
  const d = delay({ status: 'In Progress', planned_start: '2026-10-01', actual_start: '2026-10-03', planned_end: '2026-10-05' });
  assert.deepEqual([d.startDays, d.endDays], [2, 5]);
});

test('a completed or cancelled task is not "still not started / not finished"', () => {
  assert.equal(delay({ status: 'Completed', planned_start: '2026-10-01', planned_end: '2026-10-05' }).delayed, false);
  assert.equal(delay({ status: 'Cancelled', planned_start: '2026-10-01', planned_end: '2026-10-05' }).delayed, false);
  // ...but recorded late dates still count, whatever the status.
  assert.equal(delay({ status: 'Cancelled', planned_start: '2026-10-01', actual_start: '2026-10-02' }).delayed, true);
});

test('On Hold still counts as not completed', () => {
  assert.equal(delay({ status: 'On Hold', planned_end: '2026-10-01' }).delayed, true);
});

test('reason missing is flagged only while delayed', () => {
  const late = { status: 'Not Started', planned_start: '2026-10-01' };
  assert.equal(delay(late).reasonMissing, true);
  assert.equal(delay({ ...late, delay_reason: '   ' }).reasonMissing, true);
  assert.equal(delay({ ...late, delay_reason: 'Vendor late' }).reasonMissing, false);
  // Dates corrected: no longer delayed, the reason is kept but no marker shows.
  const fixed = delay({ status: 'Not Started', planned_start: '2026-10-12', delay_reason: 'Vendor late' });
  assert.deepEqual([fixed.delayed, fixed.reasonMissing], [false, false]);
});
