import { Hono } from 'hono';
import { z } from 'zod';
import { q, q1 } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import type { AppEnv } from '../lib/access.js';
import { badRequest, dateStr, notFound, parse, uuid } from '../lib/http.js';

/**
 * Names you see for someone in the household on certain days, e.g. "Big
 * Friday" every Friday or "Birthday Boy" on 11 December. A rule is only ever
 * visible to the person who made it.
 */
export const nicknameRoutes = new Hono<AppEnv>();

const ruleBody = z.object({
  target_id: uuid,
  name: z.string().trim().min(1).max(40),
  rule: z.enum(['weekly', 'yearly', 'once']),
  weekday: z.number().int().min(0).max(6).optional(),
  month_day: z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/).optional(),
  on_date: dateStr.optional(),
});

nicknameRoutes.get('/nicknames', async (c) => {
  const a = requireAuth(c);
  const rows = await q('SELECT id, target_id, name, rule, weekday, month_day, on_date::text FROM nicknames WHERE owner_id = $1 ORDER BY created_at', [a.user.id]);
  return c.json({ nicknames: rows });
});

nicknameRoutes.post('/nicknames', async (c) => {
  const a = requireAuth(c);
  const b = parse(ruleBody, await c.req.json());
  if (!a.members.some((m) => m.id === b.target_id)) throw badRequest('Choose someone in your household');
  if (b.rule === 'weekly' && b.weekday === undefined) throw badRequest('Choose a day of the week');
  if (b.rule === 'yearly' && !b.month_day) throw badRequest('Choose a day of the year');
  if (b.rule === 'once' && !b.on_date) throw badRequest('Choose a date');
  const row = await q1(
    `INSERT INTO nicknames (owner_id, target_id, name, rule, weekday, month_day, on_date) VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, target_id, name, rule, weekday, month_day, on_date::text`,
    [a.user.id, b.target_id, b.name, b.rule, b.rule === 'weekly' ? b.weekday : null, b.rule === 'yearly' ? b.month_day : null, b.rule === 'once' ? b.on_date : null],
  );
  return c.json({ nickname: row }, 201);
});

nicknameRoutes.delete('/nicknames/:id', async (c) => {
  const a = requireAuth(c);
  const rows = await q('DELETE FROM nicknames WHERE id = $1 AND owner_id = $2 RETURNING id', [parse(uuid, c.req.param('id')), a.user.id]);
  if (!rows.length) throw notFound();
  return c.json({ ok: true });
});
