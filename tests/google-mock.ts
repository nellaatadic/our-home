import { googleHttp } from '../server/lib/google.js';

/**
 * In-memory fake of the Google OAuth + Calendar v3 endpoints used by OUR HOME.
 * Records every request so tests can prove which calls were (not) made.
 */
export interface FakeEvent { id: string; summary?: string; description?: string; location?: string; start: any; end: any; visibility?: string; attendees?: any[]; updated?: string; status?: string; recurringEventId?: string }
export interface FakeAccount { sub: string; email: string; calendars: { id: string; summary: string; accessRole: string; primary?: boolean; events: FakeEvent[] }[] }

export class FakeGoogle {
  accounts = new Map<string, FakeAccount>(); // keyed by auth code
  tokens = new Map<string, FakeAccount>();
  requests: { method: string; url: string; body?: string }[] = [];
  private original = googleHttp.fetch;
  grantedScopes = new Map<string, string>();

  install() {
    googleHttp.fetch = (async (url: string, init?: RequestInit) => this.handle(url, init)) as any;
    return this;
  }
  uninstall() {
    googleHttp.fetch = this.original;
  }
  addAccount(code: string, acct: FakeAccount) {
    this.accounts.set(code, acct);
  }

  private json(status: number, body: unknown) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  async handle(url: string, init: RequestInit = {}) {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? init.body : undefined;
    this.requests.push({ method, url, body });
    const u = new URL(url);
    if (u.href.startsWith('https://oauth2.googleapis.com/token')) {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'authorization_code') {
        const acct = this.accounts.get(p.get('code')!);
        if (!acct || !p.get('code_verifier')) return this.json(400, { error: 'invalid_grant' });
        const token = `at-${acct.sub}-${Math.random()}`;
        this.tokens.set(token, acct);
        this.tokens.set(`rt-${acct.sub}`, acct);
        return this.json(200, { access_token: token, refresh_token: `rt-${acct.sub}`, expires_in: 3600, scope: this.grantedScopes.get(p.get('code')!) ?? 'openid email https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly' });
      }
      if (p.get('grant_type') === 'refresh_token') {
        const acct = this.tokens.get(p.get('refresh_token')!);
        if (!acct) return this.json(400, { error: 'invalid_grant' });
        const token = `at-${acct.sub}-${Math.random()}`;
        this.tokens.set(token, acct);
        return this.json(200, { access_token: token, expires_in: 3600, scope: '' });
      }
    }
    if (u.href.startsWith('https://oauth2.googleapis.com/revoke')) return this.json(200, {});
    const auth = (init.headers as any)?.authorization?.replace('Bearer ', '');
    const acct = auth ? this.tokens.get(auth) : undefined;
    if (u.href.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
      return acct ? this.json(200, { sub: acct.sub, email: acct.email }) : this.json(401, {});
    }
    if (!acct) return this.json(401, { error: { message: 'unauthenticated' } });
    const path = u.pathname.replace('/calendar/v3', '');
    if (path === '/users/me/calendarList' && method === 'GET') {
      return this.json(200, { items: acct.calendars.map((c) => ({ id: c.id, summary: c.summary, accessRole: c.accessRole, primary: c.primary })) });
    }
    const m = path.match(/^\/calendars\/([^/]+)\/events$/);
    if (m) {
      const cal = acct.calendars.find((c) => c.id === decodeURIComponent(m[1]));
      if (!cal) return this.json(404, { error: { message: 'not found' } });
      if (method === 'GET') {
        const min = new Date(u.searchParams.get('timeMin')!).getTime();
        const max = new Date(u.searchParams.get('timeMax')!).getTime();
        const items = cal.events.filter((e) => {
          const s = new Date(e.start.dateTime ?? `${e.start.date}T00:00:00Z`).getTime();
          return s >= min - 86400_000 && s <= max;
        });
        return this.json(200, { items });
      }
      if (method === 'POST') {
        const ev = JSON.parse(body!);
        const created = { ...ev, id: `exp-${cal.events.length + 1}-${Math.random().toString(36).slice(2, 7)}`, htmlLink: 'https://calendar.google.com/event?eid=x' };
        cal.events.push(created);
        return this.json(200, created);
      }
    }
    return this.json(404, { error: { message: `unhandled ${method} ${path}` } });
  }
}

export function iso(daysFromNow: number, hour = 10) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}
