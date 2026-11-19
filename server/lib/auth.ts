import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { q, q1 } from '../db.js';
import { randomToken, sha256 } from './crypto.js';
import { HttpError } from './http.js';
import type { AppEnv, Auth, Person } from './access.js';

export const SESSION_COOKIE = 'oh_session';
const SESSION_DAYS = 30;

function isSecure(c: Context) {
  const proto = c.req.header('x-forwarded-proto') ?? new URL(c.req.url).protocol.replace(':', '');
  return proto === 'https';
}

export async function createSession(c: Context, userId: string) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await q('INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES ($1, $2, $3, $4)', [
    sha256(token), userId, expires, (c.req.header('user-agent') ?? '').slice(0, 300),
  ]);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, secure: isSecure(c), sameSite: 'Lax', path: '/', expires,
  });
}

export async function destroySession(c: Context) {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await q('DELETE FROM sessions WHERE id = $1', [sha256(token)]);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export async function loadAuthForUser(userId: string, sessionId = ''): Promise<Auth | null> {
  const row = await q1<any>(
    `SELECT u.id, u.email, u.display_name, hm.role, h.id AS household_id, h.name AS household_name,
            h.timezone, h.currency, h.auto_move_to_stock,
            pw.id AS personal_ws, sw.id AS shared_ws
       FROM users u
       JOIN household_members hm ON hm.user_id = u.id
       JOIN households h ON h.id = hm.household_id
       JOIN workspaces pw ON pw.owner_user_id = u.id AND pw.kind = 'personal'
       JOIN workspaces sw ON sw.household_id = h.id AND sw.kind = 'shared'
      WHERE u.id = $1`,
    [userId],
  );
  if (!row) return null;
  const members = await q<Person>(
    `SELECT u.id, u.display_name, u.email, hm.role FROM household_members hm JOIN users u ON u.id = hm.user_id
      WHERE hm.household_id = $1 ORDER BY hm.joined_at`,
    [row.household_id],
  );
  return {
    user: { id: row.id, email: row.email, display_name: row.display_name },
    sessionId,
    household: { id: row.household_id, name: row.household_name, timezone: row.timezone, currency: row.currency, auto_move_to_stock: row.auto_move_to_stock },
    role: row.role,
    personalWorkspaceId: row.personal_ws,
    sharedWorkspaceId: row.shared_ws,
    partner: members.find((m) => m.id !== row.id) ?? null,
    members,
  };
}

export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('auth', null);
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const id = sha256(token);
    const s = await q1<{ user_id: string; last_seen_at: Date }>(
      'SELECT user_id, last_seen_at FROM sessions WHERE id = $1 AND expires_at > now()',
      [id],
    );
    if (s) {
      c.set('auth', await loadAuthForUser(s.user_id, id));
      if (Date.now() - new Date(s.last_seen_at).getTime() > 3600_000) {
        await q('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [id]);
      }
    }
  }
  await next();
};

export function requireAuth(c: Context<AppEnv>): Auth {
  const a = c.get('auth');
  if (!a) throw new HttpError(401, 'unauthenticated', 'Please sign in');
  return a;
}

/**
 * CSRF defence: state-changing requests must carry a custom header (which a
 * cross-site form or image cannot send without a CORS preflight we never
 * approve) and, when the browser sends Origin, it must match our host.
 */
export const csrfMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const m = c.req.method;
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
    const path = new URL(c.req.url).pathname;
    if (!path.startsWith('/api/google/callback')) {
      if (c.req.header('x-ourhome') !== '1') throw new HttpError(403, 'csrf', 'Missing request header');
      const origin = c.req.header('origin');
      if (origin) {
        const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
        let originHost = '';
        try { originHost = new URL(origin).host; } catch { /* invalid */ }
        if (!host || originHost !== host) throw new HttpError(403, 'csrf', 'Cross-origin request rejected');
      }
    }
  }
  await next();
};

/** Simple DB-backed sliding-window rate limit. */
export async function rateLimit(bucket: string, max: number, windowSeconds: number) {
  const rows = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM rate_limit_events WHERE bucket = $1 AND created_at > now() - make_interval(secs => $2)`,
    [bucket, windowSeconds],
  );
  if ((rows[0]?.n ?? 0) >= max) throw new HttpError(429, 'rate_limited', 'Too many attempts. Please wait a few minutes and try again.');
  await q('INSERT INTO rate_limit_events (bucket) VALUES ($1)', [bucket]);
  if (Math.random() < 0.02) await q(`DELETE FROM rate_limit_events WHERE created_at < now() - interval '1 day'`);
}

export function clientIp(c: Context): string {
  return (c.req.header('x-nf-client-connection-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0] ?? 'local').trim();
}
