/**
 * Every API route, against PostgreSQL, with "today" fixed at 10 Oct 2026 IST.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { freshDatabase, startApp, TODAY } = require('./helpers');

let pool, app;
test.before(async () => {
  pool = await freshDatabase();
  app = await startApp(pool);
});
test.after(async () => {
  await app.close();
  await pool.end();
});

const api = (...a) => app.api(...a);

async function create(fields) {
  const r = await api('tasks', { method: 'POST', body: { name: 'Task', ...fields } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

async function update(srNo, fields) {
  const current = (await api(`tasks/${srNo}`)).body;
  const body = {
    name: current.name, description: current.description, project: current.project, status: current.status,
    owner: current.owner, planned_start: current.planned_start, planned_end: current.planned_end,
    actual_start: current.actual_start, actual_end: current.actual_end, delay_reason: current.delay_reason,
    next_action: current.next_action, next_action_owner: current.next_action_owner,
    depends_on: current.depends_on.map((d) => d.sr_no), ...fields,
  };
  return api(`tasks/${srNo}`, { method: 'PUT', body });
}

/* ---------- pages and routing ---------- */

test('/tasklist redirects to /tasklist/, keeping the query', async () => {
  const r = await app.request('/tasklist?status=Completed');
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/tasklist/?status=Completed');
  const root = await app.request('/');
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/tasklist/');
});

