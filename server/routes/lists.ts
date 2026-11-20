import { Hono } from 'hono';
import { z } from 'zod';
import { q, q1, tx } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { accessibleWorkspaceIds, loadEntity, type AppEnv, type Auth } from '../lib/access.js';
import { badRequest, forbidden, HttpError, notFound, parse, priority, uuid } from '../lib/http.js';
import { getStorage } from '../lib/storage.js';
import { logActivity } from '../lib/notify.js';
import { ANY_MODULE, createItemBody, insertItem, loadCustomList, MODULE, serializeItems } from './items.js';

/**
 * The three lists (Groceries, Home & Gadgets, Shopping & Other) as one view
 * across the user's two workspaces: everything in US, plus the user's own
 * locked (private) items. The partner's private items are never queried.
 */
export const listRoutes = new Hono<AppEnv>();

const SORTS: Record<string, string> = {
  category: 'lower(COALESCE(c.name, \'~\')), lower(i.title)',
  priority: `i.urgent DESC, array_position(ARRAY['urgent','high','normal','low'], i.priority), lower(i.title)`,
  recent: 'i.updated_at DESC',
  due: 'i.due_date NULLS LAST, i.due_time NULLS LAST, lower(i.title)',
  title: 'lower(i.title)',
};

listRoutes.get('/modules/:module/items', async (c) => {
  const a = requireAuth(c);
  const module = parse(ANY_MODULE, c.req.param('module'));
  const f = parse(
    z.object({
      list: uuid.optional(),
      state: z.enum(['need', 'stock']).optional(),
      q: z.string().max(100).optional(),
      category: z.string().max(60).optional(),
      priority: priority.optional(),
      flagged: z.enum(['true']).optional(),
      dated: z.enum(['true']).optional(),
      urgent: z.enum(['true']).optional(),
      added_by: uuid.optional(),
      privacy: z.enum(['private', 'shared']).optional(),
      sort: z.enum(Object.keys(SORTS) as [string, ...string[]]).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }),
    c.req.query(),
  );
  const wss = f.privacy === 'private' ? [a.personalWorkspaceId] : f.privacy === 'shared' ? [a.sharedWorkspaceId] : accessibleWorkspaceIds(a);
  // A list the household made is chosen by id; the built-in ones by module.
  const listId = module === 'custom' ? (await loadCustomList(a, f.list ?? '')).id : null;
  const rows = await q(
    `SELECT i.* FROM items i LEFT JOIN categories c ON c.id = i.category_id
      WHERE i.workspace_id = ANY($1::uuid[]) AND i.module = $2 AND i.archived_at IS NULL
        AND ($3::text IS NULL OR i.grocery_state = $3)
        AND ($4::text IS NULL OR i.title ILIKE '%' || $4 || '%' OR i.notes ILIKE '%' || $4 || '%' OR c.name ILIKE '%' || $4 || '%'
             OR EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = i.id AND t.name ILIKE '%' || $4 || '%'))
        AND ($5::text IS NULL OR lower(c.name) = lower($5))
        AND ($6::text IS NULL OR i.priority = $6)
        AND (NOT $7 OR i.flagged)
        AND (NOT $8 OR i.due_date IS NOT NULL)
        AND (NOT $9 OR i.urgent)
        AND ($10::uuid IS NULL OR i.created_by = $10)
        AND ($12::uuid IS NULL OR i.list_id = $12)
      ORDER BY ${SORTS[f.sort ?? 'category']}
      LIMIT $11`,
    [wss, module, f.state ?? null, f.q?.trim() || null, f.category ?? null, f.priority ?? null, f.flagged === 'true', f.dated === 'true',
      f.urgent === 'true', f.added_by ?? null, f.limit ?? 500, listId],
  );
  const counts = await q1<{ need: number; stock: number }>(
    `SELECT count(*) FILTER (WHERE grocery_state = 'need')::int AS need, count(*) FILTER (WHERE grocery_state = 'stock')::int AS stock
       FROM items WHERE workspace_id = ANY($1::uuid[]) AND module = $2 AND archived_at IS NULL AND ($3::uuid IS NULL OR list_id = $3)`,
    [accessibleWorkspaceIds(a), module, listId],
  );
  return c.json({ items: await serializeItems(a, rows), counts });
});

