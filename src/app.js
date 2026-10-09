const path = require('node:path');
const express = require('express');
const rules = require('../public/rules.js');
const { findLoop } = require('./dependencies');
const { transaction } = require('./db');

/* ============================================================
   TaskList, served under one prefix so the bkesari.com hub can forward
   /tasklist/ to it unchanged:
     /tasklist/          the task list screen (public/)
     /tasklist/api/...   the JSON API
     /tasklist           redirects to /tasklist/
   ============================================================ */

const BASE = '/tasklist';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_NAME = 250;
const MAX_TEXT = 5000;
const SORT_KEYS = ['sr_no', 'planned_start', 'planned_end', 'actual_start', 'actual_end'];

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function cleanText(value, label, max = MAX_TEXT) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new HttpError(400, `${label} must be text`);
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > max) throw new HttpError(400, `${label} is too long (at most ${max} characters)`);
  return s;
}

function cleanDate(value, label) {
  const s = cleanText(value, label, 10);
  if (!s) return null;
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(s)
    && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s; // rejects 2026-02-30
  if (!ok) throw new HttpError(400, `${label} must be a valid date (YYYY-MM-DD)`);
  return s;
}

function srNoParam(value) {
  const n = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(n) || n < 1) throw new HttpError(404, 'Task not found');
  return n;
}

function cleanDependsOn(value) {
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'Dependencies must be a list of Sr Nos');
  const out = [];
  for (const v of value) {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, `"${v}" is not a valid Sr No.`);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** The editable fields of a task, validated. Throws HttpError(400) with a plain message. */
function readTask(body) {
  const b = body && typeof body === 'object' ? body : {};
  const task = {
    name: cleanText(b.name, 'Task name', MAX_NAME),
    description: cleanText(b.description, 'Description'),
    project: cleanText(b.project, 'Project', MAX_NAME),
    status: cleanText(b.status, 'Status', 40) || 'Not Started',
    owner: cleanText(b.owner, 'Owner', MAX_NAME),
    planned_start: cleanDate(b.planned_start, 'Planned start date'),
    planned_end: cleanDate(b.planned_end, 'Planned end date'),
    actual_start: cleanDate(b.actual_start, 'Actual start date'),
    actual_end: cleanDate(b.actual_end, 'Actual end date'),
    delay_reason: cleanText(b.delay_reason, 'Reason for delay'),
    next_action: cleanText(b.next_action, 'Next action'),
    next_action_owner: cleanText(b.next_action_owner, 'Owner of next action', MAX_NAME),
    depends_on: cleanDependsOn(b.depends_on),
  };
  if (!task.name) throw new HttpError(400, 'Task name is required');
  if (!rules.STATUSES.includes(task.status)) {
    throw new HttpError(400, `Status must be one of: ${rules.STATUSES.join(', ')}`);
  }
  if (task.planned_start && task.planned_end && task.planned_end < task.planned_start) {
    throw new HttpError(400, 'Planned end date cannot be before planned start date');
  }
  if (task.actual_start && task.actual_end && task.actual_end < task.actual_start) {
    throw new HttpError(400, 'Actual end date cannot be before actual start date');
  }
  return task;
}

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

function commentOut(row) {
  return {
    id: row.id,
    task_sr_no: row.task_sr_no,
    body: row.body,
    created_at: toIso(row.created_at),
    created_at_ist: rules.formatIst(row.created_at),
  };
}

const TASK_SELECT = `
  SELECT t.sr_no, t.name, t.description, t.status, t.owner,
         t.planned_start, t.planned_end, t.actual_start, t.actual_end,
         t.delay_reason, t.next_action, t.next_action_owner,
         t.project_id, p.name AS project,
         t.created_at, t.updated_at,
         lc.body AS latest_comment, lc.created_at AS latest_comment_at,
         (SELECT count(*) FROM comments c WHERE c.task_sr_no = t.sr_no) AS comment_count
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
    LEFT JOIN LATERAL (
      SELECT c.body, c.created_at FROM comments c
       WHERE c.task_sr_no = t.sr_no
       ORDER BY c.created_at DESC, c.id DESC LIMIT 1
    ) lc ON true`;

/**
 * Turns task rows plus every dependency link into what the API returns: the
 * stored fields, the delay worked out for today, and both directions of
 * dependency with each one's status.
 */
