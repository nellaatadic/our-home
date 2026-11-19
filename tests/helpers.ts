import { app } from '../server/app.js';
import { getPool } from '../server/db.js';
import { migrate } from '../server/migrate.js';

export async function resetDb() {
  const pool = await getPool();
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
}

export class Client {
  cookie = '';
  ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  constructor(public name = 'client') {}

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const init: RequestInit = { method, headers: { 'x-ourhome': '1', host: 'localhost', 'x-forwarded-for': this.ip, ...headers } };
    if (this.cookie) (init.headers as any).cookie = this.cookie;
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as any)['content-type'] = 'application/json';
    }
    const res = await app.fetch(new Request(`http://localhost/api${path}`, init));
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = set.match(/oh_session=([^;]*)/);
      if (m) this.cookie = m[1] ? `oh_session=${m[1]}` : '';
    }
    const type = res.headers.get('content-type') ?? '';
    const data: any = type.includes('json') ? await res.json() : await res.arrayBuffer();
    return { status: res.status, data, headers: res.headers };
  }
  get(p: string) { return this.req('GET', p); }
  post(p: string, b?: unknown) { return this.req('POST', p, b ?? {}); }
  patch(p: string, b: unknown) { return this.req('PATCH', p, b); }
  del(p: string) { return this.req('DELETE', p); }

  async ok(method: string, path: string, body?: unknown) {
    const r = await this.req(method, path, body);
    if (r.status >= 400) throw new Error(`${this.name} ${method} ${path} → ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  }
}

let n = 0;
/** Create a household with a primary member and (optionally) an invited partner. */
export async function household(opts: { partner?: boolean; timezone?: string } = {}) {
  n++;
  const me = new Client('me');
  await me.ok('POST', '/auth/register', {
    email: `nella${n}@example.test`, password: 'correct horse battery', display_name: 'Nella', household_name: 'Our home', timezone: opts.timezone ?? 'Europe/Budapest',
  });
  const you = new Client('you');
  if (opts.partner !== false) {
    const inv = await me.ok('POST', '/household/invitations', {});
    await you.ok('POST', '/auth/register', { email: `zsolt${n}@example.test`, password: 'another good passphrase', display_name: 'Zsolt', invite_token: inv.token });
  }
  const meInfo = await me.ok('GET', '/auth/me');
  const youInfo = opts.partner !== false ? await you.ok('GET', '/auth/me') : null;
  return { me, you, meId: meInfo.user.id as string, youId: youInfo?.user.id as string };
}
