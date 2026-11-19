import { Hono } from 'hono';
import { z } from 'zod';
import { q, q1 } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { accessibleWorkspaceIds, assertMember, loadEntity, workspaceFor, type AppEnv } from '../lib/access.js';
import { badRequest, dateStr, optText, optUrl, parse, space, uuid } from '../lib/http.js';
import { decorate } from '../lib/serialize.js';
import { dispatchDueReminders, logActivity } from '../lib/notify.js';
import { addDays, todayIn } from '../lib/time.js';
import { ROOMS } from '../lib/defaults.js';
import { serializeItems } from './items.js';

export const householdModuleRoutes = new Hono<AppEnv>();

// --------------------------------------------------------------- inventory
const invFields = z.object({
  name: z.string().trim().min(1).max(200),
  room: z.string().trim().min(1).max(60).optional(),
  category: optText(60),
  brand: optText(80),
  model: optText(80),
  dimensions: optText(120),
  purchase_date: dateStr.nullish(),
  price_cents: z.number().int().min(0).max(1e11).nullish(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullish(),
  warranty_until: dateStr.nullish(),
  warranty_notes: optText(500),
  manual_url: optUrl,
  notes: z.string().max(5000).optional(),
});
const INV_COLS = Object.keys(invFields.shape);

householdModuleRoutes.get('/rooms', (c) => c.json({ rooms: ROOMS }));

householdModuleRoutes.get('/spaces/:space/inventory', async (c) => {
  const a = requireAuth(c);
  const ws = workspaceFor(a, parse(space, c.req.param('space')));
  const f = parse(z.object({ room: z.string().max(60).optional(), q: z.string().max(100).optional(), archived: z.enum(['true']).optional() }), c.req.query());
  const rows = await q(
    `SELECT * FROM inventory_items WHERE workspace_id = $1 AND ($2::text IS NULL OR room = $2)
       AND ($3::text IS NULL OR name ILIKE '%'||$3||'%' OR brand ILIKE '%'||$3||'%' OR notes ILIKE '%'||$3||'%')
       AND (CASE WHEN $4 THEN archived_at IS NOT NULL ELSE archived_at IS NULL END)
     ORDER BY room, lower(name)`,
    [ws, f.room ?? null, f.q ?? null, f.archived === 'true'],
  );
  return c.json({ inventory: await withImages('inventory', await decorate(a, 'inventory', rows)) });
});

async function withImages(type: string, rows: any[]) {
  if (!rows.length) return rows;
  const imgs = await q<any>(
    `SELECT id, entity_id, filename, content_type FROM attachments WHERE entity_type = $1 AND entity_id = ANY($2::uuid[]) ORDER BY created_at`,
    [type, rows.map((r) => r.id)],
  );
  return rows.map((r) => ({ ...r, attachments: imgs.filter((i) => i.entity_id === r.id).map((i) => ({ ...i, url: `/api/attachments/${i.id}` })) }));
}

householdModuleRoutes.post('/spaces/:space/inventory', async (c) => {
  const a = requireAuth(c);
  const ws = workspaceFor(a, parse(space, c.req.param('space')));
  const b = parse(invFields, await c.req.json());
  const keys = INV_COLS.filter((k) => (b as any)[k] !== undefined);
  const row = await q1<any>(
    `INSERT INTO inventory_items (workspace_id, created_by, updated_by${keys.map((k) => `, ${k}`).join('')}) VALUES ($1,$2,$2${keys.map((_, i) => `, $${i + 3}`).join('')}) RETURNING *`,
    [ws, a.user.id, ...keys.map((k) => (b as any)[k])],
  );
  await logActivity(ws, 'inventory', row.id, a.user.id, 'created', `Added “${row.name}” (${row.room})`);
  return c.json({ item: row }, 201);
});

householdModuleRoutes.get('/inventory/:id', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'inventory', c.req.param('id'));
  const [item] = await withImages('inventory', await decorate(a, 'inventory', [row]));
  return c.json({ item });
});

