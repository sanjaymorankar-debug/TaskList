/**
 * Shared test setup. Tests run against a real PostgreSQL database, named by
 * TASKLIST_TEST_DATABASE_URL (default postgres://localhost:5432/tasklist_test).
 *
 * Every test file starts by wiping that database, so the name must end in
 * `_test`: pointing the tests at tasklist_dev by mistake is refused rather
 * than allowed to empty it.
 */
const { createPool, migrate } = require('../src/db');
const { createApp } = require('../src/app');
const { createAuth } = require('../src/auth');

const TEST_URL = process.env.TASKLIST_TEST_DATABASE_URL || 'postgres://localhost:5432/tasklist_test';

// 10 Oct 2026, 11:30 AM IST. Every delay test is written against this "today".
const FIXED_NOW = new Date('2026-10-10T06:00:00Z');
const TODAY = '2026-10-10';

function databaseName(url) {
  const m = /^[a-z]+:\/\/(?:[^@/]*@)?[^/?]*\/([^?]*)/i.exec(url);
  return m ? decodeURIComponent(m[1]) : '';
}

const quiet = { log() {}, error() {}, warn() {} };

/** A fresh, empty, migrated test database. */
async function freshDatabase() {
  const name = databaseName(TEST_URL);
  if (!/_test$/.test(name)) {
    throw new Error(`Refusing to run tests against "${name}": TASKLIST_TEST_DATABASE_URL must name a database ending in _test.`);
  }
  const pool = createPool(TEST_URL);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool, { log: quiet });
  return pool;
}

/**
 * Starts the app on a free port. Returns { url, api, close }, where
 * api(path, { method, body, auth }) calls /tasklist/api/<path> and resolves to
 * { status, body, headers }.
 */
async function startApp(pool, { env = { TASKLIST_ALLOW_OPEN: '1' }, now = () => FIXED_NOW, hubOrigin = '' } = {}) {
  const app = createApp({ pool, auth: createAuth(env), now, hubOrigin, log: quiet });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;

  async function request(path, { method = 'GET', body, auth, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (auth) h.Authorization = `Basic ${Buffer.from(`${auth[0]}:${auth[1]}`).toString('base64')}`;
    const res = await fetch(url + path, {
      method, headers: h, redirect: 'manual',
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    const textBody = await res.text();
    let parsed = textBody;
    try { parsed = JSON.parse(textBody); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  return {
    url,
    request,
    api: (path, opts) => request(`/tasklist/api/${path}`, opts),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { TEST_URL, FIXED_NOW, TODAY, freshDatabase, startApp, quiet };
