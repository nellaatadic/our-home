/**
 * LOCAL DEVELOPMENT ONLY: creates a household with two test accounts so both
 * perspectives (ME / YOU) can be tried in two browsers. Refuses to run against
 * Netlify or when users already exist. Never run this in production.
 *
 *   npm run seed:dev
 *
 * Accounts (test values, local database only):
 *   me@ourhome.test  / dev-password-me
 *   you@ourhome.test / dev-password-you
 */
import { app } from '../server/app.js';
import { migrate } from '../server/migrate.js';
import { closePool, q1 } from '../server/db.js';

if (process.env.NETLIFY || process.env.NETLIFY_DB_URL || !process.env.DATABASE_URL?.includes('localhost')) {
  console.error('seed-dev only runs against a local DATABASE_URL');
  process.exit(1);
}
await migrate();
const n = await q1<{ n: number }>('SELECT count(*)::int AS n FROM users');
if (n!.n > 0) {
  console.log('Users already exist; nothing to do.');
  await closePool();
  process.exit(0);
}
let cookie = '';
async function call(method: string, path: string, body?: unknown, c = cookie) {
  const res = await app.fetch(new Request(`http://localhost/api${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-ourhome': '1', host: 'localhost', ...(c ? { cookie: c } : {}) }, body: body ? JSON.stringify(body) : undefined,
  }));
  const set = res.headers.get('set-cookie')?.match(/oh_session=[^;]+/)?.[0];
  if (set) cookie = set;
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}
const tz = process.env.SEED_TIMEZONE ?? 'Europe/Budapest';
await call('POST', '/auth/register', { email: 'me@ourhome.test', password: 'dev-password-me', display_name: 'Nella', household_name: 'Our home', timezone: tz });
const inv = await call('POST', '/household/invitations', {});
cookie = '';
await call('POST', '/auth/register', { email: 'you@ourhome.test', password: 'dev-password-you', display_name: 'Zsolt', invite_token: inv.token });
console.log('Created me@ourhome.test (Nella) and you@ourhome.test (Zsolt).');
await closePool();
