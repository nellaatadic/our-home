import { Hono } from 'hono';
import { z } from 'zod';
import { q, q1, tx } from '../db.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto.js';
import { badRequest, conflict, HttpError, parse } from '../lib/http.js';
import { clientIp, createSession, destroySession, loadAuthForUser, rateLimit, requireAuth } from '../lib/auth.js';
import { seedWorkspace } from '../lib/defaults.js';
import { isValidTimeZone } from '../lib/time.js';
import type { AppEnv, Auth } from '../lib/access.js';

export const authRoutes = new Hono<AppEnv>();

const email = z.string().trim().toLowerCase().email().max(200);
const password = z.string().min(10, 'Use at least 10 characters').max(200);
const displayName = z.string().trim().min(1).max(60);

export function publicAuth(a: Auth) {
  return {
    user: a.user,
    role: a.role,
    household: a.household,
    partner: a.partner ? { id: a.partner.id, display_name: a.partner.display_name, role: a.partner.role } : null,
    members: a.members.map((m) => ({ id: m.id, display_name: m.display_name, role: m.role })),
  };
}

function signupMode() {
  return (process.env.SIGNUP_MODE ?? 'first-user-only') as 'first-user-only' | 'open' | 'invite-only';
}

async function findInvitation(token: string) {
  return q1<any>(
    `SELECT i.*, h.name AS household_name, u.display_name AS inviter_name,
            (SELECT count(*)::int FROM household_members m WHERE m.household_id = i.household_id) AS member_count
       FROM invitations i JOIN households h ON h.id = i.household_id JOIN users u ON u.id = i.invited_by
      WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`,
    [sha256(token)],
  );
}

authRoutes.get('/status', async (c) => {
  const users = await q1<{ n: number }>('SELECT count(*)::int AS n FROM users');
  const mode = signupMode();
  return c.json({ signup_open: mode === 'open' || (mode === 'first-user-only' && (users?.n ?? 0) === 0) });
});

authRoutes.post('/register', async (c) => {
  await rateLimit(`register:${clientIp(c)}`, 10, 3600);
  const body = parse(
    z.object({
      email, password, display_name: displayName,
      invite_token: z.string().max(200).optional(),
      household_name: z.string().trim().min(1).max(80).optional(),
      timezone: z.string().max(64).optional(),
    }),
    await c.req.json(),
  );
  if (body.timezone && !isValidTimeZone(body.timezone)) throw badRequest('Unknown time zone');
  if (await q1('SELECT 1 FROM users WHERE lower(email) = $1', [body.email])) throw conflict('An account with this email already exists');
  const hash = await hashPassword(body.password);

  const userId = await tx(async (db) => {
    let householdId: string;
    let role: 'primary' | 'partner';
    if (body.invite_token) {
      const inv = await findInvitation(body.invite_token);
      if (!inv) throw new HttpError(400, 'invalid_invite', 'This invitation is invalid or has expired');
      if (inv.member_count >= 2) throw new HttpError(400, 'household_full', 'This household already has two members');
      if (inv.email && inv.email.toLowerCase() !== body.email) throw new HttpError(400, 'invalid_invite', 'This invitation was sent to a different email address');
      householdId = inv.household_id;
      role = 'partner';
    } else {
      const mode = signupMode();
      const n = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM users')).rows[0].n;
      if (mode === 'invite-only' || (mode === 'first-user-only' && n > 0)) {
        throw new HttpError(403, 'signup_closed', 'Sign-up is by invitation only. Ask your partner for an invite link.');
      }
      householdId = (await db.query<{ id: string }>(
        'INSERT INTO households (name, timezone) VALUES ($1, $2) RETURNING id',
        [body.household_name ?? 'Our home', body.timezone ?? 'UTC'],
      )).rows[0].id;
      role = 'primary';
    }
    const uid = (await db.query<{ id: string }>(
      'INSERT INTO users (email, password_hash, display_name) VALUES ($1,$2,$3) RETURNING id',
      [body.email, hash, body.display_name],
    )).rows[0].id;
    await db.query('INSERT INTO household_members (household_id, user_id, role) VALUES ($1,$2,$3)', [householdId, uid, role]);
    await db.query('INSERT INTO user_settings (user_id) VALUES ($1)', [uid]);
    const personal = (await db.query<{ id: string }>(
      `INSERT INTO workspaces (household_id, kind, owner_user_id) VALUES ($1,'personal',$2) RETURNING id`, [householdId, uid],
    )).rows[0].id;
    await seedWorkspace(db, personal, uid, 'personal');
    if (role === 'primary') {
      const shared = (await db.query<{ id: string }>(
        `INSERT INTO workspaces (household_id, kind) VALUES ($1,'shared') RETURNING id`, [householdId],
      )).rows[0].id;
      await seedWorkspace(db, shared, uid, 'shared');
    } else {
      await db.query('UPDATE invitations SET accepted_at = now(), accepted_by = $1 WHERE token_hash = $2', [uid, sha256(body.invite_token!)]);
    }
    return uid;
  });

  await createSession(c, userId);
  const auth = await loadAuthForUser(userId);
  return c.json(publicAuth(auth!), 201);
});

authRoutes.post('/login', async (c) => {
  const body = parse(z.object({ email, password: z.string().min(1).max(200) }), await c.req.json());
  await rateLimit(`login:${clientIp(c)}`, 30, 900);
  await rateLimit(`login-email:${body.email}`, 10, 900);
  const user = await q1<{ id: string; password_hash: string }>('SELECT id, password_hash FROM users WHERE lower(email) = $1', [body.email]);
  // Always run a hash comparison so response time does not reveal whether the email exists.
  const ok = await verifyPassword(body.password, user?.password_hash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86));
  if (!user || !ok) throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
  await createSession(c, user.id);
  return c.json(publicAuth((await loadAuthForUser(user.id))!));
});