householdModuleRoutes.patch('/inventory/:id', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'inventory', c.req.param('id'));
  const b = parse(invFields.partial(), await c.req.json());
  const keys = INV_COLS.filter((k) => (b as any)[k] !== undefined);
  if (!keys.length) return c.json({ item: row });
  const updated = await q1(
    `UPDATE inventory_items SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
    [row.id, a.user.id, ...keys.map((k) => (b as any)[k])],
  );
  await logActivity(row.workspace_id, 'inventory', row.id, a.user.id, 'updated', `Changed ${keys.join(', ').replace(/_/g, ' ')}`);
  return c.json({ item: updated });
});

// ---------------------------------------------------------------- expenses
const expFields = z.object({
  title: z.string().trim().min(1).max(200),
  amount_cents: z.number().int().min(0).max(1e11),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  purchase_date: dateStr,
  purchaser_id: uuid.nullish(),
  category: optText(60),
  notes: z.string().max(5000).optional(),
  split_mode: z.enum(['individual', 'equal', 'custom']).optional(),
  allocations: z.array(z.object({ user_id: uuid, amount_cents: z.number().int().min(0) })).max(2).optional(),
});

function checkAllocations(a: any, b: { amount_cents?: number; split_mode?: string; allocations?: { user_id: string; amount_cents: number }[] }) {
  if (b.split_mode !== 'custom') return;
  const allocs = b.allocations ?? [];
  allocs.forEach((x) => assertMember(a, x.user_id));
  if (allocs.reduce((s, x) => s + x.amount_cents, 0) !== b.amount_cents) throw badRequest('The amounts each person covers must add up to the total');
}

async function saveAllocations(a: any, expenseId: string, ws: string, b: { amount_cents: number; split_mode?: string; allocations?: { user_id: string; amount_cents: number }[] }) {
  await q('DELETE FROM expense_allocations WHERE expense_id = $1', [expenseId]);
  const mode = ws === a.personalWorkspaceId ? 'individual' : b.split_mode ?? 'individual';
  if (mode === 'equal') {
    const share = Math.floor(b.amount_cents / a.members.length);
    for (const [i, m] of a.members.entries()) {
      await q('INSERT INTO expense_allocations (expense_id, user_id, amount_cents) VALUES ($1,$2,$3)', [expenseId, m.id, i === 0 ? b.amount_cents - share * (a.members.length - 1) : share]);
    }
  } else if (mode === 'custom') {
    const allocs = b.allocations ?? [];
    allocs.forEach((x) => assertMember(a, x.user_id));
    if (allocs.reduce((s, x) => s + x.amount_cents, 0) !== b.amount_cents) throw badRequest('The amounts each person covers must add up to the total');
    for (const x of allocs) await q('INSERT INTO expense_allocations (expense_id, user_id, amount_cents) VALUES ($1,$2,$3)', [expenseId, x.user_id, x.amount_cents]);
  }
  return mode;
}

householdModuleRoutes.get('/spaces/:space/expenses', async (c) => {
  const a = requireAuth(c);
  const ws = workspaceFor(a, parse(space, c.req.param('space')));
  const f = parse(z.object({ from: dateStr.optional(), to: dateStr.optional(), category: z.string().max(60).optional(), purchaser_id: uuid.optional() }), c.req.query());
  const rows = await q<any>(
    `SELECT e.*, COALESCE((SELECT json_agg(json_build_object('user_id', user_id, 'amount_cents', amount_cents)) FROM expense_allocations WHERE expense_id = e.id), '[]') AS allocations
       FROM expenses e WHERE workspace_id = $1 AND archived_at IS NULL
        AND ($2::date IS NULL OR purchase_date >= $2) AND ($3::date IS NULL OR purchase_date <= $3)
        AND ($4::text IS NULL OR category = $4) AND ($5::uuid IS NULL OR purchaser_id = $5)
      ORDER BY purchase_date DESC, created_at DESC LIMIT 1000`,
    [ws, f.from ?? null, f.to ?? null, f.category ?? null, f.purchaser_id ?? null],
  );
  // Totals and "who paid vs who is responsible" balance for shared expenses.
  const total = rows.reduce((s, r) => s + Number(r.amount_cents), 0);
  const byCategory: Record<string, number> = {};
  for (const r of rows) byCategory[r.category ?? 'Other'] = (byCategory[r.category ?? 'Other'] ?? 0) + Number(r.amount_cents);
  const balance: Record<string, { paid: number; responsible: number }> = {};
  for (const m of a.members) balance[m.id] = { paid: 0, responsible: 0 };
  for (const r of rows) {
    if (r.split_mode === 'individual') continue;
    if (r.purchaser_id && balance[r.purchaser_id]) balance[r.purchaser_id].paid += Number(r.amount_cents);
    for (const al of r.allocations) if (balance[al.user_id]) balance[al.user_id].responsible += Number(al.amount_cents);
  }
  return c.json({ expenses: rows, totals: { total, by_category: byCategory, balance } });
});

householdModuleRoutes.post('/spaces/:space/expenses', async (c) => {
  const a = requireAuth(c);
  const ws = workspaceFor(a, parse(space, c.req.param('space')));
  const b = parse(expFields, await c.req.json());
  assertMember(a, b.purchaser_id);
  checkAllocations(a, b);
  const row = await q1<any>(
    `INSERT INTO expenses (workspace_id, title, amount_cents, currency, purchase_date, purchaser_id, category, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [ws, b.title, b.amount_cents, b.currency ?? a.household.currency, b.purchase_date, b.purchaser_id ?? a.user.id, b.category, b.notes ?? '', a.user.id],
  );
  const mode = await saveAllocations(a, row.id, ws, b);
  await q('UPDATE expenses SET split_mode = $2 WHERE id = $1', [row.id, mode]);
  await logActivity(ws, 'expense', row.id, a.user.id, 'created', `Recorded expense “${row.title}”`);
  return c.json({ expense: { ...row, split_mode: mode } }, 201);
});

