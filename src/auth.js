/**
 * TaskList login. Everything about who may get in lives in this one file, so it
 * can be swapped for the central bkesari.com login later without touching the
 * rest of the app: replace `createAuth` with one returning the same shape.
 *
 * Today it is HTTP Basic auth against TASKLIST_USER and TASKLIST_PASSWORD.
 *
 *   - Both set:            a matching login is required.
 *   - Either missing:      everyone is refused (503), so a server that was
 *                          deployed without its settings is closed, not open.
 *   - TASKLIST_ALLOW_OPEN=1 and either missing: open to anyone, for use on
 *                          your own machine only.
 */
const crypto = require('node:crypto');

const REALM = 'TaskList';

// Compares hashes so the time taken does not depend on how much matched.
function same(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function readCredentials(header) {
  const [scheme, encoded] = String(header || '').split(' ');
  if (!/^Basic$/i.test(scheme || '') || !encoded) return null;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return { user: decoded.slice(0, i), password: decoded.slice(i + 1) };
}

/**
 * Returns { mode, middleware }. `mode` is 'login', 'open' or 'closed', for the
 * startup log; the middleware enforces it.
 */
function createAuth(env = process.env) {
  const user = env.TASKLIST_USER;
  const password = env.TASKLIST_PASSWORD;
  const configured = Boolean(user && password);
  const allowOpen = env.TASKLIST_ALLOW_OPEN === '1';
  const mode = configured ? 'login' : allowOpen ? 'open' : 'closed';

  function middleware(req, res, next) {
    if (mode === 'open') return next();
    if (mode === 'closed') {
      res.status(503).type('text').send(
        'TaskList is not configured: set TASKLIST_USER and TASKLIST_PASSWORD on the server '
        + '(or TASKLIST_ALLOW_OPEN=1 for local use only).');
      return;
    }
    const given = readCredentials(req.headers.authorization);
    // Both compared every time, with `&`, so a wrong user name is not quicker
    // to reject than a wrong password.
    if (given && (same(given.user, user) & same(given.password, password))) {
      req.user = { name: given.user };
      return next();
    }
    res.set('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`);
    res.status(401).type('text').send('Login required');
  }

  return { mode, middleware };
}

module.exports = { createAuth };