test('/tasklist/ serves the screen, with the shared menu loaded from the hub', async () => {
  const r = await app.request('/tasklist/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.body, /<script src="\/shared\/menu\.js" defer><\/script>/);
  assert.match(r.body, /<title>TaskList<\/title>/);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  for (const file of ['app.js', 'app.css', 'rules.js']) {
    assert.equal((await app.request(`/tasklist/${file}`)).status, 200, file);
  }
});

test('the page has every column the brief lists, in order', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const heads = [...html.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(heads, ['Sr No.', 'Task Name', 'Planned start', 'Planned end', 'Actual start', 'Actual end',
    'Status', 'Owner', 'Next action', 'Owner of next action', 'Dependency', 'Delay', 'Latest comment']);
});

test('without a hub configured, /shared/menu.js is not served by TaskList', async () => {
  assert.equal((await app.request('/shared/menu.js')).status, 404);
});

test('with TASKLIST_HUB_ORIGIN set, /shared/menu.js is relayed from the hub', async () => {
  const http = require('node:http');
  const hub = http.createServer((req, res) => {
    if (req.url === '/shared/menu.js') { res.setHeader('Content-Type', 'application/javascript'); res.end('/* menu */'); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => hub.listen(0, '127.0.0.1', r));
  const relay = await startApp(pool, { hubOrigin: `http://127.0.0.1:${hub.address().port}` });
  try {
    const r = await relay.request('/shared/menu.js');
    assert.equal(r.status, 200);
    assert.equal(r.body, '/* menu */');
    assert.equal((await relay.request('/shared/nope.js')).status, 404);
    assert.equal((await relay.request('/shared/..%2Fsecret')).status, 404);
  } finally {
    await relay.close();
    await new Promise((r) => hub.close(r));
  }
});

test('unknown API paths and bad Sr Nos are 404 JSON', async () => {
  assert.equal((await api('nope')).status, 404);
  assert.equal((await api('tasks/abc')).status, 404);
  assert.equal((await api('tasks/0')).status, 404);
  assert.equal((await api('tasks/999999')).status, 404);
  assert.equal((await api('tasks/999999', { method: 'PUT', body: { name: 'x' } })).status, 404);
  assert.equal((await api('tasks/999999', { method: 'DELETE' })).status, 404);
  assert.equal((await api('tasks/999999/comments')).status, 404);
  assert.equal((await api('tasks/999999/comments', { method: 'POST', body: { body: 'x' } })).status, 404);
});

test('malformed JSON is a 400, not a crash', async () => {
  const r = await api('tasks', { method: 'POST', raw: '{nope', headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not valid JSON/);
});

/* ---------- task fields and rules ---------- */

test('creating a task stores every field and returns it', async () => {
  const t = await create({
    name: '  Order cement  ', description: 'For the east wall', project: 'Site A', status: 'In Progress',
    owner: 'Ramesh', planned_start: '2026-10-01', planned_end: '2026-10-20', actual_start: '2026-10-01',
    next_action: 'Call supplier', next_action_owner: 'Suresh',
  });
  assert.equal(t.name, 'Order cement');
  assert.equal(t.project, 'Site A');
  assert.equal(t.status, 'In Progress');
  assert.equal(t.owner, 'Ramesh');
  assert.equal(t.next_action, 'Call supplier');
  assert.equal(t.next_action_owner, 'Suresh', 'owner of next action can differ from the task owner');
  assert.equal(t.planned_start, '2026-10-01');
  assert.equal(t.actual_end, null);
  assert.equal(typeof t.sr_no, 'number');
  const again = (await api(`tasks/${t.sr_no}`)).body;
  assert.equal(again.name, 'Order cement');
  assert.deepEqual(again.comments, []);
});

test('task name is required', async () => {
  for (const name of [undefined, '', '   ']) {
    const r = await api('tasks', { method: 'POST', body: { name } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'Task name is required');
  }
});

test('status must be one of the five', async () => {
  const r = await api('tasks', { method: 'POST', body: { name: 'x', status: 'Done' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Not Started, In Progress, On Hold, Completed, Cancelled/);
  const meta = (await api('meta')).body;
  assert.deepEqual(meta.statuses, ['Not Started', 'In Progress', 'On Hold', 'Completed', 'Cancelled']);
  assert.equal((await create({ name: 'defaults' })).status, 'Not Started');
});

test('planned end cannot be before planned start', async () => {
  const r = await api('tasks', { method: 'POST', body: { name: 'x', planned_start: '2026-10-10', planned_end: '2026-10-09' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Planned end date cannot be before planned start date');
  await create({ name: 'same day ok', planned_start: '2026-10-10', planned_end: '2026-10-10' });
});

test('actual end cannot be before actual start', async () => {
  const r = await api('tasks', { method: 'POST', body: { name: 'x', actual_start: '2026-10-05', actual_end: '2026-10-04' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Actual end date cannot be before actual start date');
  // The same rule on edit.
  const t = await create({ name: 'edit me', actual_start: '2026-10-05' });
  const u = await update(t.sr_no, { actual_end: '2026-10-01' });
  assert.equal(u.status, 400);
});

test('dates must be real calendar dates', async () => {
  for (const bad of ['2026-02-30', '10/10/2026', '2026-1-1', 'tomorrow']) {
    const r = await api('tasks', { method: 'POST', body: { name: 'x', planned_start: bad } });
    assert.equal(r.status, 400, bad);
    assert.match(r.body.error, /Planned start date must be a valid date/);
  }
});

test('the database itself refuses reversed dates too', async () => {
  await assert.rejects(pool.query(
    "INSERT INTO tasks (name, planned_start, planned_end) VALUES ('x', '2026-10-10', '2026-10-01')"), /tasks_planned_order/);
});

/* ---------- Sr No. ---------- */

test('Sr No. counts up and is never reused, even after deletes', async () => {
  const a = await create({ name: 'sr a' });
  const b = await create({ name: 'sr b' });
  assert.equal(b.sr_no, a.sr_no + 1);
  assert.equal((await api(`tasks/${b.sr_no}`, { method: 'DELETE' })).status, 200);
  const c = await create({ name: 'sr c' });
  assert.equal(c.sr_no, b.sr_no + 1, 'the deleted number is skipped, not handed out again');
  assert.equal((await api(`tasks/${b.sr_no}`)).status, 404);
});

test('Sr No. cannot be chosen by the client or changed by an edit', async () => {
  const t = await create({ name: 'fixed', sr_no: 999 });
  assert.notEqual(t.sr_no, 999);
  const u = await update(t.sr_no, { sr_no: 1, name: 'fixed, renamed' });
  assert.equal(u.status, 200);
  assert.equal(u.body.sr_no, t.sr_no);
  // And the database refuses a change made around the API.
  await assert.rejects(pool.query('UPDATE tasks SET sr_no = 12345 WHERE sr_no = $1', [t.sr_no]));
});

/* ---------- update / delete ---------- */

test('updating a task changes its fields and keeps its Sr No.', async () => {
  const t = await create({ name: 'before', owner: 'A' });
  const u = await update(t.sr_no, { name: 'after', owner: 'B', status: 'On Hold', project: 'Site B' });
  assert.equal(u.status, 200);
  assert.deepEqual([u.body.sr_no, u.body.name, u.body.owner, u.body.status, u.body.project],
    [t.sr_no, 'after', 'B', 'On Hold', 'Site B']);
  // Clearing an optional field.
  const cleared = await update(t.sr_no, { owner: '', project: null });
  assert.equal(cleared.body.owner, null);
  assert.equal(cleared.body.project, null);
});

test('deleting a task removes it and its comments', async () => {
  const t = await create({ name: 'to delete', comment: 'first' });
  await api(`tasks/${t.sr_no}/comments`, { method: 'POST', body: { body: 'second' } });
  const r = await api(`tasks/${t.sr_no}`, { method: 'DELETE' });
  assert.deepEqual(r.body, { ok: true, deleted: t.sr_no });
  const left = await pool.query('SELECT count(*)::int AS n FROM comments WHERE task_sr_no = $1', [t.sr_no]);
  assert.equal(left.rows[0].n, 0);
});

/* ---------- delay, through the API ---------- */

test('the list reports each delay case and its days, for today in IST', async () => {
  const cases = {
    lateStart: await create({ name: 'd late start', status: 'In Progress', planned_start: '2026-10-01', actual_start: '2026-10-04' }),
    lateEnd: await create({ name: 'd late end', status: 'Completed', planned_start: '2026-09-01', planned_end: '2026-09-10', actual_start: '2026-09-01', actual_end: '2026-09-12' }),
    notStarted: await create({ name: 'd not started', planned_start: '2026-10-07' }),
    notFinished: await create({ name: 'd not finished', status: 'In Progress', planned_start: '2026-10-01', actual_start: '2026-10-01', planned_end: '2026-10-09' }),
    onTime: await create({ name: 'd on time', planned_start: TODAY, planned_end: '2026-10-30' }),
  };
  const list = (await api('tasks')).body;
  assert.equal(list.today, TODAY);
  const by = (t) => list.tasks.find((x) => x.sr_no === t.sr_no).delay;
  assert.deepEqual([by(cases.lateStart).startDays, by(cases.lateStart).delayed], [3, true]);
  assert.deepEqual([by(cases.lateEnd).endDays, by(cases.lateEnd).startDays], [2, 0]);
  assert.deepEqual([by(cases.notStarted).startDays, by(cases.notStarted).startOpen], [3, true]);
  assert.deepEqual([by(cases.notFinished).endDays, by(cases.notFinished).endOpen], [1, true]);
  assert.equal(by(cases.onTime).delayed, false);
  assert.equal(by(cases.lateStart).reasonMissing, true);
});

test('a delayed task saves without a reason, shows "reason missing", and keeps a reason once given', async () => {
  const t = await create({ name: 'reason flow', planned_start: '2026-10-01' });
  assert.equal(t.delay.delayed, true);
  assert.equal(t.delay.reasonMissing, true, 'saving was not blocked, but the marker shows');

  const withReason = await update(t.sr_no, { delay_reason: 'Rain stopped work' });
  assert.equal(withReason.body.delay.reasonMissing, false);
  assert.equal(withReason.body.delay_reason, 'Rain stopped work');

  // Dates corrected so it is no longer late: the reason stays, the marker goes.
  const corrected = await update(t.sr_no, { planned_start: '2026-10-15' });
  assert.equal(corrected.body.delay.delayed, false);
  assert.equal(corrected.body.delay_reason, 'Rain stopped work');
});

test('the delayed filter, and the reason-missing filter', async () => {
  const late = await create({ name: 'filter late', planned_end: '2026-10-01' });
  const lateWithReason = await create({ name: 'filter late reason', planned_end: '2026-10-01', delay_reason: 'x' });
  const fine = await create({ name: 'filter fine', planned_end: '2026-12-01' });
  const delayed = (await api('tasks?delayed=1')).body.tasks.map((t) => t.sr_no);
  assert.ok(delayed.includes(late.sr_no) && delayed.includes(lateWithReason.sr_no));
  assert.ok(!delayed.includes(fine.sr_no));
  const missing = (await api('tasks?delayed=reason-missing')).body.tasks.map((t) => t.sr_no);
  assert.ok(missing.includes(late.sr_no));
  assert.ok(!missing.includes(lateWithReason.sr_no));
});

test('"today" moves with the clock in IST', async () => {
  const t = await create({ name: 'clock', planned_start: '2026-10-11' });
  const before = await startApp(pool, { now: () => new Date('2026-10-11T18:29:00Z') }); // 23:59 IST on the 11th
  const after = await startApp(pool, { now: () => new Date('2026-10-11T18:30:00Z') });  // 00:00 IST on the 12th
  try {
    assert.equal((await before.api(`tasks/${t.sr_no}`)).body.delay.delayed, false);
    assert.equal((await after.api(`tasks/${t.sr_no}`)).body.delay.startDays, 1);
  } finally {
    await before.close();
    await after.close();
  }
});

/* ---------- dependencies ---------- */

test('a task can depend on several others, and both directions are shown', async () => {
  const a = await create({ name: 'dep A', status: 'Completed' });
  const b = await create({ name: 'dep B' });
  const c = await create({ name: 'dep C', depends_on: [a.sr_no, b.sr_no, b.sr_no] });
  assert.deepEqual(c.depends_on.map((d) => [d.sr_no, d.name, d.completed]),
    [[a.sr_no, 'dep A', true], [b.sr_no, 'dep B', false]]);
  assert.equal(c.waiting, true, 'B is unfinished, so C is Waiting');
  const bNow = (await api(`tasks/${b.sr_no}`)).body;
  assert.deepEqual(bNow.waited_on_by.map((d) => d.sr_no), [c.sr_no]);

  await update(b.sr_no, { status: 'Completed' });
  assert.equal((await api(`tasks/${c.sr_no}`)).body.waiting, false, 'all done, no longer waiting');
});

test('a task cannot depend on itself', async () => {
  const t = await create({ name: 'self' });
  const r = await update(t.sr_no, { depends_on: [t.sr_no] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'A task cannot depend on itself');
});

test('a dependency must be an existing task', async () => {
  const r = await api('tasks', { method: 'POST', body: { name: 'x', depends_on: [987654] } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /No task with Sr No\. 987654/);
  const bad = await api('tasks', { method: 'POST', body: { name: 'x', depends_on: ['abc'] } });
  assert.equal(bad.status, 400);
  const notList = await api('tasks', { method: 'POST', body: { name: 'x', depends_on: 5 } });
  assert.equal(notList.status, 400);
});

test('a direct loop is rejected with a clear message', async () => {
  const a = await create({ name: 'loop A' });
  const b = await create({ name: 'loop B', depends_on: [a.sr_no] });
  const r = await update(a.sr_no, { depends_on: [b.sr_no] });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'DEPENDENCY_LOOP');
  assert.equal(r.body.error,
    `That would make a loop: #${a.sr_no} loop A waits for #${b.sr_no} loop B waits for #${a.sr_no} loop A. `
    + 'A task cannot end up waiting for itself.');
  assert.deepEqual((await api(`tasks/${a.sr_no}`)).body.depends_on, [], 'nothing was saved');
});

test('a loop through other tasks is rejected too', async () => {
  const a = await create({ name: 'chain A' });
  const b = await create({ name: 'chain B', depends_on: [a.sr_no] });
  const c = await create({ name: 'chain C', depends_on: [b.sr_no] });
  const r = await update(a.sr_no, { depends_on: [c.sr_no] });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.loop, [a.sr_no, c.sr_no, b.sr_no, a.sr_no]);
});

test('setting In Progress or Completed with an unfinished dependency warns, and saves once confirmed', async () => {
  const pre = await create({ name: 'prereq', status: 'In Progress' });
  const t = await create({ name: 'needs prereq', depends_on: [pre.sr_no] });

  for (const status of ['In Progress', 'Completed']) {
    const warn = await update(t.sr_no, { status });
    assert.equal(warn.status, 409, status);
    assert.equal(warn.body.code, 'UNFINISHED_DEPENDENCIES');
    assert.deepEqual(warn.body.unfinished.map((u) => u.sr_no), [pre.sr_no]);
    assert.match(warn.body.error, new RegExp(`#${pre.sr_no} prereq \\(In Progress\\)`));
    assert.equal((await api(`tasks/${t.sr_no}`)).body.status, 'Not Started', 'not saved until confirmed');
  }
  const ok = await update(t.sr_no, { status: 'In Progress', confirm: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'In Progress');
  // Editing something else later does not ask again: the status did not change.
  assert.equal((await update(t.sr_no, { next_action: 'chase' })).status, 200);
  // Other statuses never ask.
  assert.equal((await update(t.sr_no, { status: 'On Hold' })).status, 200);
  // Creating straight into In Progress asks too.
  const c = await api('tasks', { method: 'POST', body: { name: 'new active', status: 'Completed', depends_on: [pre.sr_no] } });
  assert.equal(c.status, 409);
});

test('deleting a task others wait for asks first, then removes the links', async () => {
  const base = await create({ name: 'base' });
  const w1 = await create({ name: 'waiter 1', depends_on: [base.sr_no] });
  const w2 = await create({ name: 'waiter 2', depends_on: [base.sr_no] });

  const ask = await api(`tasks/${base.sr_no}`, { method: 'DELETE' });
  assert.equal(ask.status, 409);
  assert.equal(ask.body.code, 'HAS_DEPENDENTS');
  assert.deepEqual(ask.body.dependents.map((d) => d.sr_no), [w1.sr_no, w2.sr_no]);
  assert.equal((await api(`tasks/${base.sr_no}`)).status, 200, 'still there');

  const done = await api(`tasks/${base.sr_no}?confirm=1`, { method: 'DELETE' });
  assert.equal(done.status, 200);
  assert.deepEqual((await api(`tasks/${w1.sr_no}`)).body.depends_on, []);
  assert.equal((await api(`tasks/${w2.sr_no}`)).body.waiting, false);
});

/* ---------- comments ---------- */

test('the comment time is set by the server; a client-sent time is ignored', async () => {
  const t = await create({ name: 'comment time' });
  const before = Date.now();
  const r = await api(`tasks/${t.sr_no}/comments`, {
    method: 'POST', body: { body: 'Checked site', created_at: '2001-01-01T00:00:00Z', id: 1 },
  });
  const after = Date.now();
  assert.equal(r.status, 201);
  const at = Date.parse(r.body.created_at);
  assert.ok(at >= before - 2000 && at <= after + 2000, `${r.body.created_at} is the server's now`);
  assert.match(r.body.created_at_ist, /^\d{2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} (AM|PM)$/);
});

test('empty comments are refused', async () => {
  const t = await create({ name: 'empty comment' });
  for (const body of ['', '   ', undefined]) {
    const r = await api(`tasks/${t.sr_no}/comments`, { method: 'POST', body: { body } });
    assert.equal(r.status, 400);
  }
});

test('comments: latest first on the task, oldest first in the history, latest in the list', async () => {
  const t = await create({ name: 'many comments', comment: 'one' });
  await api(`tasks/${t.sr_no}/comments`, { method: 'POST', body: { body: 'two' } });
  await api(`tasks/${t.sr_no}/comments`, { method: 'POST', body: { body: 'three' } });

  const detail = (await api(`tasks/${t.sr_no}`)).body;
  assert.deepEqual(detail.comments.map((c) => c.body), ['three', 'two', 'one']);
  const latestFirst = (await api(`tasks/${t.sr_no}/comments`)).body;
  assert.deepEqual(latestFirst.map((c) => c.body), ['three', 'two', 'one']);
  const history = (await api(`tasks/${t.sr_no}/comments?order=asc`)).body;
  assert.deepEqual(history.map((c) => c.body), ['one', 'two', 'three']);
  for (let i = 1; i < history.length; i++) {
    assert.ok(history[i].created_at >= history[i - 1].created_at, 'times ascend');
  }
  const row = (await api('tasks')).body.tasks.find((x) => x.sr_no === t.sr_no);
  assert.equal(row.latest_comment.body, 'three');
  assert.equal(row.latest_comment.created_at, history[2].created_at);
  assert.equal(row.comment_count, 3);
});

test('comments cannot be edited or deleted', async () => {
  const t = await create({ name: 'immutable', comment: 'as written' });
  const [c] = (await api(`tasks/${t.sr_no}/comments`)).body;
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const r = await api(`tasks/${t.sr_no}/comments/${c.id}`, { method, body: { body: 'changed' } });
    assert.equal(r.status, 405, method);
  }
  await assert.rejects(pool.query("UPDATE comments SET body = 'changed' WHERE id = $1", [c.id]), /cannot be edited/);
  await assert.rejects(pool.query('DELETE FROM comments WHERE id = $1', [c.id]), /cannot be deleted/);
  assert.equal((await api(`tasks/${t.sr_no}/comments`)).body[0].body, 'as written');
});

/* ---------- search, filters, sorting ---------- */

test('search, filters and sorting', async () => {
  const p = 'zz-';
  const t1 = await create({ name: `${p}alpha`, owner: 'Asha', next_action_owner: 'Bala', status: 'In Progress',
    planned_start: '2026-11-05', planned_end: '2026-11-20' });
  const t2 = await create({ name: `${p}beta`, owner: 'Bala', next_action_owner: 'Asha', planned_start: '2026-11-01' });
  const t3 = await create({ name: `${p}gamma`, owner: 'Asha', planned_start: '2026-11-03', comment: 'needle in comment' });

  const ids = async (qs) => (await api(`tasks?${qs}`)).body.tasks.map((t) => t.sr_no);
  assert.deepEqual(await ids(`q=${p}`), [t1.sr_no, t2.sr_no, t3.sr_no]);
  assert.deepEqual(await ids('q=needle'), [t3.sr_no], 'search covers the latest comment');
  assert.deepEqual(await ids(`q=%23${t2.sr_no}`), [t2.sr_no], 'search by #Sr No.');
  assert.deepEqual(await ids(`q=${p}&owner=Asha`), [t1.sr_no, t3.sr_no]);
  assert.deepEqual(await ids(`q=${p}&next_action_owner=Asha`), [t2.sr_no]);
  assert.deepEqual(await ids(`q=${p}&status=In%20Progress`), [t1.sr_no]);
  assert.deepEqual(await ids(`q=${p}&sort=planned_start`), [t2.sr_no, t3.sr_no, t1.sr_no]);
  assert.deepEqual(await ids(`q=${p}&sort=planned_start&dir=desc`), [t1.sr_no, t3.sr_no, t2.sr_no]);
  assert.deepEqual(await ids(`q=${p}&sort=sr_no&dir=desc`), [t3.sr_no, t2.sr_no, t1.sr_no]);
  // Tasks without the sorted date go last either way.
  assert.deepEqual(await ids(`q=${p}&sort=planned_end`), [t1.sr_no, t2.sr_no, t3.sr_no]);
  assert.deepEqual(await ids(`q=${p}&sort=planned_end&dir=desc`), [t1.sr_no, t2.sr_no, t3.sr_no]);
  for (const key of ['actual_start', 'actual_end']) assert.equal((await ids(`q=${p}&sort=${key}`)).length, 3);
});

/* ---------- meta and projects ---------- */

test('meta lists statuses, today, people and projects; projects are found by name', async () => {
  const a = await create({ name: 'proj 1', project: 'Warehouse', owner: 'Meera', next_action_owner: 'Kiran' });
  const b = await create({ name: 'proj 2', project: 'warehouse' });
  assert.equal(b.project, 'Warehouse', 'same project, matched without regard to case');
  const meta = (await api('meta')).body;
  assert.equal(meta.today, TODAY);
  assert.ok(meta.people.includes('Meera') && meta.people.includes('Kiran'));
  const wh = meta.projects.find((p) => p.name === 'Warehouse');
  assert.ok(wh.task_count >= 2);
  const projects = (await api('projects')).body;
  assert.ok(projects.some((p) => p.name === 'Warehouse' && p.task_count >= 2));
  assert.ok(a.sr_no);
});
