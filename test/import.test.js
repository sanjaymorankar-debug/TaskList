/**
 * The one-off import from the old Task Tracker, using a real SQLite file built
 * with the old tracker's own schema (test/fixtures/legacy_sqlite_schema.sql,
 * copied from bkesari-platform portal/sql/sqlite_schema.sql).
 *
 * The MySQL path reads the same three tables into the same shape and hands
 * them to the same importRows(), so what is tested here is what it runs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { freshDatabase } = require('./helpers');
const { importRows, readSqlite, legacyMoment } = require('../scripts/import-legacy');

let pool, dir, file;

function buildLegacy() {
  const db = new DatabaseSync(file);
  db.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy_sqlite_schema.sql'), 'utf8'));
  const run = (sql, ...p) => db.prepare(sql).run(...p);
  run(`INSERT INTO projects (id, name, description, owner, status, current_step, created_at, updated_at)
       VALUES (1, 'Site A', 'Main site', 'Ramesh', 'In Progress', 'Foundations', '2026-09-01 04:00:00', '2026-09-02 04:00:00')`);
  // Ids out of insertion order on purpose: Sr Nos must follow the old id order.
  run(`INSERT INTO tasks (id, project_id, title, description, owner, status, planned_start, planned_end,
       actual_start, actual_end, current_step, next_step, created_at, updated_at)
       VALUES (7, 1, 'Second task', NULL, 'Suresh', 'Not Started', '2026-10-01', '2026-10-05', NULL, NULL,
       NULL, 'Order bricks', '2026-09-05 10:00:00', '2026-09-05 10:00:00')`);
  run(`INSERT INTO tasks (id, project_id, title, description, owner, status, planned_start, planned_end,
       actual_start, actual_end, current_step, next_step, created_at, updated_at)
       VALUES (3, NULL, 'First task', 'Dig', 'Asha', 'Completed', '2026-09-01', '2026-09-03', '2026-09-01', '2026-09-04',
       'Digging done', 'Inspect', '2026-09-01 05:00:00', '2026-09-04 05:00:00')`);
  run(`INSERT INTO tasks (id, project_id, title, owner, status, created_at, updated_at)
       VALUES (9, 1, 'Odd status', 'Asha', 'Blocked', '2026-09-06 00:00:00', '2026-09-06 00:00:00')`);
  run("INSERT INTO comments (id, entity_type, entity_id, body, created_at) VALUES (1, 'task', 3, 'Started digging', '2026-09-01 05:30:00')");
  run("INSERT INTO comments (id, entity_type, entity_id, body, created_at) VALUES (2, 'task', 3, 'Done digging', '2026-09-04 12:15:00')");
  run("INSERT INTO comments (id, entity_type, entity_id, body, created_at) VALUES (3, 'project', 1, 'Site opened', '2026-09-01 04:10:00')");
  run("INSERT INTO comments (id, entity_type, entity_id, body, created_at) VALUES (4, 'task', 99, 'Orphan', '2026-09-01 04:10:00')");
  db.close();
}

test.before(async () => {
  pool = await freshDatabase();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasklist-import-'));
  file = path.join(dir, 'tasks.db');
  buildLegacy();
});
test.after(async () => {
  await pool.end();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('old times are read as UTC', () => {
  assert.equal(legacyMoment('2026-09-01 05:30:00'), '2026-09-01T05:30:00.000Z');
  assert.equal(legacyMoment(''), null);
});

test('a dry run reports but saves nothing', async () => {
  const legacy = await readSqlite(file);
  const r = await importRows(pool, legacy, { source: 'sqlite', dryRun: true });
  assert.equal(r.tasks.added, 3);
  const n = await pool.query('SELECT count(*)::int AS n FROM tasks');
  assert.equal(n.rows[0].n, 0);
});

test('import copies tasks in their original order, with their comments and times', async () => {
  // A task made in TaskList before the import keeps its number; imported ones follow.
  await pool.query("INSERT INTO tasks (name) VALUES ('made in TaskList first')");

  const legacy = await readSqlite(file);
  const r = await importRows(pool, legacy, { source: 'sqlite' });
  assert.deepEqual([r.projects.added, r.tasks.added, r.comments.added, r.projectComments.added], [1, 3, 2, 1]);
  assert.ok(r.warnings.some((w) => /status "Blocked"/.test(w)));
  assert.ok(r.warnings.some((w) => /comment 4: its task 99/.test(w)));

  const tasks = (await pool.query('SELECT * FROM tasks ORDER BY sr_no')).rows;
  assert.deepEqual(tasks.map((t) => [t.sr_no, t.name]),
    [[1, 'made in TaskList first'], [2, 'First task'], [3, 'Second task'], [4, 'Odd status']]);

  const first = tasks[1];
  assert.equal(first.status, 'Completed');
  assert.equal(first.owner, 'Asha');
  assert.equal(first.planned_end, '2026-09-03');
  assert.equal(first.actual_end, '2026-09-04');
  assert.equal(first.next_action, 'Inspect');
  assert.equal(first.description, 'Dig\n\nCurrent step (from Task Tracker): Digging done');
  assert.equal(first.created_at.toISOString(), '2026-09-01T05:00:00.000Z');
  assert.equal(first.legacy.row.id, 3);

  const second = tasks[2];
  const proj = (await pool.query('SELECT * FROM projects WHERE id = $1', [second.project_id])).rows[0];
  assert.equal(proj.name, 'Site A');
  assert.equal(proj.legacy.current_step, 'Foundations');
  assert.deepEqual(proj.legacy.comments.map((c) => [c.body, c.created_at]), [['Site opened', '2026-09-01T04:10:00.000Z']]);

  assert.equal(tasks[3].status, 'Not Started');
  assert.equal(tasks[3].legacy.row.status, 'Blocked', 'the original value is kept');

  const comments = (await pool.query('SELECT body, created_at FROM comments WHERE task_sr_no = 2 ORDER BY created_at')).rows;
  assert.deepEqual(comments.map((c) => [c.body, c.created_at.toISOString()]),
    [['Started digging', '2026-09-01T05:30:00.000Z'], ['Done digging', '2026-09-04T12:15:00.000Z']]);
});

test('running the import again adds nothing; rows added to the old tracker since are picked up', async () => {
  const again = await importRows(pool, await readSqlite(file), { source: 'sqlite' });
  assert.deepEqual([again.projects.added, again.tasks.added, again.comments.added, again.projectComments.added], [0, 0, 0, 0]);
  assert.deepEqual([again.tasks.skipped, again.comments.skipped], [3, 2]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tasks')).rows[0].n, 4);

  const db = new DatabaseSync(file);
  db.prepare(`INSERT INTO tasks (id, title, status, created_at, updated_at)
              VALUES (10, 'Added later', 'Not Started', '2026-09-10 00:00:00', '2026-09-10 00:00:00')`).run();
  db.prepare("INSERT INTO comments (id, entity_type, entity_id, body, created_at) VALUES (5, 'task', 3, 'Later note', '2026-09-11 00:00:00')").run();
  db.close();

  const third = await importRows(pool, await readSqlite(file), { source: 'sqlite' });
  assert.deepEqual([third.tasks.added, third.comments.added], [1, 1]);
  const last = (await pool.query('SELECT sr_no, name FROM tasks ORDER BY sr_no DESC LIMIT 1')).rows[0];
  assert.deepEqual(last, { sr_no: 5, name: 'Added later' });
});

test('the import script refuses an unrelated SQLite file', async () => {
  const other = path.join(dir, 'other.db');
  const db = new DatabaseSync(other);
  db.exec('CREATE TABLE x (id INTEGER)');
  db.close();
  await assert.rejects(readSqlite(other), /no tasks table/);
});