householdModuleRoutes.patch('/expenses/:id', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'expense', c.req.param('id'));
  const b = parse(expFields.partial(), await c.req.json());
  assertMember(a, b.purchaser_id);
  const merged = { ...row, ...b };
  if (b.split_mode === 'custom' || b.allocations) checkAllocations(a, { ...merged, split_mode: b.split_mode ?? row.split_mode });
  await q(
    `UPDATE expenses SET title = $2, amount_cents = $3, currency = $4, purchase_date = $5, purchaser_id = $6, category = $7, notes = $8, updated_at = now() WHERE id = $1`,
    [row.id, merged.title, merged.amount_cents, merged.currency, merged.purchase_date, merged.purchaser_id, merged.category, merged.notes],
  );
  if (b.split_mode || b.allocations || b.amount_cents !== undefined) {
    const mode = await saveAllocations(a, row.id, row.workspace_id, { amount_cents: merged.amount_cents, split_mode: b.split_mode ?? row.split_mode, allocations: b.allocations });
    await q('UPDATE expenses SET split_mode = $2 WHERE id = $1', [row.id, mode]);
  }
  await logActivity(row.workspace_id, 'expense', row.id, a.user.id, 'updated', 'Updated expense');
  return c.json({ ok: true });
});

// ----------------------------------------------------------- notifications
householdModuleRoutes.get('/notifications', async (c) => {
  const a = requireAuth(c);
  await dispatchDueReminders(a.household.id);
  const f = parse(z.object({ unread: z.enum(['true']).optional() }), c.req.query());
  const rows = await q(
    `SELECT n.*, u.display_name AS actor_name FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
      WHERE n.user_id = $1 AND ($2::boolean IS NOT TRUE OR n.read_at IS NULL)
        AND (n.workspace_id IS NULL OR n.workspace_id = ANY($3::uuid[]))
      ORDER BY n.created_at DESC LIMIT 100`,
    [a.user.id, f.unread === 'true', accessibleWorkspaceIds(a)],
  );
  const unread = await q1<{ n: number }>('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [a.user.id]);
  return c.json({ notifications: rows, unread: unread?.n ?? 0 });
});

householdModuleRoutes.post('/notifications/read', async (c) => {
  const a = requireAuth(c);
  const b = parse(z.object({ ids: z.array(uuid).max(500).optional(), all: z.boolean().optional() }), await c.req.json());
  if (b.all) await q('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [a.user.id]);
  else if (b.ids?.length) await q('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[])', [a.user.id, b.ids]);
  return c.json({ ok: true });
});

// ------------------------------------------------------------------ search
householdModuleRoutes.get('/search', async (c) => {
  const a = requireAuth(c);
  const { q: term } = parse(z.object({ q: z.string().trim().min(2).max(100) }), c.req.query());
  const wss = accessibleWorkspaceIds(a);
  const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const [items, tasks, events, inventory, messages, expenses] = await Promise.all([
    q(`SELECT i.id, i.workspace_id, i.title, i.module, i.grocery_state, i.archived_at, 'item' AS type FROM items i LEFT JOIN categories c ON c.id = i.category_id
        WHERE i.workspace_id = ANY($1::uuid[]) AND (i.title ILIKE $2 OR i.notes ILIKE $2 OR c.name ILIKE $2 OR i.room ILIKE $2 OR i.store ILIKE $2
          OR EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id AND t.name ILIKE $2))
        ORDER BY i.archived_at NULLS FIRST, i.updated_at DESC LIMIT 30`, [wss, like]),
    q(`SELECT id, workspace_id, title, status, due_date, archived_at, 'task' AS type FROM tasks WHERE workspace_id = ANY($1::uuid[]) AND (title ILIKE $2 OR description ILIKE $2) ORDER BY updated_at DESC LIMIT 20`, [wss, like]),
    q(`SELECT id, workspace_id, title, start_date, archived_at, 'event' AS type FROM events WHERE workspace_id = ANY($1::uuid[]) AND (title ILIKE $2 OR description ILIKE $2 OR location ILIKE $2 OR notes ILIKE $2 OR category ILIKE $2) ORDER BY start_date DESC LIMIT 20`, [wss, like]),
    q(`SELECT id, workspace_id, name AS title, room, archived_at, 'inventory' AS type FROM inventory_items WHERE workspace_id = ANY($1::uuid[]) AND (name ILIKE $2 OR brand ILIKE $2 OR model ILIKE $2 OR notes ILIKE $2 OR room ILIKE $2) LIMIT 20`, [wss, like]),
    q(`SELECT m.id AS message_id, t.entity_type AS type, t.entity_id AS id, t.workspace_id, m.body, m.created_at FROM messages m JOIN threads t ON t.id = m.thread_id
        WHERE t.workspace_id = ANY($1::uuid[]) AND m.deleted_at IS NULL AND m.body ILIKE $2 ORDER BY m.created_at DESC LIMIT 20`, [wss, like]),
    q(`SELECT id, workspace_id, title, amount_cents, purchase_date, 'expense' AS type FROM expenses WHERE workspace_id = ANY($1::uuid[]) AND (title ILIKE $2 OR notes ILIKE $2 OR category ILIKE $2) LIMIT 20`, [wss, like]),
  ]);
  const label = (ws: string) => (ws === a.sharedWorkspaceId ? 'us' : 'me');
  const titles = new Map<string, string>();
  for (const m of messages as any[]) {
    const table = { item: 'items', task: 'tasks', event: 'events', inventory: 'inventory_items', expense: 'expenses' }[m.type as string];
    const col = m.type === 'inventory' ? 'name' : 'title';
    if (table && !titles.has(m.id)) titles.set(m.id, (await q1<any>(`SELECT ${col} AS t FROM ${table} WHERE id = $1 AND workspace_id = ANY($2::uuid[])`, [m.id, wss]))?.t ?? '');
  }
  return c.json({
    results: [
      ...[...items, ...tasks, ...events, ...inventory, ...expenses].map((r: any) => ({ ...r, space: label(r.workspace_id) })),
      ...messages.map((m: any) => ({ ...m, title: titles.get(m.id), space: label(m.workspace_id), match: 'conversation' })),
    ],
  });
});

householdModuleRoutes.get('/recent', async (c) => {
  const a = requireAuth(c);
  const wss = accessibleWorkspaceIds(a);
  const rows = await q(
    `SELECT rv.entity_type AS type, rv.entity_id AS id, rv.viewed_at,
            COALESCE(i.title, t.title, e.title) AS title, COALESCE(i.workspace_id, t.workspace_id, e.workspace_id) AS workspace_id
       FROM recently_viewed rv
       LEFT JOIN items i ON rv.entity_type = 'item' AND i.id = rv.entity_id AND i.workspace_id = ANY($2::uuid[])
       LEFT JOIN tasks t ON rv.entity_type = 'task' AND t.id = rv.entity_id AND t.workspace_id = ANY($2::uuid[])
       LEFT JOIN events e ON rv.entity_type = 'event' AND e.id = rv.entity_id AND e.workspace_id = ANY($2::uuid[])
      WHERE rv.user_id = $1 AND COALESCE(i.id, t.id, e.id) IS NOT NULL ORDER BY rv.viewed_at DESC LIMIT 12`,
    [a.user.id, wss],
  );
  return c.json({ recent: rows.map((r: any) => ({ ...r, space: r.workspace_id === a.sharedWorkspaceId ? 'us' : 'me' })) });
});

householdModuleRoutes.get('/favorites', async (c) => {
  const a = requireAuth(c);
  const wss = accessibleWorkspaceIds(a);
  const rows = await q(
    `SELECT f.entity_type AS type, f.entity_id AS id, COALESCE(i.title, t.title, e.title, inv.name) AS title, COALESCE(i.workspace_id, t.workspace_id, e.workspace_id, inv.workspace_id) AS workspace_id
       FROM favorites f
       LEFT JOIN items i ON f.entity_type = 'item' AND i.id = f.entity_id AND i.workspace_id = ANY($2::uuid[])
       LEFT JOIN tasks t ON f.entity_type = 'task' AND t.id = f.entity_id AND t.workspace_id = ANY($2::uuid[])
       LEFT JOIN events e ON f.entity_type = 'event' AND e.id = f.entity_id AND e.workspace_id = ANY($2::uuid[])
       LEFT JOIN inventory_items inv ON f.entity_type = 'inventory' AND inv.id = f.entity_id AND inv.workspace_id = ANY($2::uuid[])
      WHERE f.user_id = $1 AND COALESCE(i.id, t.id, e.id, inv.id) IS NOT NULL ORDER BY f.created_at DESC LIMIT 50`,
    [a.user.id, wss],
  );
  return c.json({ favorites: rows.map((r: any) => ({ ...r, space: r.workspace_id === a.sharedWorkspaceId ? 'us' : 'me' })) });
});

householdModuleRoutes.get('/archive', async (c) => {
  const a = requireAuth(c);
  const wss = accessibleWorkspaceIds(a);
  const rows = await q(
    `SELECT 'item' AS type, id, workspace_id, title, archived_at, module AS detail FROM items WHERE workspace_id = ANY($1::uuid[]) AND archived_at IS NOT NULL
     UNION ALL SELECT 'task', id, workspace_id, title, COALESCE(archived_at, updated_at), status FROM tasks WHERE workspace_id = ANY($1::uuid[]) AND (archived_at IS NOT NULL OR status = 'archived')
     UNION ALL SELECT 'event', id, workspace_id, title, archived_at, start_date::text FROM events WHERE workspace_id = ANY($1::uuid[]) AND archived_at IS NOT NULL
     UNION ALL SELECT 'inventory', id, workspace_id, name, archived_at, room FROM inventory_items WHERE workspace_id = ANY($1::uuid[]) AND archived_at IS NOT NULL
     UNION ALL SELECT 'expense', id, workspace_id, title, archived_at, purchase_date::text FROM expenses WHERE workspace_id = ANY($1::uuid[]) AND archived_at IS NOT NULL
     ORDER BY archived_at DESC LIMIT 300`,
    [wss],
  );
  return c.json({ archived: rows.map((r: any) => ({ ...r, space: r.workspace_id === a.sharedWorkspaceId ? 'us' : 'me' })) });
});
