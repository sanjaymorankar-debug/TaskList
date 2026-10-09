/* TaskList screen. Plain browser JavaScript, no build step.
   Every API path is relative, so the page works at /tasklist/ whether it is
   reached directly or through the bkesari.com hub. */
(function () {
  'use strict';

  const R = window.TaskListRules;
  const $ = (id) => document.getElementById(id);

  const state = {
    meta: { statuses: R.STATUSES, today: R.todayIst(), people: [], projects: [] },
    all: [],         // every task, for the summary and the dependency picker
    current: null,   // the task open in the task screen, or null for a new one
    deps: [],        // Sr Nos picked in the open form
  };

  /* ---------- helpers ---------- */

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function statusClass(status) {
    return 's-' + String(status || '').toLowerCase().replace(/\s+/g, '-');
  }

  function badge(status) {
    return `<span class="badge ${statusClass(status)}">${esc(status)}</span>`;
  }

  function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

  async function api(path, options) {
    const opts = options || {};
    const res = await fetch(`api/${path}`, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data || {};
      throw err;
    }
    return data;
  }

  /** Short words for a task's delay, e.g. "Start 3 days late, end 5 days late (still counting)". */
  function delayWords(d) {
    const parts = [];
    if (d.startDays) parts.push(`start ${plural(d.startDays, 'day')} late${d.startOpen ? ' and counting' : ''}`);
    if (d.endDays) parts.push(`end ${plural(d.endDays, 'day')} late${d.endOpen ? ' and counting' : ''}`);
    const s = parts.join(', ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /* ---------- confirmation dialog ---------- */

  function askConfirm(title, text, yesLabel) {
    return new Promise((resolve) => {
      const dlg = $('confirmDlg');
      $('confirmTitle').textContent = title;
      $('confirmText').textContent = text;
      $('confirmYes').textContent = yesLabel || 'Continue';
      const done = (answer) => {
        $('confirmYes').onclick = null;
        $('confirmNo').onclick = null;
        dlg.onclose = null;
        if (dlg.open) dlg.close();
        resolve(answer);
      };
      $('confirmYes').onclick = () => done(true);
      $('confirmNo').onclick = () => done(false);
      dlg.onclose = () => done(false);
      dlg.showModal();
      $('confirmNo').focus();
    });
  }

  /* ---------- filters (kept in the address bar so a refresh keeps them) ---------- */

  const FILTERS = { q: 'fQ', status: 'fStatus', owner: 'fOwner', next_action_owner: 'fNextOwner', delayed: 'fDelayed', sort: 'fSort' };
  let sortDir = 'asc';
  let waitingOnly = false;

  function readFilters() {
    const f = {};
    for (const [key, id] of Object.entries(FILTERS)) {
      const v = $(id).value.trim();
      if (v && !(key === 'sort' && v === 'sr_no')) f[key] = v;
    }
    if (sortDir === 'desc') f.dir = 'desc';
    if (waitingOnly) f.waiting = '1';
    return f;
  }

  function filtersFromUrl() {
    const p = new URLSearchParams(location.search);
    for (const [key, id] of Object.entries(FILTERS)) {
      if (p.has(key)) {
        const el = $(id);
        if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === p.get(key))) {
          el.append(new Option(p.get(key), p.get(key)));
        }
        el.value = p.get(key);
      }
    }
    sortDir = p.get('dir') === 'desc' ? 'desc' : 'asc';
    waitingOnly = p.get('waiting') === '1';
  }

  function showSortState() {
    $('fDir').textContent = sortDir === 'desc' ? '↓ Desc' : '↑ Asc';
    const key = $('fSort').value;
    for (const th of document.querySelectorAll('th[data-sort]')) {
      if (th.dataset.sort === key) th.setAttribute('aria-sort', sortDir === 'desc' ? 'descending' : 'ascending');
      else th.removeAttribute('aria-sort');
    }
  }

  /* ---------- the list ---------- */

  function fillSelect(el, values, firstLabel) {
    const keep = el.value;
    el.innerHTML = `<option value="">${esc(firstLabel)}</option>`
      + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    if (keep && !values.includes(keep)) el.append(new Option(keep, keep));
    el.value = keep;
  }

  function renderMeta() {
    const m = state.meta;
    fillSelect($('fStatus'), m.statuses, 'All statuses');
    fillSelect($('fOwner'), uniq(state.all.map((t) => t.owner)), 'All owners');
    fillSelect($('fNextOwner'), uniq(state.all.map((t) => t.next_action_owner)), 'All next-action owners');
    $('peopleList').innerHTML = m.people.map((p) => `<option value="${esc(p)}">`).join('');
    $('projectList').innerHTML = m.projects.map((p) => `<option value="${esc(p.name)}">`).join('');
    $('statusSel').innerHTML = m.statuses.map((s) => `<option>${esc(s)}</option>`).join('');
    $('todayLine').textContent = `Today is ${R.formatDate(m.today)} (IST). Click a task to open it.`;
  }

  function uniq(values) {
    return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  function renderStats() {
    const all = state.all;
    const f = readFilters();
    const items = [
      { n: all.length, l: 'Tasks', on: !f.delayed && !waitingOnly && !f.status, act: 'all' },
      { n: all.filter((t) => t.status === 'In Progress').length, l: 'In progress', on: f.status === 'In Progress', act: 'progress' },
      { n: all.filter((t) => t.delay.delayed).length, l: 'Delayed', cls: 'bad', on: f.delayed === '1', act: 'delayed' },
      { n: all.filter((t) => t.delay.reasonMissing).length, l: 'Reason missing', cls: 'bad', on: f.delayed === 'reason-missing', act: 'missing' },
      { n: all.filter((t) => t.waiting).length, l: 'Waiting', cls: 'warn', on: waitingOnly, act: 'waiting' },
    ];
    $('stats').innerHTML = items.map((s) => `<button type="button" class="stat ${s.cls || ''} ${s.on ? 'on' : ''}" data-act="${s.act}" aria-pressed="${s.on}">
      <span class="stat-n">${s.n}</span><span class="stat-l">${esc(s.l)}</span></button>`).join('');
  }

  function delayCell(t) {
    const d = t.delay;
    if (!d.delayed) {
      return t.delay_reason ? '<span class="dim">On time now</span>' : '<span class="dim">—</span>';
    }
    return `<div class="delay-cell">
      <span class="badge b-delayed">Delayed</span>
      ${d.startDays ? `<small>Start +${d.startDays}d${d.startOpen ? ' (counting)' : ''}</small>` : ''}
      ${d.endDays ? `<small>End +${d.endDays}d${d.endOpen ? ' (counting)' : ''}</small>` : ''}
      ${d.reasonMissing ? '<span class="badge b-missing" title="Open the task to add a reason for delay">Reason missing</span>'
        : `<span class="clip" title="Reason for delay">${esc(t.delay_reason)}</span>`}
    </div>`;
  }

  function depsCell(t) {
    if (!t.depends_on.length) return '<span class="dim">—</span>';
    return `<div class="deps">
      ${t.waiting ? '<span class="badge b-waiting">Waiting</span>' : ''}
      ${t.depends_on.map((d) => `<span class="dep ${d.completed ? 'done' : 'open'}" title="${esc(d.name)} — ${esc(d.status)}">
        ${d.completed ? '✓' : '⏳'} #${d.sr_no} ${esc(d.name.length > 22 ? d.name.slice(0, 21) + '…' : d.name)}</span>`).join('')}
    </div>`;
  }

  function dateCell(label, value) {
    return `<td class="c-date" data-label="${label}">${value ? esc(R.formatDate(value)) : '<span class="dim">—</span>'}</td>`;
  }

  function textCell(label, value, wide) {
    return `<td class="c-text${wide ? ' c-wide' : ''}" data-label="${label}">${value ? `<div class="clip">${esc(value)}</div>` : '<span class="dim">—</span>'}</td>`;
  }

  function renderRows(tasks) {
    const body = $('rows');
    if (!tasks.length) {
      const filtered = Object.keys(readFilters()).some((k) => k !== 'sort' && k !== 'dir');
      body.innerHTML = `<tr><td colspan="13" class="empty">${filtered
        ? 'No task matches these filters.' : 'No tasks yet. Use “+ Add task” to add the first one.'}</td></tr>`;
      return;
    }
    body.innerHTML = tasks.map((t) => `<tr class="row${t.delay.delayed ? ' is-delayed' : ''}" tabindex="0" data-sr="${t.sr_no}">
      <td class="c-sr" data-label="Sr No.">#${t.sr_no}</td>
      <td class="c-name" data-label="Task Name"><div class="t-name">${esc(t.name)}</div>${t.project ? `<div class="t-proj">${esc(t.project)}</div>` : ''}</td>
      ${dateCell('Planned start', t.planned_start)}
      ${dateCell('Planned end', t.planned_end)}
      ${dateCell('Actual start', t.actual_start)}
      ${dateCell('Actual end', t.actual_end)}
      <td data-label="Status">${badge(t.status)}</td>
      <td data-label="Owner">${t.owner ? esc(t.owner) : '<span class="dim">—</span>'}</td>
      ${textCell('Next action', t.next_action, true)}
      <td data-label="Owner of next action">${t.next_action_owner ? esc(t.next_action_owner) : '<span class="dim">—</span>'}</td>
      <td data-label="Dependency">${depsCell(t)}</td>
      <td data-label="Delay">${delayCell(t)}</td>
      <td class="c-text c-wide" data-label="Latest comment">${t.latest_comment
        ? `<div class="clip">${esc(t.latest_comment.body)}</div>
           <div class="when">${esc(t.latest_comment.created_at_ist)}</div>
           <button type="button" class="link-btn" data-history="${t.sr_no}">Show history (${t.comment_count})</button>`
        : '<span class="dim">—</span>'}</td>
    </tr>`).join('');
  }

  let loadSeq = 0;
  async function refresh() {
    const seq = ++loadSeq;
    const f = readFilters();
    const qs = new URLSearchParams(f).toString();
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
    showSortState();
    try {
      const [meta, all, filtered] = await Promise.all([api('meta'), api('tasks'), api(`tasks?${qs}`)]);
      if (seq !== loadSeq) return; // a newer refresh has started
      state.meta = meta;
      state.all = all.tasks;
      renderMeta();
      renderStats();
      renderRows(filtered.tasks);
      $('countLine').textContent = filtered.tasks.length === all.tasks.length
        ? plural(all.tasks.length, 'task')
        : `Showing ${filtered.tasks.length} of ${plural(all.tasks.length, 'task')}`;
    } catch (err) {
      $('rows').innerHTML = `<tr><td colspan="13" class="empty">Could not load tasks: ${esc(err.message)}</td></tr>`;
    }
  }

  /* ---------- the task screen ---------- */

  const form = () => $('taskForm');

  function formValues() {
    const fd = new FormData(form());
    const v = {};
    for (const key of ['name', 'status', 'project', 'owner', 'planned_start', 'planned_end', 'actual_start',
      'actual_end', 'delay_reason', 'next_action', 'next_action_owner', 'description', 'comment']) {
      v[key] = String(fd.get(key) || '').trim();
    }
    v.depends_on = state.deps.slice();
    return v;
  }

  /** Shows the "Reason for delay" box when the dates as typed make the task late. */
  function updateDelayBox() {
    const v = formValues();
    const d = R.computeDelay(v, state.meta.today);
    const box = $('delayBox');
    const hasReason = Boolean(v.delay_reason);
    box.hidden = !d.delayed && !hasReason;
    box.classList.toggle('cleared', !d.delayed);
    $('delayLine').textContent = d.delayed
      ? `Delayed: ${delayWords(d)}.${d.reasonMissing ? ' Please give a reason.' : ''}`
      : 'Not delayed with these dates. The saved reason is kept.';
  }

  function taskLabel(t) {
    return `#${t.sr_no} ${t.name}`;
  }

  function renderDepPicker() {
    const self = state.current ? state.current.sr_no : null;
    const byNo = new Map(state.all.map((t) => [t.sr_no, t]));
    $('depChips').innerHTML = state.deps.length
      ? state.deps.map((n) => {
        const t = byNo.get(n) || { sr_no: n, name: '?', status: '?' };
        const done = t.status === 'Completed';
        return `<span class="chip ${done ? '' : 'open'}">${done ? '✓' : '⏳'} ${esc(taskLabel(t))}
          <span class="dim">(${esc(t.status)})</span>
          <button type="button" data-remove-dep="${n}" aria-label="Remove dependency on #${n}">✕</button></span>`;
      }).join('')
      : '<span class="dim">None. This task does not wait for any other.</span>';
    const options = state.all.filter((t) => t.sr_no !== self && !state.deps.includes(t.sr_no));
    $('depAdd').innerHTML = '<option value="">+ Add a task this one waits for…</option>'
      + options.map((t) => `<option value="${t.sr_no}">${esc(taskLabel(t))} (${esc(t.status)})</option>`).join('');
    $('depAdd').disabled = !options.length;
  }

  function refList(el, items, empty) {
    el.innerHTML = items.length
      ? items.map((d) => `<li>${badge(d.status)} <span>#${d.sr_no} ${esc(d.name)}</span></li>`).join('')
      : `<li class="none">${esc(empty)}</li>`;
  }

  function renderComments(comments) {
    $('comments').innerHTML = comments.length
      ? comments.map((c) => `<li><div class="when">${esc(c.created_at_ist)}</div><div class="c-body">${esc(c.body)}</div></li>`).join('')
      : '<li class="dim">No comments yet.</li>';
    $('historyBtn').textContent = `Show history (${comments.length})`;
    $('historyBtn').disabled = !comments.length;
  }

  async function openTask(srNo) {
    const dlg = $('taskDlg');
    const f = form();
    f.reset();
    $('formMsg').textContent = '';
    $('formMsg').className = 'msg';
    $('commentMsg').textContent = '';
    if (!state.all.length || srNo) {
      try { state.all = (await api('tasks')).tasks; } catch { /* keep what we have */ }
    }
    let task = null;
    if (srNo) {
      try {
        task = await api(`tasks/${srNo}`);
      } catch (err) {
        alert(`Could not open task #${srNo}: ${err.message}`);
        return;
      }
    }
    state.current = task;
    state.deps = task ? task.depends_on.map((d) => d.sr_no) : [];
    $('taskTitle').textContent = task ? `Task #${task.sr_no}` : 'New task';
    $('srNote').textContent = task
      ? `Sr No. ${task.sr_no} · added ${R.formatIst(task.created_at)}`
      : 'Sr No. is given automatically when you save.';
    for (const el of f.elements) {
      if (el.name && task && el.name in task && el.name !== 'comment') el.value = task[el.name] || '';
    }
    if (!task) f.elements.status.value = 'Not Started';
    $('firstCommentWrap').hidden = Boolean(task);
    $('deleteBtn').hidden = !task;
    $('sidePanel').hidden = !task;
    if (task) {
      refList($('waitsFor'), task.depends_on, 'Nothing. This task can go ahead.');
      refList($('waitedOnBy'), task.waited_on_by, 'No task waits for this one.');
      renderComments(task.comments);
    }
    renderDepPicker();
    updateDelayBox();
    const hash = task ? `#task-${task.sr_no}` : '#new';
    if (location.hash !== hash) history.replaceState(null, '', location.pathname + location.search + hash);
    if (!dlg.open) dlg.showModal();
    f.elements.name.focus();
  }

  function closeTask() {
    if ($('taskDlg').open) $('taskDlg').close();
  }

  async function saveTask(confirmed) {
    const body = formValues();
    if (!body.name) {
      showFormMsg('Task name is required.', true);
      form().elements.name.focus();
      return;
    }
    if (confirmed) body.confirm = true;
    const btn = $('saveBtn');
    btn.disabled = true;
    try {
      const saved = state.current
        ? await api(`tasks/${state.current.sr_no}`, { method: 'PUT', body })
        : await api('tasks', { method: 'POST', body });
      await refresh();
      await openTask(saved.sr_no);
      showFormMsg(`Saved task #${saved.sr_no}.`, false);
    } catch (err) {
      if (err.data && err.data.code === 'UNFINISHED_DEPENDENCIES') {
        btn.disabled = false;
        if (await askConfirm('Unfinished dependencies', err.message, `Set to ${body.status} anyway`)) return saveTask(true);
        showFormMsg('Not saved.', true);
        return;
      }
      showFormMsg(err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  function showFormMsg(text, isError) {
    $('formMsg').textContent = text;
    $('formMsg').className = `msg ${isError ? 'err' : 'ok'}`;
  }

  async function deleteTask() {
    const t = state.current;
    if (!t) return;
    if (!(await askConfirm(`Delete task #${t.sr_no}?`,
      `“${t.name}” and its ${plural(t.comment_count, 'comment')} will be deleted. Its Sr No. will not be used again.`, 'Delete'))) return;
    try {
      await api(`tasks/${t.sr_no}`, { method: 'DELETE' });
    } catch (err) {
      if (!(err.data && err.data.code === 'HAS_DEPENDENTS')) { showFormMsg(err.message, true); return; }
      if (!(await askConfirm('Other tasks wait for this one', err.message, 'Delete and remove links'))) return;
      try {
        await api(`tasks/${t.sr_no}?confirm=1`, { method: 'DELETE' });
      } catch (err2) { showFormMsg(err2.message, true); return; }
    }
    closeTask();
    refresh();
  }

  async function addComment(ev) {
    ev.preventDefault();
    const t = state.current;
    const box = ev.target.elements.body;
    const text = box.value.trim();
    if (!t || !text) return;
    const btn = ev.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api(`tasks/${t.sr_no}/comments`, { method: 'POST', body: { body: text } });
      box.value = '';
      $('commentMsg').textContent = '';
      renderComments(await api(`tasks/${t.sr_no}/comments`));
      refresh();
    } catch (err) {
      $('commentMsg').textContent = err.message;
      $('commentMsg').className = 'msg err';
    } finally {
      btn.disabled = false;
    }
  }

  async function openHistory(srNo) {
    const t = state.all.find((x) => x.sr_no === srNo) || state.current || { sr_no: srNo, name: '' };
    $('historyTitle').textContent = `Comment history · #${srNo} ${t.name}`;
    $('historySub').textContent = 'Loading…';
    $('historyList').innerHTML = '';
    if (!$('historyDlg').open) $('historyDlg').showModal();
    try {
      const rows = await api(`tasks/${srNo}/comments?order=asc`);
      $('historySub').textContent = `${plural(rows.length, 'comment')}, oldest first, newest last. Times are IST.`;
      $('historyList').innerHTML = rows.map((c, i) => `<li><span class="h-n">${i + 1}.</span>
        <span class="when">${esc(c.created_at_ist)}</span><span class="c-body">${esc(c.body)}</span></li>`).join('');
    } catch (err) {
      $('historySub').textContent = `Could not load the history: ${err.message}`;
    }
  }

  /* ---------- wiring ---------- */

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  function init() {
    filtersFromUrl();
    $('fQ').addEventListener('input', debounce(refresh, 250));
    for (const id of ['fStatus', 'fOwner', 'fNextOwner', 'fDelayed', 'fSort']) $(id).addEventListener('change', refresh);
    $('fDir').addEventListener('click', () => { sortDir = sortDir === 'asc' ? 'desc' : 'asc'; refresh(); });
    $('fClear').addEventListener('click', () => {
      for (const id of Object.values(FILTERS)) $(id).value = id === 'fSort' ? 'sr_no' : '';
      sortDir = 'asc';
      waitingOnly = false;
      refresh();
    });
    for (const th of document.querySelectorAll('th[data-sort]')) {
      th.addEventListener('click', () => {
        if ($('fSort').value === th.dataset.sort) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        else { $('fSort').value = th.dataset.sort; sortDir = 'asc'; }
        refresh();
      });
    }
    $('stats').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      $('fDelayed').value = act === 'delayed' ? '1' : act === 'missing' ? 'reason-missing' : '';
      $('fStatus').value = act === 'progress' ? 'In Progress' : '';
      waitingOnly = act === 'waiting';
      refresh();
    });

    $('rows').addEventListener('click', (ev) => {
      const h = ev.target.closest('[data-history]');
      if (h) { ev.stopPropagation(); openHistory(Number(h.dataset.history)); return; }
      const row = ev.target.closest('tr[data-sr]');
      if (row) openTask(Number(row.dataset.sr));
    });
    $('rows').addEventListener('keydown', (ev) => {
      const row = ev.target.closest('tr[data-sr]');
      if (row && ev.target === row && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); openTask(Number(row.dataset.sr)); }
    });

    $('addBtn').addEventListener('click', () => openTask(null));
    form().addEventListener('submit', (ev) => { ev.preventDefault(); saveTask(false); });
    form().addEventListener('input', (ev) => { if (ev.target.name !== 'comment') updateDelayBox(); });
    form().addEventListener('change', updateDelayBox);
    $('deleteBtn').addEventListener('click', deleteTask);
    $('depAdd').addEventListener('change', (ev) => {
      const n = Number(ev.target.value);
      if (n && !state.deps.includes(n)) state.deps.push(n);
      showFormMsg('', false);
      renderDepPicker();
    });
    $('depChips').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-remove-dep]');
      if (!b) return;
      state.deps = state.deps.filter((n) => n !== Number(b.dataset.removeDep));
      showFormMsg('', false);
      renderDepPicker();
    });
    $('commentForm').addEventListener('submit', addComment);
    $('historyBtn').addEventListener('click', () => state.current && openHistory(state.current.sr_no));

    for (const btn of document.querySelectorAll('[data-close]')) {
      btn.addEventListener('click', () => btn.closest('dialog').close());
    }
    $('taskDlg').addEventListener('close', () => {
      state.current = null;
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    });

    refresh().then(() => {
      const m = /^#task-(\d+)$/.exec(location.hash);
      if (m) openTask(Number(m[1]));
      else if (location.hash === '#new') openTask(null);
    });
  }

  init();
})();
