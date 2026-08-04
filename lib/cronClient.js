// Shared HTTP helper for scheduled scripts (weekly email, calendar sync, SMS reminders)
// that call the deployed app's own admin API rather than reading the data file directly —
// see the individual scripts for why. Since the admin API now requires a login, this logs
// in once per run using ADMIN_USERNAME/ADMIN_PASSWORD (an admin account created from the
// Settings tab) and reuses that session for every request the script makes.

const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';

let sessionCookie = null;
let loginPromise = null; // memoized so concurrent calls (e.g. inside Promise.all) share one login

function login() {
  if (sessionCookie) return Promise.resolve(sessionCookie);
  if (loginPromise) return loginPromise;
  loginPromise = (async () => {
    const { ADMIN_USERNAME, ADMIN_PASSWORD } = process.env;
    if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
      throw new Error(
        'ADMIN_USERNAME and ADMIN_PASSWORD environment variables are required — set them to the ' +
        'username/password of an admin account (create one in the Settings tab if needed) so this ' +
        'script can log in to the admin API.'
      );
    }
    const res = await fetch(`${APP_BASE_URL}/api/admin-auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Admin login failed: ${body.error || res.status}`);
    }
    // cookie-session sets TWO cookies (cw_session and cw_session.sig, for tamper detection) —
    // both are required on the way back or the server rejects the session. Node's fetch can
    // return them as separate Set-Cookie headers via getSetCookie() (Node 18.14.1+); on older
    // Node, headers.get() joins them with ", " and we split back apart carefully (a naive split
    // would also break on the ", " inside each cookie's Expires date).
    const rawCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') || '').split(/,\s*(?=[\w.]+=)/);
    if (rawCookies.length === 0 || !rawCookies[0]) {
      throw new Error('Admin login succeeded but no session cookie was returned');
    }
    sessionCookie = rawCookies.map((c) => c.split(';')[0]).join('; '); // "cw_session=...; cw_session.sig=..."
    return sessionCookie;
  })();
  return loginPromise;
}

async function authedFetch(path, opts = {}) {
  const cookie = sessionCookie || await login();
  return fetch(`${APP_BASE_URL}${path}`, {
    ...opts,
    headers: { ...(opts.headers || {}), Cookie: cookie },
  });
}

async function fetchJson(path) {
  const res = await authedFetch(path);
  if (!res.ok) throw new Error(`Request to ${path} failed: ${res.status}`);
  return res.json();
}

module.exports = { fetchJson, authedFetch, APP_BASE_URL };
