/** The schema files are safe to run twice, and the app applies each once. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { freshDatabase, quiet } = require('./helpers');
const { migrate, MIGRATIONS_DIR } = require('../src/db');

let pool;
test.before(async () => { pool = await freshDatabase(); });
test.after(async () => { await pool.end(); });

test('files are numbered, and each is recorded once applied', async () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  assert.ok(files.length > 0);
  for (const f of files) assert.match(f, /^\d{3}_[a-z0-9_]+\.sql$/);
  const rows = (await pool.query('SELECT name FROM tasklist_migrations ORDER BY name')).rows.map((r) => r.name);
  assert.deepEqual(rows, files.sort());
});

test('starting the app again changes nothing', async () => {
  await pool.query("INSERT INTO tasks (name) VALUES ('survives restart')");
  await migrate(pool, { log: quiet });
  await migrate(pool, { log: quiet });
  const n = await pool.query("SELECT count(*)::int AS n FROM tasks WHERE name = 'survives restart'");
  assert.equal(n.rows[0].n, 1);
});

test('every file can be run again by hand without error or data loss', async () => {
  for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
  }
  const n = await pool.query("SELECT count(*)::int AS n FROM tasks WHERE name = 'survives restart'");
  assert.equal(n.rows[0].n, 1);
});