authRoutes.post('/logout', async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

authRoutes.get('/me', (c) => {
  const a = c.get('auth');
  if (!a) return c.json({ user: null });
  return c.json(publicAuth(a));
});

authRoutes.patch('/profile', async (c) => {
  const a = requireAuth(c);
  const body = parse(z.object({ display_name: displayName }), await c.req.json());
  await q('UPDATE users SET display_name = $1, updated_at = now() WHERE id = $2', [body.display_name, a.user.id]);
  return c.json(publicAuth((await loadAuthForUser(a.user.id))!));
});

authRoutes.post('/password', async (c) => {
  const a = requireAuth(c);
  await rateLimit(`pw:${a.user.id}`, 10, 900);
  const body = parse(z.object({ current_password: z.string().max(200), new_password: password }), await c.req.json());
  const u = await q1<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [a.user.id]);
  if (!u || !(await verifyPassword(body.current_password, u.password_hash))) throw new HttpError(400, 'invalid_credentials', 'Current password is incorrect');
  await q('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [await hashPassword(body.new_password), a.user.id]);
  await q('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [a.user.id, a.sessionId]);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- invites
authRoutes.get('/invitations/:token', async (c) => {
  const inv = await findInvitation(c.req.param('token'));
  if (!inv || inv.member_count >= 2) return c.json({ valid: false });
  return c.json({ valid: true, household_name: inv.household_name, inviter_name: inv.inviter_name, email: inv.email });
});

export const householdRoutes = new Hono<AppEnv>();

householdRoutes.get('/invitations', async (c) => {
  const a = requireAuth(c);
  const rows = await q(
    `SELECT id, email, created_at, expires_at, accepted_at FROM invitations
      WHERE household_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 10`,
    [a.household.id],
  );
  return c.json({ invitations: rows });
});

householdRoutes.post('/invitations', async (c) => {
  const a = requireAuth(c);
  if (a.role !== 'primary') throw new HttpError(403, 'forbidden', 'Only the primary member can invite');
  if (a.members.length >= 2) throw new HttpError(400, 'household_full', 'Your household already has two members');
  const body = parse(z.object({ email: email.optional() }), await c.req.json().catch(() => ({})));
  await rateLimit(`invite:${a.user.id}`, 20, 3600);
  const token = randomToken(24);
  await q(`UPDATE invitations SET revoked_at = now() WHERE household_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [a.household.id]);
  await q(`INSERT INTO invitations (household_id, token_hash, email, invited_by, expires_at) VALUES ($1,$2,$3,$4, now() + interval '7 days')`, [
    a.household.id, sha256(token), body.email ?? null, a.user.id,
  ]);
  const origin = process.env.APP_URL ?? new URL(c.req.url).origin;
  return c.json({ token, url: `${origin}/invite/${token}`, expires_in_days: 7 }, 201);
});

householdRoutes.delete('/invitations/:id', async (c) => {
  const a = requireAuth(c);
  await q('UPDATE invitations SET revoked_at = now() WHERE id = $1 AND household_id = $2', [c.req.param('id'), a.household.id]);
  return c.json({ ok: true });
});

householdRoutes.patch('/', async (c) => {
  const a = requireAuth(c);
  const body = parse(
    z.object({
      name: z.string().trim().min(1).max(80).optional(),
      timezone: z.string().max(64).optional(),
      currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      auto_move_to_stock: z.boolean().optional(),
    }),
    await c.req.json(),
  );
  if (body.timezone && !isValidTimeZone(body.timezone)) throw badRequest('Unknown time zone');
  await q(
    `UPDATE households SET name = COALESCE($2, name), timezone = COALESCE($3, timezone), currency = COALESCE($4, currency),
       auto_move_to_stock = COALESCE($5, auto_move_to_stock), updated_at = now() WHERE id = $1`,
    [a.household.id, body.name ?? null, body.timezone ?? null, body.currency ?? null, body.auto_move_to_stock ?? null],
  );
  return c.json(publicAuth((await loadAuthForUser(a.user.id))!));
});

householdRoutes.get('/settings', async (c) => {
  const a = requireAuth(c);
  return c.json({ settings: await q1('SELECT * FROM user_settings WHERE user_id = $1', [a.user.id]) });
});

const SECTIONS = ['today', 'upcoming', 'need', 'reminders', 'assigned', 'awaiting', 'recent'] as const;
householdRoutes.patch('/settings', async (c) => {
  const a = requireAuth(c);
  const b = parse(
    z.object({
      notify_mentions: z.boolean().optional(), notify_replies: z.boolean().optional(), notify_shared: z.boolean().optional(),
      notify_assigned: z.boolean().optional(), notify_reminders: z.boolean().optional(), notify_calendar: z.boolean().optional(),
      notify_decisions: z.boolean().optional(), dashboard_sections: z.array(z.enum(SECTIONS)).max(10).optional(),
    }),
    await c.req.json(),
  );
  const cols = Object.entries(b).filter(([, v]) => v !== undefined);
  if (cols.length) {
    const sets = cols.map(([k], i) => `${k} = $${i + 2}`).join(', ');
    await q(`UPDATE user_settings SET ${sets} WHERE user_id = $1`, [a.user.id, ...cols.map(([, v]) => v)]);
  }
  return c.json({ settings: await q1('SELECT * FROM user_settings WHERE user_id = $1', [a.user.id]) });
});
