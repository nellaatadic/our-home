import { Hono } from 'hono';
import { z } from 'zod';
import { q, q1 } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { assertMember, assertWorkspace, loadEntity, workspaceFor, type AppEnv, type Auth } from '../lib/access.js';
import { badRequest, dateStr, notFound, optText, optUrl, parse, priority, space, timeStr, uuid } from '../lib/http.js';
import { decorate } from '../lib/serialize.js';
import { logActivity, notify } from '../lib/notify.js';
import { fetchLinkPreview } from '../lib/linkpreview.js';
import { addDays, addMonths, todayIn, zonedToUtc } from '../lib/time.js';

export const itemRoutes = new Hono<AppEnv>();

export const MODULE = z.enum(['grocery', 'home', 'idea']);
const DECISION = z.enum(['idea', 'considering', 'discussing', 'approved', 'purchased', 'rejected']);
const STAGE = z.enum(['suggested', 'preferred', 'agreed', 'purchased']);

export const itemFields = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(5000).optional(),
  category_id: uuid.nullish(),
  idea_type: optText(60),
  priority: priority.optional(),
  decision_status: DECISION.nullish(),
  purchase_stage: STAGE.nullish(),
  quantity: z.number().min(0).max(1e6).nullish(),
  unit: optText(20),
  assigned_to: uuid.nullish(),
  intended_for_user_id: uuid.nullish(),
  intended_for_name: optText(60),
  link_url: optUrl,
  link_title: optText(200),
  link_image_url: optUrl,
  price_cents: z.number().int().min(0).max(1e11).nullish(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullish(),
  room: optText(60),
  dimensions: optText(120),
  color_material: optText(120),
  store: optText(120),
  target_date: dateStr.nullish(),
  purchased_on: dateStr.nullish(),
  expires_on: dateStr.nullish(),
  storage_location: optText(80),
  related_event_id: uuid.nullish(),
  due_date: dateStr.nullish(),
  due_time: timeStr.nullish(),
  urgent: z.boolean().optional(),
  flagged: z.boolean().optional(),
  repeat_unit: z.enum(['day', 'week', 'month', 'year']).nullish(),
  early_reminder_minutes: z.number().int().min(0).max(43200).nullish(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});

const UPDATABLE = [
  'title', 'notes', 'category_id', 'idea_type', 'priority', 'decision_status', 'purchase_stage', 'quantity', 'unit', 'assigned_to',
  'intended_for_user_id', 'intended_for_name', 'link_url', 'link_title', 'link_image_url', 'price_cents', 'currency', 'room', 'dimensions',
  'color_material', 'store', 'target_date', 'purchased_on', 'expires_on', 'storage_location', 'related_event_id',
  'due_date', 'due_time', 'urgent', 'flagged', 'repeat_unit', 'early_reminder_minutes',
] as const;

/** When a reminder for an item with a date should fire (09:00 when no time is set). */
export function itemReminderAt(row: { due_date: string | null; due_time: string | null; early_reminder_minutes: number | null }, tz: string): Date | null {
  if (!row.due_date) return null;
  const at = zonedToUtc(row.due_date, (row.due_time ?? '09:00').slice(0, 5), tz);
  return new Date(at.getTime() - (row.early_reminder_minutes ?? 0) * 60_000);
}

export function advanceDate(date: string, unit: 'day' | 'week' | 'month' | 'year'): string {
  return unit === 'day' ? addDays(date, 1) : unit === 'week' ? addDays(date, 7) : unit === 'month' ? addMonths(date, 1) : addMonths(date, 12);
}

/** Recompute reminder_at after the date fields changed; a changed time re-arms the reminder. */
export async function syncItemReminder(row: any, tz: string) {
  const at = itemReminderAt(row, tz);
  const prev = row.reminder_at ? new Date(row.reminder_at).getTime() : null;
  if ((at?.getTime() ?? null) === prev) return row;
  return q1('UPDATE items SET reminder_at = $2, reminder_sent_at = NULL WHERE id = $1 RETURNING *', [row.id, at]);
}