function shapeTasks(rows, edges, allTasks, today) {
  const byNo = new Map(allTasks.map((t) => [t.sr_no, t]));
  const ref = (n) => {
    const t = byNo.get(n);
    return { sr_no: n, name: t ? t.name : '?', status: t ? t.status : '?', completed: Boolean(t && t.status === 'Completed') };
  };
  const waitsFor = new Map();
  const waitedOnBy = new Map();
  for (const [from, to] of edges) {
    if (!waitsFor.has(from)) waitsFor.set(from, []);
    waitsFor.get(from).push(to);
    if (!waitedOnBy.has(to)) waitedOnBy.set(to, []);
    waitedOnBy.get(to).push(from);
  }
  const bySrNo = (a, b) => a - b;
  return rows.map((r) => {
    const dependsOn = (waitsFor.get(r.sr_no) || []).sort(bySrNo).map(ref);
    return {
      sr_no: r.sr_no,
      name: r.name,
      description: r.description,
      project: r.project,
      status: r.status,
      owner: r.owner,
      planned_start: r.planned_start,
      planned_end: r.planned_end,
      actual_start: r.actual_start,
      actual_end: r.actual_end,
      delay_reason: r.delay_reason,
      next_action: r.next_action,
      next_action_owner: r.next_action_owner,
      depends_on: dependsOn,
      waited_on_by: (waitedOnBy.get(r.sr_no) || []).sort(bySrNo).map(ref),
      waiting: dependsOn.some((d) => !d.completed),
      delay: rules.computeDelay(r, today),
      latest_comment: r.latest_comment
        ? { body: r.latest_comment, created_at: toIso(r.latest_comment_at), created_at_ist: rules.formatIst(r.latest_comment_at) }
        : null,
      comment_count: Number(r.comment_count) || 0,
      created_at: toIso(r.created_at),
      updated_at: toIso(r.updated_at),
    };
  });
}