/** Add an item. Shared (US) unless `private` is true. */
listRoutes.post('/modules/:module/items', async (c) => {
  const a = requireAuth(c);
  const module = parse(ANY_MODULE, c.req.param('module'));
  const raw = await c.req.json();
  const b = parse(createItemBody.omit({ module: true }).extend({ private: z.boolean().optional() }), raw);
  const { private: isPrivate, ...rest } = b;
  return c.json({ item: await insertItem(a, isPrivate ? 'me' : 'us', { ...rest, module }) }, 201);
});

/** Categories for a list: the shared set, plus any the user created only privately. */
listRoutes.get('/modules/:module/categories', async (c) => {
  const a = requireAuth(c);
  const module = parse(MODULE, c.req.param('module'));
  const rows = await q<any>(
    `SELECT DISTINCT ON (lower(name)) id, name, color, group_name, sort_order, workspace_id FROM categories
      WHERE workspace_id = ANY($1::uuid[]) AND module = $2
      ORDER BY lower(name), (workspace_id = $3) DESC`,
    [accessibleWorkspaceIds(a), module, a.sharedWorkspaceId],
  );
  rows.sort((x, y) => x.sort_order - y.sort_order || x.name.localeCompare(y.name));
  return c.json({ categories: rows.map(({ workspace_id, ...r }) => r) });
});