/** Map a category to the same-named one in another workspace (creating it if needed). */
export async function resolveCategory(auth: Auth, targetWs: string, module: string, categoryId: string | null | undefined): Promise<string | null> {
  if (!categoryId) return null;
  const cat = await q1<any>('SELECT * FROM categories WHERE id = $1 AND workspace_id = ANY($2::uuid[]) AND module = $3', [
    categoryId, [auth.personalWorkspaceId, auth.sharedWorkspaceId], module,
  ]);
  if (!cat) throw badRequest('Unknown category for this list');
  if (cat.workspace_id === targetWs) return cat.id;
  const same = await q1<{ id: string }>(
    `INSERT INTO categories (workspace_id, module, group_name, name, color, sort_order) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (workspace_id, module, lower(name)) DO UPDATE SET name = categories.name RETURNING id`,
    [targetWs, module, cat.group_name, cat.name, cat.color, cat.sort_order],
  );
  return same!.id;
}

async function assertCategory(workspaceId: string, module: string, categoryId: string | null | undefined) {
  if (!categoryId) return;
  const c = await q1('SELECT 1 FROM categories WHERE id = $1 AND workspace_id = $2 AND module = $3', [categoryId, workspaceId, module]);
  if (!c) throw badRequest('Unknown category for this list');
}

