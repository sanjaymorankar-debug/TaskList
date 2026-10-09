const fs = require('node:fs');
const path = require('node:path');
const pg = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const DEFAULT_URL = 'postgres://localhost:5432/tasklist_dev';

// DATE columns come back as the plain 'YYYY-MM-DD' they were stored as. The
// default turns them into a JS Date at local midnight, which shifts the day
// whenever the server's time zone is not UTC.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
// BIGINT ids and counts fit comfortably in a JS number here.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));

function databaseUrl(env = process.env) {
  return env.TASKLIST_DATABASE_URL || DEFAULT_URL;
}

function createPool(url = databaseUrl()) {
  return new pg.Pool({ connectionString: url, max: 5 });
}

/** The database name in a connection URL, for logs. Never the password. */
function describeUrl(url) {
  // Not new URL(): postgres URLs may leave the host empty to use a local socket.
  const m = /^[a-z]+:\/\/(?:[^@/]*@)?([^/?]*)\/([^?]*)(?:\?(.*))?$/i.exec(String(url));
  if (!m) return '(unparsable TASKLIST_DATABASE_URL)';
  const socket = new URLSearchParams(m[3] || '').get('host');
  return `${m[1] || socket || 'local socket'}/${decodeURIComponent(m[2])}`;
}

/**
 * Applies every migrations/NNN_*.sql not yet recorded, in name order.
 *
 * Each file is also written to be safe to run twice, so a half-recorded run or
 * a file applied by hand in psql does no harm. The advisory lock stops two app
 * processes starting together from racing each other.
 */
async function migrate(pool, { log = console } = {}) {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['tasklist_migrate']);
    await client.query(`CREATE TABLE IF NOT EXISTS tasklist_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM tasklist_migrations')).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO tasklist_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
      log.log(`Applied migration ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['tasklist_migrate']).catch(() => {});
    client.release();
  }
}

/** Runs `fn(client)` inside a transaction and returns its result. */
async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { DEFAULT_URL, MIGRATIONS_DIR, databaseUrl, createPool, describeUrl, migrate, transaction };