listRoutes.post('/modules/:module/categories', async (c) => {
  const a = requireAuth(c);
  const module = parse(MODULE, c.req.param('module'));
  const b = parse(z.object({ name: z.string().trim().min(1).max(60), color: z.string().regex(/^#[0-9a-f]{6}$/i).optional() }), await c.req.json());
  const row = await q1(
    `INSERT INTO categories (workspace_id, module, name, color) VALUES ($1,$2,$3,COALESCE($4,'#8a8178'))
     ON CONFLICT (workspace_id, module, lower(name)) WHERE list_id IS NULL DO UPDATE SET name = categories.name RETURNING id, name, color, group_name, sort_order`,
    [a.sharedWorkspaceId, module, b.name, b.color ?? null],
  );
  return c.json({ category: row }, 201);
});

/**
 * Lock (make private) or unlock (share) an item. Only the person who added it
 * may do this. The item moves between workspaces together with its
 * conversation, photos, subtasks, reactions and history, so nothing about a
 * locked item stays visible to the partner.
 */
listRoutes.post('/items/:id/privacy', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'item', c.req.param('id'));
  const b = parse(z.object({ private: z.boolean() }), await c.req.json());
  if (row.created_by !== a.user.id) throw forbidden('Only the person who added this can lock or unlock it');
  const target = b.private ? a.personalWorkspaceId : a.sharedWorkspaceId;
  if (row.workspace_id === target) return c.json({ item: (await serializeItems(a, [row]))[0] });
  const moved = await moveItem(a, row, target);
  await logActivity(target, 'item', row.id, a.user.id, b.private ? 'locked' : 'unlocked', b.private ? 'Made private' : 'Shared with both of you');
  return c.json({ item: (await serializeItems(a, [moved]))[0] });
});

async function moveItem(a: Auth, row: any, target: string) {
  const from = row.workspace_id;
  const partnerId = a.partner?.id ?? null;
  return tx(async (db) => {
    let list: any;
    let categoryId: string | null = null;
    if (row.module === 'custom') {
      // A household-made list is shared by both spaces: a locked item stays in its list, only hidden from the partner.
      list = (await db.query<any>('SELECT id, workspace_id FROM lists WHERE id = $1', [row.list_id])).rows[0];
      if (target === a.sharedWorkspaceId && list.workspace_id === a.personalWorkspaceId) throw badRequest('This list is private, so what is in it stays private.');
      categoryId = row.category_id;
    } else {
      list = (await db.query<any>('SELECT id FROM lists WHERE workspace_id = $1 AND module = $2 AND is_default', [target, row.module])).rows[0];
    }
    if (!list) throw badRequest('Unknown list');
    if (row.category_id && row.module !== 'custom') {
      const cat = (await db.query<any>('SELECT * FROM categories WHERE id = $1', [row.category_id])).rows[0];
      if (cat) {
        categoryId = (await db.query<any>(
          `INSERT INTO categories (workspace_id, module, group_name, name, color, sort_order) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (workspace_id, module, lower(name)) WHERE list_id IS NULL DO UPDATE SET name = categories.name RETURNING id`,
          [target, row.module, cat.group_name, cat.name, cat.color, cat.sort_order],
        )).rows[0].id;
      }
    }
    const tagNames = (await db.query<any>('SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = $1', [row.id])).rows.map((t) => t.name);
    await db.query('DELETE FROM item_tags WHERE item_id = $1', [row.id]);
    for (const name of tagNames) {
      const tag = (await db.query<any>(
        'INSERT INTO tags (workspace_id, name) VALUES ($1,$2) ON CONFLICT (workspace_id, lower(name)) DO UPDATE SET name = tags.name RETURNING id',
        [target, name],
      )).rows[0];
      await db.query('INSERT INTO item_tags (item_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [row.id, tag.id]);
    }
    const updated = (await db.query<any>(
      `UPDATE items SET workspace_id = $2, list_id = $3, category_id = $4, comparison_group_id = NULL, assigned_to = CASE WHEN $5 THEN NULL ELSE assigned_to END,
         updated_at = now(), updated_by = $6
       WHERE id = $1 RETURNING *`,
      [row.id, target, list.id, categoryId, target === a.personalWorkspaceId, a.user.id],
    )).rows[0];
    const thread = (await db.query<any>(`SELECT id FROM threads WHERE entity_type = 'item' AND entity_id = $1`, [row.id])).rows[0];
    if (thread) {
      await db.query('UPDATE threads SET workspace_id = $2 WHERE id = $1', [thread.id, target]);
      await db.query(`UPDATE attachments SET workspace_id = $2 WHERE entity_type = 'message' AND entity_id IN (SELECT id FROM messages WHERE thread_id = $1)`, [thread.id, target]);
    }
    await db.query(`UPDATE attachments SET workspace_id = $2 WHERE entity_type = 'item' AND entity_id = $1`, [row.id, target]);
    await db.query(`UPDATE reactions SET workspace_id = $2 WHERE entity_type = 'item' AND entity_id = $1`, [row.id, target]);
    await db.query(`UPDATE activity SET workspace_id = $2 WHERE entity_type = 'item' AND entity_id = $1 AND workspace_id = $3`, [row.id, target, from]);
    await db.query('UPDATE subtasks SET workspace_id = $2 WHERE item_id = $1', [row.id, target]);
    if (target === a.personalWorkspaceId && partnerId) {
      // Nothing about a now-private item may linger for the partner.
      await db.query(`DELETE FROM notifications WHERE user_id = $1 AND entity_type = 'item' AND entity_id = $2`, [partnerId, row.id]);
      await db.query(`DELETE FROM favorites WHERE user_id = $1 AND entity_type = 'item' AND entity_id = $2`, [partnerId, row.id]);
      await db.query(`DELETE FROM recently_viewed WHERE user_id = $1 AND entity_type = 'item' AND entity_id = $2`, [partnerId, row.id]);
      await db.query(`DELETE FROM reactions WHERE user_id = $1 AND entity_type = 'item' AND entity_id = $2`, [partnerId, row.id]);
    }
    return updated;
  });
}

// ---------------------------------------------------------------- subtasks
async function loadSubtask(a: Auth, id: string) {
  const s = await q1<any>('SELECT * FROM subtasks WHERE id = $1 AND workspace_id = ANY($2::uuid[])', [parse(uuid, id), accessibleWorkspaceIds(a)]);
  if (!s) throw notFound();
  return s;
}

listRoutes.post('/items/:id/subtasks', async (c) => {
  const a = requireAuth(c);
  const item = await loadEntity<any>(a, 'item', c.req.param('id'));
  const b = parse(z.object({ title: z.string().trim().min(1).max(200) }), await c.req.json());
  const pos = await q1<{ n: number }>('SELECT COALESCE(max(position), -1)::int + 1 AS n FROM subtasks WHERE item_id = $1', [item.id]);
  const row = await q1('INSERT INTO subtasks (item_id, workspace_id, title, position, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, title, done, position', [
    item.id, item.workspace_id, b.title, pos!.n, a.user.id,
  ]);
  return c.json({ subtask: row }, 201);
});

listRoutes.patch('/subtasks/:id', async (c) => {
  const a = requireAuth(c);
  const s = await loadSubtask(a, c.req.param('id'));
  const b = parse(z.object({ title: z.string().trim().min(1).max(200).optional(), done: z.boolean().optional() }), await c.req.json());
  const row = await q1('UPDATE subtasks SET title = COALESCE($2, title), done = COALESCE($3, done) WHERE id = $1 RETURNING id, title, done, position', [
    s.id, b.title ?? null, b.done ?? null,
  ]);
  return c.json({ subtask: row });
});

listRoutes.delete('/subtasks/:id', async (c) => {
  const a = requireAuth(c);
  const s = await loadSubtask(a, c.req.param('id'));
  await q('DELETE FROM subtasks WHERE id = $1', [s.id]);
  return c.json({ ok: true });
});

// ------------------------------------------------------------ custom lists
const LIST_COLORS = /^#[0-9a-f]{6}$/i;

/**
 * Lists in the sidebar and on the dashboard: the three built-in ones plus the
 * lists the household made. Lists that belong to a plan are not included.
 */
listRoutes.get('/lists/nav', async (c) => {
  const a = requireAuth(c);
  const wss = accessibleWorkspaceIds(a);
  const [builtin, custom] = await Promise.all([
    q<any>(`SELECT id, module, emoji, color FROM lists WHERE workspace_id = $1 AND is_default AND module <> 'custom'`, [a.sharedWorkspaceId]),
    q<any>(
      `SELECT l.id, l.name, l.emoji, l.color, l.workspace_id, l.created_by, l.created_at,
              (SELECT count(*)::int FROM items i WHERE i.list_id = l.id AND i.archived_at IS NULL AND i.grocery_state = 'need' AND i.workspace_id = ANY($1::uuid[])) AS need
         FROM lists l WHERE l.workspace_id = ANY($1::uuid[]) AND l.module = 'custom' AND l.event_id IS NULL AND l.archived_at IS NULL
        ORDER BY l.position, l.created_at`,
      [wss],
    ),
  ]);
  return c.json({
    builtin: Object.fromEntries(builtin.map((b) => [b.module, b.id])),
    builtin_style: Object.fromEntries(builtin.map((b) => [b.module, { emoji: b.emoji, color: b.color }])),
    custom: custom.map(({ workspace_id, ...l }) => ({ ...l, private: workspace_id === a.personalWorkspaceId })),
  });
});

const newListBody = z.object({
  name: z.string().trim().min(1).max(80),
  emoji: z.string().trim().min(1).max(16).optional(),
  color: z.string().regex(LIST_COLORS).optional(),
  private: z.boolean().optional(),
  event_id: uuid.optional(),
  sections: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
});

/** Make a new list. Shared unless private; a plan's list lives where the plan lives. */
listRoutes.post('/lists', async (c) => {
  const a = requireAuth(c);
  const b = parse(newListBody, await c.req.json());
  let ws = b.private ? a.personalWorkspaceId : a.sharedWorkspaceId;
  if (b.event_id) {
    ws = (await loadEntity<any>(a, 'event', b.event_id)).workspace_id;
    await q('UPDATE events SET is_plan = true WHERE id = $1 AND NOT is_plan', [b.event_id]);
  }
  const list = await q1<any>(
    `INSERT INTO lists (workspace_id, module, name, emoji, color, event_id, created_by, position)
     VALUES ($1,'custom',$2,$3,$4,$5,$6, (SELECT COALESCE(max(position), 100) + 1 FROM lists WHERE workspace_id = $1 AND module = 'custom'))
     RETURNING *`,
    [ws, b.name, b.emoji ?? null, b.color ?? null, b.event_id ?? null, a.user.id],
  );
  let i = 0;
  for (const name of [...new Set(b.sections ?? [])]) {
    await q(`INSERT INTO categories (workspace_id, module, list_id, name, sort_order) VALUES ($1,'custom',$2,$3,$4) ON CONFLICT DO NOTHING`, [ws, list.id, name, i++]);
  }
  await logActivity(ws, 'list', list.id, a.user.id, 'created', `Made the list “${list.name}”`);
  return c.json({ list: { ...list, private: ws === a.personalWorkspaceId } }, 201);
});

/** One custom list (for its page header). */
listRoutes.get('/lists/:id', async (c) => {
  const a = requireAuth(c);
  const list = await q1<any>(`SELECT * FROM lists WHERE id = $1 AND module = 'custom' AND workspace_id = ANY($2::uuid[])`, [parse(uuid, c.req.param('id')), accessibleWorkspaceIds(a)]);
  if (!list) throw notFound();
  const plan = list.event_id ? await q1<any>('SELECT id, title FROM events WHERE id = $1', [list.event_id]) : null;
  return c.json({ list: { ...list, private: list.workspace_id === a.personalWorkspaceId, plan } });
});

listRoutes.get('/lists/:id/sections', async (c) => {
  const a = requireAuth(c);
  const list = await loadCustomList(a, c.req.param('id'));
  const rows = await q('SELECT id, name, color, group_name, sort_order FROM categories WHERE list_id = $1 ORDER BY sort_order, lower(name)', [list.id]);
  return c.json({ categories: rows });
});

listRoutes.post('/lists/:id/sections', async (c) => {
  const a = requireAuth(c);
  const list = await loadCustomList(a, c.req.param('id'));
  const b = parse(z.object({ name: z.string().trim().min(1).max(60) }), await c.req.json());
  const row = await q1(
    `INSERT INTO categories (workspace_id, module, list_id, name, sort_order)
     VALUES ($1,'custom',$2,$3,(SELECT COALESCE(max(sort_order), -1) + 1 FROM categories WHERE list_id = $2))
     ON CONFLICT (list_id, lower(name)) WHERE list_id IS NOT NULL DO UPDATE SET name = categories.name RETURNING id, name, color, group_name, sort_order`,
    [list.workspace_id, list.id, b.name],
  );
  return c.json({ category: row }, 201);
});

/**
 * Permanently delete an archived custom list and everything in it (items,
 * their conversations and photos). Shared lists need an explicit confirmation.
 */
listRoutes.delete('/lists/:id', async (c) => {
  const a = requireAuth(c);
  const list = await q1<any>(`SELECT * FROM lists WHERE id = $1 AND module = 'custom' AND workspace_id = ANY($2::uuid[])`, [parse(uuid, c.req.param('id')), accessibleWorkspaceIds(a)]);
  if (!list) throw notFound();
  if (!list.archived_at) throw badRequest('Archive this list first. Archived lists can be restored; deletion is permanent.');
  if (list.workspace_id === a.sharedWorkspaceId && c.req.query('confirm') !== 'permanent') {
    throw new HttpError(428, 'confirmation_required', 'Deleting a shared list deletes everything in it for both of you. Confirm to continue.');
  }
  const items = (await q<{ id: string }>('SELECT id FROM items WHERE list_id = $1', [list.id])).map((r) => r.id);
  const atts = await q<{ id: string; blob_key: string }>(
    `SELECT id, blob_key FROM attachments
      WHERE (entity_type = 'item' AND entity_id = ANY($1::uuid[]))
         OR (entity_type = 'message' AND entity_id IN (SELECT m.id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.entity_type = 'item' AND t.entity_id = ANY($1::uuid[])))`,
    [items],
  );
  for (const att of atts) await getStorage().delete(att.blob_key);
  await tx(async (db) => {
    await db.query('DELETE FROM attachments WHERE id = ANY($1::uuid[])', [atts.map((x) => x.id)]);
    for (const t of ['threads', 'reactions', 'favorites', 'recently_viewed', 'notifications']) {
      await db.query(`DELETE FROM ${t} WHERE entity_type = 'item' AND entity_id = ANY($1::uuid[])`, [items]);
    }
    await db.query('DELETE FROM lists WHERE id = $1', [list.id]);
  });
  await logActivity(list.workspace_id, 'list', list.id, a.user.id, 'deleted', `Permanently deleted the list “${list.name}”`);
  return c.json({ ok: true });
});