export async function setTags(workspaceId: string, itemId: string, tags: string[]) {
  await q('DELETE FROM item_tags WHERE item_id = $1', [itemId]);
  for (const t of [...new Set(tags.map((x) => x.trim()).filter(Boolean))]) {
    const tag = await q1<{ id: string }>(
      `INSERT INTO tags (workspace_id, name) VALUES ($1, $2) ON CONFLICT (workspace_id, lower(name)) DO UPDATE SET name = tags.name RETURNING id`,
      [workspaceId, t],
    );
    await q('INSERT INTO item_tags (item_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [itemId, tag!.id]);
  }
}

export async function serializeItems(auth: Auth, rows: any[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [tags, images, cats, subs] = await Promise.all([
    q<{ item_id: string; name: string }>('SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = ANY($1::uuid[]) ORDER BY t.name', [ids]),
    q<{ entity_id: string; id: string; filename: string }>(
      `SELECT entity_id, id, filename FROM attachments WHERE entity_type = 'item' AND entity_id = ANY($1::uuid[]) AND content_type LIKE 'image/%' ORDER BY created_at`,
      [ids],
    ),
    q<{ id: string; name: string; color: string; group_name: string | null }>('SELECT id, name, color, group_name FROM categories WHERE id = ANY($1::uuid[])', [
      rows.map((r) => r.category_id).filter(Boolean),
    ]),
    q<{ item_id: string; total: number; done: number }>(
      'SELECT item_id, count(*)::int AS total, count(*) FILTER (WHERE done)::int AS done FROM subtasks WHERE item_id = ANY($1::uuid[]) GROUP BY item_id',
      [ids],
    ),
  ]);
  const subMap = new Map(subs.map((x) => [x.item_id, { total: x.total, done: x.done }]));
  const catMap = new Map(cats.map((c) => [c.id, c]));
  const decorated = await decorate(auth, 'item', rows);
  return decorated.map((r: any) => ({
    ...r,
    category: r.category_id ? catMap.get(r.category_id) ?? null : null,
    tags: tags.filter((t) => t.item_id === r.id).map((t) => t.name),
    images: images.filter((i) => i.entity_id === r.id).map((i) => ({ id: i.id, filename: i.filename, url: `/api/attachments/${i.id}` })),
    subtasks: subMap.get(r.id) ?? { total: 0, done: 0 },
    private: r.workspace_id === auth.personalWorkspaceId,
    can_lock: r.created_by === auth.user.id,
  }));
}

// ----------------------------------------------------------------- lists
itemRoutes.get('/spaces/:space/lists', async (c) => {
  const a = requireAuth(c);
  const ws = workspaceFor(a, parse(space, c.req.param('space')));
  const module = c.req.query('module');
  const rows = await q(
    `SELECT l.*, (SELECT count(*)::int FROM items i WHERE i.list_id = l.id AND i.archived_at IS NULL) AS item_count
       FROM lists l WHERE l.workspace_id = $1 AND l.archived_at IS NULL AND ($2::text IS NULL OR l.module = $2)
      ORDER BY l.is_default DESC, l.created_at`,
    [ws, module ?? null],
  );
  return c.json({ lists: rows });
});

itemRoutes.post('/spaces/:space/lists', async (c) => {
  const a = requireAuth(c);
  const ws = workspaceFor(a, parse(space, c.req.param('space')));
  const b = parse(z.object({ module: MODULE, name: z.string().trim().min(1).max(80) }), await c.req.json());
  const list = await q1('INSERT INTO lists (workspace_id, module, name, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [ws, b.module, b.name, a.user.id]);
  return c.json({ list }, 201);
});

itemRoutes.patch('/lists/:id', async (c) => {
  const a = requireAuth(c);
  const list = await q1<any>('SELECT * FROM lists WHERE id = $1', [parse(uuid, c.req.param('id'))]);
  if (!list) throw notFound();
  assertWorkspace(a, list.workspace_id);
  const b = parse(z.object({ name: z.string().trim().min(1).max(80).optional(), archived: z.boolean().optional() }), await c.req.json());
  if (b.archived && list.is_default) throw badRequest('The default list cannot be archived');
  const row = await q1(
    `UPDATE lists SET name = COALESCE($2, name), archived_at = CASE WHEN $3::boolean IS NULL THEN archived_at WHEN $3 THEN now() ELSE NULL END
      WHERE id = $1 RETURNING *`,
    [list.id, b.name ?? null, b.archived ?? null],
  );
  return c.json({ list: row });
});

// ------------------------------------------------------------ categories
itemRoutes.get('/spaces/:space/categories', async (c) => {
  const a = requireAuth(c);
  const ws = workspaceFor(a, parse(space, c.req.param('space')));
  const rows = await q('SELECT * FROM categories WHERE workspace_id = $1 AND ($2::text IS NULL OR module = $2) ORDER BY module, sort_order, name', [
    ws, c.req.query('module') ?? null,
  ]);
  return c.json({ categories: rows });
});

itemRoutes.post('/spaces/:space/categories', async (c) => {
  const a = requireAuth(c);
  const ws = workspaceFor(a, parse(space, c.req.param('space')));
  const b = parse(
    z.object({
      module: z.enum(['grocery', 'home', 'idea']), name: z.string().trim().min(1).max(60), group_name: optText(60),
      color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
    }),
    await c.req.json(),
  );
  const row = await q1(
    `INSERT INTO categories (workspace_id, module, name, group_name, color) VALUES ($1,$2,$3,$4,COALESCE($5,'#8a8178'))
     ON CONFLICT (workspace_id, module, lower(name)) DO UPDATE SET name = categories.name RETURNING *`,
    [ws, b.module, b.name, b.group_name, b.color ?? null],
  );
  return c.json({ category: row }, 201);
});

itemRoutes.delete('/categories/:id', async (c) => {
  const a = requireAuth(c);
  const cat = await q1<any>('SELECT * FROM categories WHERE id = $1', [parse(uuid, c.req.param('id'))]);
  if (!cat) throw notFound();
  assertWorkspace(a, cat.workspace_id);
  await q('DELETE FROM categories WHERE id = $1', [cat.id]);
  return c.json({ ok: true });
});

// ----------------------------------------------------------------- items
const SORTS: Record<string, string> = {
  recent: 'i.updated_at DESC',
  priority: `array_position(ARRAY['urgent','high','normal','low'], i.priority), i.created_at DESC`,
  title: 'lower(i.title)',
  category: 'c.sort_order NULLS LAST, lower(i.title)',
  price: 'i.price_cents DESC NULLS LAST',
  oldest: 'i.created_at',
};

itemRoutes.get('/spaces/:space/items', async (c) => {
  const a = requireAuth(c);
  const ws = workspaceFor(a, parse(space, c.req.param('space')));
  const f = parse(
    z.object({
      module: MODULE, list_id: uuid.optional(), state: z.enum(['need', 'stock']).optional(), category_id: uuid.optional(),
      priority: priority.optional(), assigned_to: uuid.optional(), status: DECISION.optional(), tag: z.string().max(40).optional(),
      q: z.string().max(100).optional(), sort: z.enum(Object.keys(SORTS) as [string, ...string[]]).optional(),
      archived: z.enum(['true', 'false']).optional(), favorites: z.enum(['true']).optional(),
    }),
    c.req.query(),
  );
  const rows = await q(
    `SELECT i.* FROM items i LEFT JOIN categories c ON c.id = i.category_id
      WHERE i.workspace_id = $1 AND i.module = $2
        AND ($3::uuid IS NULL OR i.list_id = $3)
        AND ($4::text IS NULL OR i.grocery_state = $4)
        AND ($5::uuid IS NULL OR i.category_id = $5)
        AND ($6::text IS NULL OR i.priority = $6)
        AND ($7::uuid IS NULL OR i.assigned_to = $7)
        AND ($8::text IS NULL OR i.decision_status = $8)
        AND ($9::text IS NULL OR i.title ILIKE '%' || $9 || '%' OR i.notes ILIKE '%' || $9 || '%')
        AND (CASE WHEN $10 THEN i.archived_at IS NOT NULL ELSE i.archived_at IS NULL END)
        AND ($11::text IS NULL OR EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id AND lower(t.name) = lower($11)))
        AND (NOT $12 OR EXISTS (SELECT 1 FROM favorites fv WHERE fv.user_id = $13 AND fv.entity_type = 'item' AND fv.entity_id = i.id))
      ORDER BY ${SORTS[f.sort ?? 'recent']}
      LIMIT 500`,
    [ws, f.module, f.list_id ?? null, f.state ?? null, f.category_id ?? null, f.priority ?? null, f.assigned_to ?? null, f.status ?? null,
      f.q ?? null, f.archived === 'true', f.tag ?? null, f.favorites === 'true', a.user.id],
  );
  return c.json({ items: await serializeItems(a, rows) });
});

export const createItemBody = itemFields.extend({ module: MODULE, list_id: uuid.optional(), grocery_state: z.enum(['need', 'stock']).optional() });

itemRoutes.post('/spaces/:space/items', async (c) => {
  const a = requireAuth(c);
  const sp = parse(space, c.req.param('space'));
  const b = parse(createItemBody, await c.req.json());
  return c.json({ item: await insertItem(a, sp, b) }, 201);
});

/** Create an item in ME or US. Categories from the other space are mapped by name. */
export async function insertItem(a: Auth, sp: 'me' | 'us', b: z.infer<typeof createItemBody>) {
  const ws = workspaceFor(a, sp);
  const list = b.list_id
    ? await q1<any>('SELECT * FROM lists WHERE id = $1 AND workspace_id = $2 AND module = $3 AND archived_at IS NULL', [b.list_id, ws, b.module])
    : await q1<any>('SELECT * FROM lists WHERE workspace_id = $1 AND module = $2 AND is_default', [ws, b.module]);
  if (!list) throw badRequest('Unknown list');
  b.category_id = await resolveCategory(a, ws, b.module, b.category_id);
  assertMember(a, b.assigned_to);
  assertMember(a, b.intended_for_user_id);
  const state = b.grocery_state ?? 'need';
  const decision = b.module === 'grocery' ? null : b.decision_status ?? 'idea';
  const cols: Record<string, unknown> = {};
  for (const k of UPDATABLE) if ((b as any)[k] !== undefined) cols[k] = (b as any)[k];
  delete cols.decision_status;
  if (state === 'stock' && !cols.purchased_on) cols.purchased_on = todayIn(a.household.timezone);
  const keys = Object.keys(cols);
  const row = await q1<any>(
    `INSERT INTO items (workspace_id, list_id, module, grocery_state, decision_status, created_by, updated_by ${keys.map((k) => `, ${k}`).join('')})
     VALUES ($1,$2,$3,$4,$5,$6,$6 ${keys.map((_, i) => `, $${i + 7}`).join('')}) RETURNING *`,
    [ws, list.id, b.module, state, decision, a.user.id, ...keys.map((k) => cols[k])],
  );
  if (b.tags) await setTags(ws, row.id, b.tags);
  const withReminder = await syncItemReminder(row, a.household.timezone);
  await logActivity(ws, 'item', row.id, a.user.id, 'created', `Added “${row.title}”`);
  if (sp === 'us') await notifyNewSharedItem(a, row);
  return (await serializeItems(a, [withReminder]))[0];
}


async function notifyNewSharedItem(a: Auth, row: any) {
  if (!a.partner) return;
  const forPartner = row.intended_for_user_id === a.partner.id || row.assigned_to === a.partner.id;
  // Grocery additions are frequent and low-stakes; only notify when assigned.
  if (row.module === 'grocery' && !forPartner) return;
  await notify({
    recipients: [a.partner.id], actorId: a.user.id, workspaceId: row.workspace_id,
    type: forPartner && row.assigned_to === a.partner.id ? 'assigned' : 'shared',
    title: forPartner ? `${a.user.display_name} added “${row.title}” for you` : `${a.user.display_name} added “${row.title}” to US`,
    entityType: 'item', entityId: row.id,
  });
}

itemRoutes.get('/items/:id', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity(a, 'item', c.req.param('id'));
  const [item] = await serializeItems(a, [row]);
  const [attachments, activity, origin, list, subtasks] = await Promise.all([
    q(`SELECT id, filename, content_type, size_bytes, created_at, uploaded_by FROM attachments WHERE entity_type = 'item' AND entity_id = $1 ORDER BY created_at`, [row.id]),
    q(`SELECT a.action, a.summary, a.created_at, a.actor_id FROM activity a WHERE a.entity_type = 'item' AND a.entity_id = $1 ORDER BY a.created_at DESC LIMIT 50`, [row.id]),
    // The private original is only described if the viewer can see it.
    row.origin_item_id ? q1('SELECT id, title, workspace_id, updated_at FROM items WHERE id = $1 AND workspace_id = $2', [row.origin_item_id, a.personalWorkspaceId]) : null,
    q1('SELECT id, name FROM lists WHERE id = $1', [row.list_id]),
    q('SELECT id, title, done, position FROM subtasks WHERE item_id = $1 ORDER BY position, created_at', [row.id]),
  ]);
  const alternatives = row.comparison_group_id
    ? await serializeItems(a, await q('SELECT * FROM items WHERE comparison_group_id = $1 AND workspace_id = $2 AND id <> $3 AND archived_at IS NULL ORDER BY created_at', [
      row.comparison_group_id, row.workspace_id, row.id,
    ]))
    : [];
  await q(
    `INSERT INTO recently_viewed (user_id, entity_type, entity_id) VALUES ($1,'item',$2)
     ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE SET viewed_at = now()`,
    [a.user.id, row.id],
  );
  return c.json({ item: { ...item, attachments, activity, own_original: origin, list, subtask_list: subtasks }, alternatives });
});

itemRoutes.patch('/items/:id', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'item', c.req.param('id'));
  const b = parse(itemFields.partial().extend({ list_id: uuid.optional(), comparison_group_id: uuid.nullish(), module: MODULE.optional() }), await c.req.json());
  // Moving to another list (Groceries ↔ Home & Gadgets ↔ Shopping & Other) keeps the space.
  let moduleChange: string | null = null;
  if (b.module && b.module !== row.module) {
    moduleChange = b.module;
    const target = await q1<any>('SELECT id FROM lists WHERE workspace_id = $1 AND module = $2 AND is_default', [row.workspace_id, b.module]);
    if (!target) throw badRequest('Unknown list');
    const cat = row.category_id ? await q1<any>('SELECT name FROM categories WHERE id = $1', [row.category_id]) : null;
    const same = cat ? await q1<any>('SELECT id FROM categories WHERE workspace_id = $1 AND module = $2 AND lower(name) = lower($3)', [row.workspace_id, b.module, cat.name]) : null;
    await q('UPDATE items SET module = $2, list_id = $3, category_id = $4, comparison_group_id = NULL WHERE id = $1', [row.id, b.module, target.id, same?.id ?? null]);
    row.module = b.module; row.list_id = target.id; row.category_id = same?.id ?? null;
    delete b.list_id;
  }
  if (b.category_id) b.category_id = await resolveCategory(a, row.workspace_id, row.module, b.category_id);
  if (b.due_date === null) { b.due_time = null; }
  assertMember(a, b.assigned_to);
  assertMember(a, b.intended_for_user_id);
  if (b.list_id && !(await q1('SELECT 1 FROM lists WHERE id = $1 AND workspace_id = $2 AND module = $3', [b.list_id, row.workspace_id, row.module]))) {
    throw badRequest('Unknown list');
  }
  const cols: Record<string, unknown> = {};
  for (const k of [...UPDATABLE, 'list_id', 'comparison_group_id'] as const) if ((b as any)[k] !== undefined) cols[k] = (b as any)[k];
  if (row.module === 'grocery') { delete cols.decision_status; }
  const keys = Object.keys(cols);
  let updated = row;
  if (moduleChange) await logActivity(row.workspace_id, 'item', row.id, a.user.id, 'moved', `Moved to ${moduleChange === 'grocery' ? 'Groceries' : moduleChange === 'home' ? 'Home & Gadgets' : 'Shopping & Other'}`);
  if (keys.length) {
    updated = await q1(
      `UPDATE items SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
      [row.id, a.user.id, ...keys.map((k) => cols[k])],
    );
    const changed = keys.filter((k) => String(row[k] ?? '') !== String(updated[k] ?? ''));
    if (changed.length) await logActivity(row.workspace_id, 'item', row.id, a.user.id, 'updated', `Changed ${changed.join(', ').replace(/_/g, ' ')}`);
    if (changed.includes('assigned_to') && updated.assigned_to && updated.assigned_to !== a.user.id) {
      await notify({ recipients: [updated.assigned_to], actorId: a.user.id, workspaceId: row.workspace_id, type: 'assigned', title: `${a.user.display_name} assigned “${updated.title}” to you`, entityType: 'item', entityId: row.id });
    }
    if (changed.includes('decision_status') && ['approved', 'rejected', 'purchased'].includes(updated.decision_status)) {
      await notify({
        recipients: a.members.map((m) => m.id), actorId: a.user.id, workspaceId: row.workspace_id, type: 'decision',
        title: `“${updated.title}” marked ${updated.decision_status}`, entityType: 'item', entityId: row.id,
      });
    }
  }
  if (b.tags) await setTags(row.workspace_id, row.id, b.tags);
  if (keys.some((k) => ['due_date', 'due_time', 'early_reminder_minutes'].includes(k))) updated = await syncItemReminder(updated, a.household.timezone);
  return c.json({ item: (await serializeItems(a, [updated]))[0] });
});

/** NEED → STOCK. Optionally merge into an existing STOCK entry to avoid duplicates. */
itemRoutes.post('/items/:id/purchase', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'item', c.req.param('id'));
  if (row.grocery_state !== 'need') throw badRequest('Only NEED items can be marked as purchased');
  const b = parse(
    z.object({
      quantity: z.number().min(0).max(1e6).nullish(), purchased_on: dateStr.optional(), expires_on: dateStr.nullish(),
      storage_location: optText(80), merge_into_id: uuid.optional(),
    }),
    await c.req.json().catch(() => ({})),
  );
  const qty = b.quantity !== undefined ? b.quantity : row.quantity;
  const purchased = b.purchased_on ?? todayIn(a.household.timezone);
  // Repeating items (e.g. "milk every week") stay on NEED with the next date, like a repeating reminder.
  if (row.repeat_unit && row.due_date) {
    const next = await q1('UPDATE items SET due_date = $2, purchased_on = $3, updated_at = now(), updated_by = $4 WHERE id = $1 RETURNING *', [
      row.id, advanceDate(row.due_date, row.repeat_unit), purchased, a.user.id,
    ]);
    await logActivity(row.workspace_id, 'item', row.id, a.user.id, 'purchased', 'Bought; next one scheduled');
    return c.json({ item: (await serializeItems(a, [await syncItemReminder(next, a.household.timezone)]))[0], merged: false, repeated: true });
  }
  if (b.merge_into_id) {
    const target = await q1<any>(`SELECT * FROM items WHERE id = $1 AND workspace_id = $2 AND module = $3 AND grocery_state = 'stock' AND archived_at IS NULL`, [b.merge_into_id, row.workspace_id, row.module]);
    if (!target) throw badRequest('Unknown stock item');
    const merged = await q1(
      `UPDATE items SET quantity = CASE WHEN quantity IS NULL AND $2::numeric IS NULL THEN NULL ELSE COALESCE(quantity,0) + COALESCE($2::numeric,0) END,
         purchased_on = $3, expires_on = COALESCE($4, expires_on), storage_location = COALESCE($5, storage_location), updated_at = now(), updated_by = $6
       WHERE id = $1 RETURNING *`,
      [target.id, qty, purchased, b.expires_on ?? null, b.storage_location, a.user.id],
    );
    await q('UPDATE items SET archived_at = now(), updated_at = now(), updated_by = $2 WHERE id = $1', [row.id, a.user.id]);
    await logActivity(row.workspace_id, 'item', target.id, a.user.id, 'restocked', `Bought ${qty ?? ''} ${row.title}`.replace(/\s+/g, ' '));
    return c.json({ item: (await serializeItems(a, [merged]))[0], merged: true });
  }
  const updated = await q1(
    `UPDATE items SET grocery_state = 'stock', quantity = $2, purchased_on = $3, expires_on = COALESCE($4, expires_on),
       storage_location = COALESCE($5, storage_location), updated_at = now(), updated_by = $6 WHERE id = $1 RETURNING *`,
    [row.id, qty, purchased, b.expires_on ?? null, b.storage_location, a.user.id],
  );
  await logActivity(row.workspace_id, 'item', row.id, a.user.id, 'purchased', 'Moved to STOCK');
  return c.json({ item: (await serializeItems(a, [updated]))[0], merged: false });
});

/** STOCK → NEED ("we ran out"). */
itemRoutes.post('/items/:id/need', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'item', c.req.param('id'));
  if (row.grocery_state !== 'stock') throw badRequest('Only STOCK items can be moved back to NEED');
  const b = parse(z.object({ quantity: z.number().min(0).max(1e6).nullish() }), await c.req.json().catch(() => ({})));
  const updated = await q1(
    `UPDATE items SET grocery_state = 'need', quantity = $2, purchased_on = NULL, expires_on = NULL, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *`,
    [row.id, b.quantity ?? null, a.user.id],
  );
  await logActivity(row.workspace_id, 'item', row.id, a.user.id, 'needed', 'Moved back to NEED');
  return c.json({ item: (await serializeItems(a, [updated]))[0] });
});

/** Group two items as alternatives for comparison. */
itemRoutes.post('/items/:id/compare', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'item', c.req.param('id'));
  const b = parse(z.object({ other_id: uuid }), await c.req.json());
  const other = await loadEntity<any>(a, 'item', b.other_id);
  if (other.workspace_id !== row.workspace_id || other.id === row.id) throw badRequest('Alternatives must be in the same space');
  const group = row.comparison_group_id ?? other.comparison_group_id ?? crypto.randomUUID();
  await q('UPDATE items SET comparison_group_id = $1, updated_at = now() WHERE id = ANY($2::uuid[]) OR (comparison_group_id IS NOT NULL AND comparison_group_id = ANY($3::uuid[]))', [
    group, [row.id, other.id], [row.comparison_group_id, other.comparison_group_id].filter(Boolean),
  ]);
  return c.json({ comparison_group_id: group });
});

itemRoutes.post('/items/:id/prefer', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'item', c.req.param('id'));
  if (!row.comparison_group_id) throw badRequest('This item has no alternatives');
  await q(`UPDATE items SET purchase_stage = CASE WHEN id = $1 THEN 'preferred' ELSE CASE WHEN purchase_stage = 'preferred' THEN 'suggested' ELSE purchase_stage END END, updated_at = now()
            WHERE comparison_group_id = $2 AND workspace_id = $3`, [row.id, row.comparison_group_id, row.workspace_id]);
  await logActivity(row.workspace_id, 'item', row.id, a.user.id, 'preferred', 'Marked as preferred option');
  return c.json({ ok: true });
});

itemRoutes.post('/link-preview', async (c) => {
  requireAuth(c);
  const b = parse(z.object({ url: z.string().url().max(2000) }), await c.req.json());
  return c.json(await fetchLinkPreview(b.url));
});
