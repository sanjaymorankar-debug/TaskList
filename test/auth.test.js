/** The login rule: closed unless configured, open only when explicitly allowed. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDatabase, startApp } = require('./helpers');
const { createAuth } = require('../src/auth');

let pool;
test.before(async () => { pool = await freshDatabase(); });
test.after(async () => { await pool.end(); });

async function withApp(env, fn) {
  const app = await startApp(pool, { env });
  try { await fn(app); } finally { await app.close(); }
}

test('mode is worked out from the settings', () => {
  assert.equal(createAuth({}).mode, 'closed');
  assert.equal(createAuth({ TASKLIST_USER: 'a' }).mode, 'closed');
  assert.equal(createAuth({ TASKLIST_PASSWORD: 'b' }).mode, 'closed');
  assert.equal(createAuth({ TASKLIST_ALLOW_OPEN: '1' }).mode, 'open');
  assert.equal(createAuth({ TASKLIST_ALLOW_OPEN: 'true' }).mode, 'closed', 'only exactly 1 opens it');
  assert.equal(createAuth({ TASKLIST_USER: 'a', TASKLIST_PASSWORD: 'b' }).mode, 'login');
  assert.equal(createAuth({ TASKLIST_USER: 'a', TASKLIST_PASSWORD: 'b', TASKLIST_ALLOW_OPEN: '1' }).mode, 'login',
    'a configured login is never bypassed by ALLOW_OPEN');
});

test('no login configured and not allowed open: everything is refused', async () => {
  await withApp({ TASKLIST_USER: 'only-user' }, async ({ request, api }) => {
    assert.equal((await api('tasks')).status, 503);
    assert.equal((await request('/tasklist/')).status, 503);
    assert.equal((await api('tasks', { method: 'POST', body: { name: 'x' } })).status, 503);
  });
});

test('TASKLIST_ALLOW_OPEN=1 with no login lets everyone in', async () => {
  await withApp({ TASKLIST_ALLOW_OPEN: '1' }, async ({ api }) => {
    assert.equal((await api('tasks')).status, 200);
  });
});

test('with a login configured, a missing or wrong login gets 401 and the right one gets in', async () => {
  const env = { TASKLIST_USER: 'owner', TASKLIST_PASSWORD: 'pa:ss word', TASKLIST_ALLOW_OPEN: '1' };
  await withApp(env, async ({ api, request }) => {
    const none = await api('tasks');
    assert.equal(none.status, 401);
    assert.match(none.headers.get('www-authenticate'), /^Basic realm="TaskList"/);
    assert.equal((await api('tasks', { auth: ['owner', 'wrong'] })).status, 401);
    assert.equal((await api('tasks', { auth: ['wrong', 'pa:ss word'] })).status, 401);
    assert.equal((await request('/tasklist/', { auth: ['owner', 'nope'] })).status, 401);
    // A colon inside the password is fine: only the first colon separates.
    assert.equal((await api('tasks', { auth: ['owner', 'pa:ss word'] })).status, 200);
    assert.equal((await request('/tasklist/', { auth: ['owner', 'pa:ss word'] })).status, 200);
  });
});

test('the health check needs no login and says nothing else', async () => {
  await withApp({}, async ({ request }) => {
    const r = await request('/tasklist/healthz');
    assert.equal(r.status, 200);
    assert.equal(r.body, 'ok');
  });
});
