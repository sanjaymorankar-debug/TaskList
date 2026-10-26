/**
 * TaskList rules shared by the server and the browser: the statuses, the delay
 * rules, and how times are shown in IST.
 *
 * One file for both so the list (computed on the server) and the form (which
 * shows the "Reason for delay" box as you type dates) can never disagree.
 *
 *   Node:    require('../public/rules.js')
 *   Browser: <script src="rules.js"></script>, then window.TaskListRules
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TaskListRules = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const STATUSES = ['Not Started', 'In Progress', 'On Hold', 'Completed', 'Cancelled'];
  // Setting one of these while a dependency is unfinished needs confirming.
  const ACTIVE_STATUSES = ['In Progress', 'Completed'];
  const TIME_ZONE = 'Asia/Kolkata';
  // IST is UTC+05:30 all year; India has no daylight saving.
  const IST_OFFSET_MINUTES = 330;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** Today's date in IST as 'YYYY-MM-DD'. */
  function todayIst(now) {
    const d = new Date((now ? new Date(now) : new Date()).getTime() + IST_OFFSET_MINUTES * 60000);
    return d.toISOString().slice(0, 10);
  }

  /** Whole days from date `a` to date `b` (both 'YYYY-MM-DD'); positive when b is later. */
  function daysBetween(a, b) {
    return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  }

  /**
   * How late a task is, by the rules in the brief:
   *
   *   Start is late when the actual start is after the planned start, or when
   *   the planned start has passed and there is no actual start yet.
   *   End is late when the actual end is after the planned end, or when the
   *   planned end has passed and there is no actual end yet.
   *
   * "Passed" means strictly before today (IST): a task planned to start today
   * is not late today. The "not yet" cases skip a task that is Cancelled, and
   * skip a Completed task, since its status already says it has started and
   * finished; dates actually recorded still count for every status.
   *
   * Returns { delayed, startDays, endDays, startOpen, endOpen, reasonMissing }.
   * startOpen/endOpen are true when the days are still counting up.
   */
  function computeDelay(task, today) {
    const t = task || {};
    const day = today || todayIst();
    const closed = t.status === 'Completed' || t.status === 'Cancelled';
    let startDays = 0, endDays = 0, startOpen = false, endOpen = false;

    if (t.planned_start) {
      if (t.actual_start) {
        startDays = Math.max(0, daysBetween(t.planned_start, t.actual_start));
      } else if (!closed && t.planned_start < day) {
        startDays = daysBetween(t.planned_start, day);
        startOpen = true;
      }
    }
    if (t.planned_end) {
      if (t.actual_end) {
        endDays = Math.max(0, daysBetween(t.planned_end, t.actual_end));
      } else if (!closed && t.planned_end < day) {
        endDays = daysBetween(t.planned_end, day);
        endOpen = true;
      }
    }
    const delayed = startDays > 0 || endDays > 0;
    const reason = typeof t.delay_reason === 'string' ? t.delay_reason.trim() : '';
    return { delayed, startDays, endDays, startOpen, endOpen, reasonMissing: delayed && !reason };
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  /** A stored moment shown in IST, e.g. '10 Oct 2026, 01:41 AM'. */
  function formatIst(value) {
    if (!value) return '';
    const ms = new Date(value).getTime();
    if (Number.isNaN(ms)) return '';
    const d = new Date(ms + IST_OFFSET_MINUTES * 60000);
    const h24 = d.getUTCHours();
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, `
      + `${pad(h12)}:${pad(d.getUTCMinutes())} ${h24 < 12 ? 'AM' : 'PM'}`;
  }

  /** A calendar date 'YYYY-MM-DD' shown as '10 Oct 2026'. */
  function formatDate(value) {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
    const [y, m, d] = value.split('-').map(Number);
    return `${pad(d)} ${MONTHS[m - 1]} ${y}`;
  }

  return { STATUSES, ACTIVE_STATUSES, TIME_ZONE, todayIst, daysBetween, computeDelay, formatIst, formatDate };
});