function matchesQuery(task, q) {
  if (!q) return true;
  const needle = q.toLowerCase().replace(/^#/, '');
  if (/^\d+$/.test(needle) && String(task.sr_no) === needle) return true;
  return [task.name, task.description, task.project, task.owner, task.next_action, task.next_action_owner,
    task.delay_reason, task.latest_comment && task.latest_comment.body]
    .some((v) => v && v.toLowerCase().includes(needle));
}

function sortTasks(tasks, key, dir) {
  const sign = dir === 'desc' ? -1 : 1;
  return tasks.sort((a, b) => {
    if (key !== 'sr_no') {
      // Tasks without the date go last whichever way the list is sorted.
      const va = a[key], vb = b[key];
      if (va !== vb) {
        if (!va) return 1;
        if (!vb) return -1;
        return va < vb ? -sign : sign;
      }
    }
    return (a.sr_no - b.sr_no) * (key === 'sr_no' ? sign : 1);
  });
}

function createApp({ pool, auth, now = () => new Date(), hubOrigin = '', log = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('strict routing', true);

  const today = () => rules.todayIst(now());

  async function loadAll(db) {
    const [tasks, edges] = await Promise.all([
      db.query(`${TASK_SELECT} ORDER BY t.sr_no`),
      db.query('SELECT task_sr_no, depends_on_sr_no FROM task_dependencies'),
    ]);
    const pairs = edges.rows.map((e) => [e.task_sr_no, e.depends_on_sr_no]);
    return shapeTasks(tasks.rows, pairs, tasks.rows, today());
  }

  async function loadOne(db, srNo) {
    const all = await loadAll(db);
    const task = all.find((t) => t.sr_no === srNo);
    if (!task) throw new HttpError(404, 'Task not found');
    return task;
  }

  async function projectId(db, name) {
    if (!name) return null;
    const found = await db.query('SELECT id FROM projects WHERE lower(name) = lower($1) ORDER BY id LIMIT 1', [name]);
    if (found.rows[0]) return found.rows[0].id;
    return (await db.query('INSERT INTO projects (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
  }

  /**
   * Everything saving a task must check about its dependencies, run inside the
   * saving transaction with the links table locked, so two people saving at
   * once cannot close a loop between them.
   */
  async function checkDependencies(db, srNo, task, previousStatus, confirmed) {
    await db.query('LOCK TABLE task_dependencies IN SHARE ROW EXCLUSIVE MODE');
    const wanted = task.depends_on;
    if (srNo !== null && wanted.includes(srNo)) throw new HttpError(400, 'A task cannot depend on itself');
    if (!wanted.length) return;

    const found = (await db.query('SELECT sr_no, name, status FROM tasks WHERE sr_no = ANY($1::bigint[])', [wanted])).rows;
    const missing = wanted.filter((n) => !found.some((t) => t.sr_no === n));
    if (missing.length) {
      throw new HttpError(400, `No task with Sr No. ${missing.join(', ')}`);
    }

    if (srNo !== null) {
      const edges = (await db.query('SELECT task_sr_no, depends_on_sr_no FROM task_dependencies')).rows
        .map((e) => [e.task_sr_no, e.depends_on_sr_no]);
      const loop = findLoop(srNo, wanted, edges);
      if (loop) {
        const names = new Map((await db.query('SELECT sr_no, name FROM tasks WHERE sr_no = ANY($1::bigint[])', [loop])).rows
          .map((t) => [t.sr_no, t.name]));
        const steps = loop.map((n) => `#${n} ${names.get(n) || ''}`.trim());
        throw new HttpError(400,
          `That would make a loop: ${steps.join(' waits for ')}. A task cannot end up waiting for itself.`,
          { code: 'DEPENDENCY_LOOP', loop });
      }
    }

    const statusChanged = previousStatus === null || previousStatus !== task.status;
    if (statusChanged && rules.ACTIVE_STATUSES.includes(task.status) && !confirmed) {
      const unfinished = found.filter((t) => t.status !== 'Completed').sort((a, b) => a.sr_no - b.sr_no);
      if (unfinished.length) {
        const list = unfinished.map((t) => `#${t.sr_no} ${t.name} (${t.status})`).join(', ');
        throw new HttpError(409,
          `This task still waits for unfinished tasks: ${list}. Set it to ${task.status} anyway?`,
          { code: 'UNFINISHED_DEPENDENCIES', unfinished });
      }
    }
  }

  async function saveLinks(db, srNo, dependsOn) {
    await db.query('DELETE FROM task_dependencies WHERE task_sr_no = $1', [srNo]);
    if (dependsOn.length) {
      await db.query(
        `INSERT INTO task_dependencies (task_sr_no, depends_on_sr_no)
         SELECT $1, d FROM unnest($2::bigint[]) AS d`, [srNo, dependsOn]);
    }
  }

  /* ---------- API ---------- */
  const api = express.Router();
  // Inside the router so a malformed body reaches the JSON error handler below.
  api.use(express.json({ limit: '200kb' }));
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  api.get('/meta', async (req, res) => {
    const [projects, people] = await Promise.all([
      pool.query(`SELECT p.id, p.name, (SELECT count(*) FROM tasks t WHERE t.project_id = p.id) AS task_count
                    FROM projects p ORDER BY lower(p.name), p.id`),
      pool.query(`SELECT DISTINCT person FROM (
                    SELECT owner AS person FROM tasks UNION SELECT next_action_owner FROM tasks
                  ) x WHERE person IS NOT NULL ORDER BY person`),
    ]);
    res.json({
      statuses: rules.STATUSES,
      today: today(),
      projects: projects.rows.map((p) => ({ ...p, task_count: Number(p.task_count) })),
      people: people.rows.map((r) => r.person),
    });
  });

  // The whole list, filtered and sorted. Filtering happens after the delay is
  // worked out, because "delayed" depends on today's date, not on a column.
  api.get('/tasks', async (req, res) => {
    const q = String(req.query.q || '').trim();
    const { status, owner, next_action_owner: nextOwner, delayed, waiting, project } = req.query;
    const sort = SORT_KEYS.includes(req.query.sort) ? req.query.sort : 'sr_no';
    const dir = req.query.dir === 'desc' ? 'desc' : 'asc';
    let tasks = await loadAll(pool);
    tasks = tasks.filter((t) => matchesQuery(t, q)
      && (!status || t.status === status)
      && (!owner || t.owner === owner)
      && (!nextOwner || t.next_action_owner === nextOwner)
      && (!project || t.project === project)
      && (!delayed || (delayed === 'reason-missing' ? t.delay.reasonMissing : t.delay.delayed))
      && (!waiting || t.waiting));
    res.json({ today: today(), tasks: sortTasks(tasks, sort, dir) });
  });

  api.get('/tasks/:srNo', async (req, res) => {
    const srNo = srNoParam(req.params.srNo);
    const task = await loadOne(pool, srNo);
    const comments = await pool.query(
      'SELECT * FROM comments WHERE task_sr_no = $1 ORDER BY created_at DESC, id DESC', [srNo]);
    res.json({ ...task, comments: comments.rows.map(commentOut) });
  });

  api.post('/tasks', async (req, res) => {
    const task = readTask(req.body);
    const firstComment = cleanText(req.body && req.body.comment, 'Comment');
    const srNo = await transaction(pool, async (db) => {
      await checkDependencies(db, null, task, null, req.body.confirm === true);
      const inserted = await db.query(
        `INSERT INTO tasks (name, description, project_id, status, owner, planned_start, planned_end,
                            actual_start, actual_end, delay_reason, next_action, next_action_owner)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING sr_no`,
        [task.name, task.description, await projectId(db, task.project), task.status, task.owner,
          task.planned_start, task.planned_end, task.actual_start, task.actual_end,
          task.delay_reason, task.next_action, task.next_action_owner]);
      const n = inserted.rows[0].sr_no;
      await saveLinks(db, n, task.depends_on);
      if (firstComment) await db.query('INSERT INTO comments (task_sr_no, body) VALUES ($1, $2)', [n, firstComment]);
      return n;
    });
    res.status(201).json(await loadOne(pool, srNo));
  });

  api.put('/tasks/:srNo', async (req, res) => {
    const srNo = srNoParam(req.params.srNo);
    const task = readTask(req.body);
    await transaction(pool, async (db) => {
      const current = (await db.query('SELECT status FROM tasks WHERE sr_no = $1 FOR UPDATE', [srNo])).rows[0];
      if (!current) throw new HttpError(404, 'Task not found');
      await checkDependencies(db, srNo, task, current.status, req.body.confirm === true);
      await db.query(
        `UPDATE tasks SET name=$2, description=$3, project_id=$4, status=$5, owner=$6,
                planned_start=$7, planned_end=$8, actual_start=$9, actual_end=$10,
                delay_reason=$11, next_action=$12, next_action_owner=$13, updated_at=now()
          WHERE sr_no = $1`,
        [srNo, task.name, task.description, await projectId(db, task.project), task.status, task.owner,
          task.planned_start, task.planned_end, task.actual_start, task.actual_end,
          task.delay_reason, task.next_action, task.next_action_owner]);
      await saveLinks(db, srNo, task.depends_on);
    });
    res.json(await loadOne(pool, srNo));
  });

  // A task others wait for is only deleted once the caller confirms, and its
  // links go with it (ON DELETE CASCADE).
  api.delete('/tasks/:srNo', async (req, res) => {
    const srNo = srNoParam(req.params.srNo);
    const confirmed = req.query.confirm === '1' || (req.body && req.body.confirm === true);
    await transaction(pool, async (db) => {
      const found = (await db.query('SELECT sr_no FROM tasks WHERE sr_no = $1 FOR UPDATE', [srNo])).rows[0];
      if (!found) throw new HttpError(404, 'Task not found');
      const dependents = (await db.query(
        `SELECT t.sr_no, t.name, t.status FROM task_dependencies d JOIN tasks t ON t.sr_no = d.task_sr_no
          WHERE d.depends_on_sr_no = $1 ORDER BY t.sr_no`, [srNo])).rows;
      if (dependents.length && !confirmed) {
        const list = dependents.map((t) => `#${t.sr_no} ${t.name}`).join(', ');
        throw new HttpError(409,
          `Other tasks wait for this one: ${list}. Deleting it removes those links too.`,
          { code: 'HAS_DEPENDENTS', dependents });
      }
      await db.query('DELETE FROM tasks WHERE sr_no = $1', [srNo]);
    });
    res.json({ ok: true, deleted: srNo });
  });

  // Newest first by default (the task screen); ?order=asc gives the full
  // history oldest first.
  api.get('/tasks/:srNo/comments', async (req, res) => {
    const srNo = srNoParam(req.params.srNo);
    const exists = await pool.query('SELECT 1 FROM tasks WHERE sr_no = $1', [srNo]);
    if (!exists.rowCount) throw new HttpError(404, 'Task not found');
    const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
    const rows = await pool.query(
      `SELECT * FROM comments WHERE task_sr_no = $1 ORDER BY created_at ${order}, id ${order}`, [srNo]);
    res.json(rows.rows.map(commentOut));
  });

  // The time is the database's clock at the moment of saving. Anything the
  // client sends besides `body` is ignored.
  api.post('/tasks/:srNo/comments', async (req, res) => {
    const srNo = srNoParam(req.params.srNo);
    const body = cleanText(req.body && req.body.body, 'Comment');
    if (!body) throw new HttpError(400, 'Comment cannot be empty');
    const row = await transaction(pool, async (db) => {
      const exists = await db.query('SELECT 1 FROM tasks WHERE sr_no = $1', [srNo]);
      if (!exists.rowCount) throw new HttpError(404, 'Task not found');
      const inserted = await db.query('INSERT INTO comments (task_sr_no, body) VALUES ($1, $2) RETURNING *', [srNo, body]);
      await db.query('UPDATE tasks SET updated_at = now() WHERE sr_no = $1', [srNo]);
      return inserted.rows[0];
    });
    res.status(201).json(commentOut(row));
  });

  // Saved comments stay as they are.
  api.all('/tasks/:srNo/comments/:id', (req, res) => {
    res.set('Allow', 'GET, POST').status(405).json({ error: 'Comments cannot be edited or deleted once saved' });
  });

  api.get('/projects', async (req, res) => {
    const rows = await pool.query(
      `SELECT p.id, p.name, p.description, (SELECT count(*) FROM tasks t WHERE t.project_id = p.id) AS task_count
         FROM projects p ORDER BY lower(p.name), p.id`);
    res.json(rows.rows.map((p) => ({ ...p, task_count: Number(p.task_count) })));
  });

  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large' });
    // A database CHECK caught something the validation above should have.
    if (err.code === '23514') return res.status(400).json({ error: 'The values break a rule of the task list' });
    log.error(err);
    res.status(500).json({ error: 'Server error' });
  });

  /* ---------- Routes ---------- */

  // For the bare app: send / to the list. Behind the hub only /tasklist/ arrives.
  app.get('/', (req, res) => res.redirect(302, `${BASE}/`));

  // With strict routing on, this is only the slashless form.
  app.get(BASE, (req, res) => {
    const qs = req.originalUrl.slice(BASE.length);
    res.redirect(301, `${BASE}/${qs}`);
  });

  // Unauthenticated and says nothing but whether the database answers, for a
  // process monitor on the VPS later.
  app.get(`${BASE}/healthz`, async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.type('text').send('ok');
    } catch {
      res.status(503).type('text').send('database unavailable');
    }
  });

  // The shared top menu belongs to the hub. Behind the hub, /shared/menu.js is
  // the hub's own and never reaches this app. Running TaskList on its own, set
  // TASKLIST_HUB_ORIGIN to the hub you are running and it is fetched from there.
  app.get('/shared/:file', async (req, res) => {
    if (!hubOrigin || !/^[\w.-]+\.(js|css)$/.test(req.params.file)) return res.status(404).type('text').send('Not found');
    try {
      const upstream = await fetch(`${hubOrigin}/shared/${req.params.file}`);
      if (!upstream.ok) return res.status(upstream.status).type('text').send('Not found');
      res.type(upstream.headers.get('content-type') || 'application/javascript')
        .set('Cache-Control', 'no-cache')
        .send(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res.status(502).type('text').send('The hub is not reachable');
    }
  });

  app.use(BASE, (req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        // The shared menu injects its own <style> block.
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        'font-src https://fonts.gstatic.com',
        "img-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'self'",
        "base-uri 'none'",
        "form-action 'self'",
      ].join('; '),
    });
    next();
  });
  app.use(BASE, auth.middleware);
  app.use(`${BASE}/api`, api);
  app.use(BASE, express.static(PUBLIC_DIR, { index: 'index.html', redirect: false }));

  app.use((req, res) => res.status(404).type('text').send('Not found'));
  return app;
}

module.exports = { createApp, readTask, HttpError, BASE };
