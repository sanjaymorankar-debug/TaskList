const { createApp, BASE } = require('./src/app');
const { createAuth } = require('./src/auth');
const { createPool, databaseUrl, describeUrl, migrate } = require('./src/db');

async function main() {
  const url = databaseUrl();
  const pool = createPool(url);
  await migrate(pool);
  console.log(`Database: ${describeUrl(url)}`);

  const auth = createAuth();
  const hubOrigin = (process.env.TASKLIST_HUB_ORIGIN || '').replace(/\/+$/, '');
  const app = createApp({ pool, auth, hubOrigin });

  const port = Number(process.env.TASKLIST_PORT || 3100);
  const host = process.env.TASKLIST_HOST || '127.0.0.1';
  app.listen(port, host, () => {
    console.log(`TaskList running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}${BASE}/`);
    if (auth.mode === 'open') console.warn('WARNING: TASKLIST_ALLOW_OPEN=1 and no login set - anyone who can reach this port can use TaskList.');
    if (auth.mode === 'closed') console.warn('TASKLIST_USER / TASKLIST_PASSWORD are not set: every request is refused until they are.');
    if (hubOrigin) console.log(`Shared menu fetched from ${hubOrigin}/shared/menu.js`);
  });
}

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
