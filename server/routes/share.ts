import { Hono } from 'hono';
import { z } from 'zod';
import { q, q1 } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { loadEntity, type AppEnv, type Auth } from '../lib/access.js';
import { badRequest, notFound, parse, uuid } from '../lib/http.js';
import { logActivity, notify } from '../lib/notify.js';
import { getStorage } from '../lib/storage.js';
import { serializeItems } from './items.js';

/**
 * Sharing between a personal space (ME) and the household space (US).
 * Default is COPY: the private original stays untouched in ME and the US copy
 * records its provenance (origin id, owner, shared_at). MOVE is explicit.
 */
export const shareRoutes = new Hono<AppEnv>();

const TYPE = z.enum(['item', 'task', 'event']);
const TABLE = { item: 'items', task: 'tasks', event: 'events' } as const;
const ORIGIN = { item: 'origin_item_id', task: 'origin_task_id', event: 'origin_event_id' } as const;

const ITEM_COPY_COLS = [
  'module', 'grocery_state', 'title', 'notes', 'idea_type', 'priority', 'decision_status', 'purchase_stage', 'quantity', 'unit', 'assigned_to',
  'intended_for_user_id', 'intended_for_name', 'link_url', 'link_title', 'link_image_url', 'link_site_name', 'price_cents', 'currency', 'room',
  'dimensions', 'color_material', 'store', 'target_date', 'purchased_on', 'expires_on', 'storage_location',
];
const TASK_COPY_COLS = [
  'title', 'description', 'kind', 'due_date', 'due_time', 'priority', 'assignee', 'assigned_user_id', 'status', 'reminder_at',
  'recurrence_unit', 'recurrence_interval',
];
const EVENT_COPY_COLS = [
  'title', 'description', 'location', 'notes', 'category', 'all_day', 'time_unspecified', 'start_date', 'end_date', 'starts_at', 'ends_at',
  'participants', 'availability_only', 'for_user_id', 'source_type', 'google_connection_id', 'google_calendar_id', 'google_calendar_name',
  'google_event_id', 'google_recurring_event_id', 'google_recurrence', 'source_snapshot', 'source_updated_at', 'imported_at', 'imported_by',
];

async function loadPersonalSources(a: Auth, type: z.infer<typeof TYPE>, ids: string[]) {
  const rows = await q<any>(`SELECT * FROM ${TABLE[type]} WHERE id = ANY($1::uuid[]) AND workspace_id = $2 AND archived_at IS NULL`, [ids, a.personalWorkspaceId]);
  if (rows.length !== new Set(ids).size) throw notFound('Some of these items are not in your private space');
  return rows;
}

async function findDuplicate(a: Auth, type: z.infer<typeof TYPE>, src: any) {
  const already = await q1<any>(`SELECT id, title FROM ${TABLE[type]} WHERE ${ORIGIN[type]} = $1 AND workspace_id = $2 AND archived_at IS NULL`, [src.id, a.sharedWorkspaceId]);
  if (already) return { id: already.id, title: already.title, reason: 'already_shared' as const };
  let similar: any = null;
  if (type === 'item') {
    similar = await q1(
      `SELECT id, title FROM items WHERE workspace_id = $1 AND module = $2 AND grocery_state IS NOT DISTINCT FROM $3 AND lower(trim(title)) = lower(trim($4)) AND archived_at IS NULL LIMIT 1`,
      [a.sharedWorkspaceId, src.module, src.grocery_state, src.title],
    );
  } else if (type === 'task') {
    similar = await q1(`SELECT id, title FROM tasks WHERE workspace_id = $1 AND lower(trim(title)) = lower(trim($2)) AND status NOT IN ('completed','archived') AND archived_at IS NULL LIMIT 1`, [a.sharedWorkspaceId, src.title]);
  } else {
    similar = await q1(`SELECT id, title FROM events WHERE workspace_id = $1 AND lower(trim(title)) = lower(trim($2)) AND start_date = $3 AND archived_at IS NULL LIMIT 1`, [a.sharedWorkspaceId, src.title, src.start_date]);
  }
  return similar ? { id: similar.id, title: similar.title, reason: 'similar_exists' as const } : null;
}

shareRoutes.post('/share/preview', async (c) => {
  const a = requireAuth(c);
  const b = parse(z.object({ type: TYPE, ids: z.array(uuid).max(500).optional(), list_id: uuid.optional() }), await c.req.json());
  let ids = b.ids ?? [];
  if (b.list_id) {
    if (b.type !== 'item') throw badRequest('Only item lists can be shared as a whole');
    const list = await q1<any>('SELECT * FROM lists WHERE id = $1 AND workspace_id = $2', [b.list_id, a.personalWorkspaceId]);
    if (!list) throw notFound();
    ids = (await q<{ id: string }>('SELECT id FROM items WHERE list_id = $1 AND archived_at IS NULL ORDER BY created_at', [list.id])).map((r) => r.id);
  }
  if (!ids.length) return c.json({ entries: [], target_lists: [] });
  const rows = await loadPersonalSources(a, b.type, ids);
  const entries = [];
  for (const r of rows) {
    const duplicate = await findDuplicate(a, b.type, r);
    entries.push({
      id: r.id, title: r.title, module: r.module ?? null, grocery_state: r.grocery_state ?? null, quantity: r.quantity ?? null, notes: r.notes ?? r.description ?? '',
      start_date: r.start_date ?? null, due_date: r.due_date ?? null, duplicate, selected: duplicate?.reason !== 'already_shared',
    });
  }
  const modules = [...new Set(rows.map((r) => r.module).filter(Boolean))];
  const target_lists = modules.length
    ? await q('SELECT id, name, module, is_default FROM lists WHERE workspace_id = $1 AND module = ANY($2::text[]) AND archived_at IS NULL ORDER BY is_default DESC, name', [a.sharedWorkspaceId, modules])
    : [];
  return c.json({ entries, target_lists });
});

async function remapCategory(a: Auth, categoryId: string | null) {
  if (!categoryId) return null;
  const cat = await q1<any>('SELECT * FROM categories WHERE id = $1 AND workspace_id = $2', [categoryId, a.personalWorkspaceId]);
  if (!cat) return null;
  const row = await q1<{ id: string }>(
    `INSERT INTO categories (workspace_id, module, group_name, name, color) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (workspace_id, module, lower(name)) DO UPDATE SET name = categories.name RETURNING id`,
    [a.sharedWorkspaceId, cat.module, cat.group_name, cat.name, cat.color],
  );
  return row!.id;
}

async function copyTags(fromItem: string, toItem: string, toWorkspace: string) {
  const tags = await q<{ name: string }>('SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = $1', [fromItem]);
  if (!tags.length) return;
  await q('DELETE FROM item_tags WHERE item_id = $1', [toItem]);
  for (const t of tags) {
    const tag = await q1<{ id: string }>(
      `INSERT INTO tags (workspace_id, name) VALUES ($1,$2) ON CONFLICT (workspace_id, lower(name)) DO UPDATE SET name = tags.name RETURNING id`, [toWorkspace, t.name],
    );
    await q('INSERT INTO item_tags (item_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [toItem, tag!.id]);
  }
}

/** Duplicate attachments into the target workspace so the copy is independent of the original. */
async function copyAttachments(type: string, fromId: string, toId: string, toWorkspace: string, userId: string) {
  const atts = await q<any>('SELECT * FROM attachments WHERE entity_type = $1 AND entity_id = $2', [type, fromId]);
  const storage = getStorage();
  for (const att of atts) {
    const data = await storage.get(att.blob_key);
    if (!data) continue;
    const key = `ws/${toWorkspace}/${crypto.randomUUID()}`;
    await storage.put(key, data, att.content_type);
    await q(
      `INSERT INTO attachments (workspace_id, entity_type, entity_id, blob_key, filename, content_type, size_bytes, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [toWorkspace, type, toId, key, att.filename, att.content_type, att.size_bytes, userId],
    );
  }
}

shareRoutes.post('/share', async (c) => {
  const a = requireAuth(c);
  const b = parse(
    z.object({
      type: TYPE,
      ids: z.array(uuid).min(1).max(500),
      mode: z.enum(['copy', 'move']).default('copy'),
      target_list_id: uuid.optional(),
      edits: z.record(z.string(), z.object({
        title: z.string().trim().min(1).max(200).optional(),
        quantity: z.number().min(0).max(1e6).nullish(),
        notes: z.string().max(5000).optional(),
      })).optional(),
      allow_duplicates: z.boolean().default(false),
    }),
    await c.req.json(),
  );
  const rows = await loadPersonalSources(a, b.type, b.ids);
  const created: any[] = [];
  const skipped: { id: string; title: string; reason: string }[] = [];
  const table = TABLE[b.type];
  const now = new Date();

  for (const src of rows) {
    const dup = await findDuplicate(a, b.type, src);
    if (dup?.reason === 'already_shared' || (dup && !b.allow_duplicates)) {
      skipped.push({ id: src.id, title: src.title, reason: dup.reason });
      continue;
    }
    const edit = b.edits?.[src.id] ?? {};
    let targetList: string | null = null;
    if (b.type === 'item') {
      const list = b.target_list_id
        ? await q1<any>('SELECT id FROM lists WHERE id = $1 AND workspace_id = $2 AND module = $3 AND archived_at IS NULL', [b.target_list_id, a.sharedWorkspaceId, src.module])
        : await q1<any>('SELECT id FROM lists WHERE workspace_id = $1 AND module = $2 AND is_default', [a.sharedWorkspaceId, src.module]);
      if (!list) throw badRequest('Unknown target list in US');
      targetList = list.id;
    }

    if (b.mode === 'move') {
      const sets: string[] = ['workspace_id = $2', 'shared_at = $3', 'shared_by = $4', 'origin_owner_id = COALESCE(origin_owner_id, $4)', 'updated_at = $3', 'updated_by = $4'];
      const params: unknown[] = [src.id, a.sharedWorkspaceId, now, a.user.id];
      if (b.type === 'item') {
        params.push(targetList, await remapCategory(a, src.category_id));
        sets.push(`list_id = $${params.length - 1}`, `category_id = $${params.length}`);
      }
      if (edit.title) { params.push(edit.title); sets.push(`title = $${params.length}`); }
      if (edit.quantity !== undefined && b.type === 'item') { params.push(edit.quantity); sets.push(`quantity = $${params.length}`); }
      if (edit.notes !== undefined) { params.push(edit.notes); sets.push(`${b.type === 'item' ? 'notes' : 'description'} = $${params.length}`); }
      const moved = await q1<any>(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
      if (b.type === 'item') {
        const tags = await q<{ name: string }>('SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = $1', [src.id]);
        await q('DELETE FROM item_tags WHERE item_id = $1', [src.id]);
        for (const t of tags) {
          const tag = await q1<{ id: string }>(`INSERT INTO tags (workspace_id, name) VALUES ($1,$2) ON CONFLICT (workspace_id, lower(name)) DO UPDATE SET name = tags.name RETURNING id`, [a.sharedWorkspaceId, t.name]);
          await q('INSERT INTO item_tags (item_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [src.id, tag!.id]);
        }
      }
      await q('UPDATE attachments SET workspace_id = $1 WHERE entity_type = $2 AND entity_id = $3', [a.sharedWorkspaceId, b.type, src.id]);
      await q('UPDATE threads SET workspace_id = $1 WHERE entity_type = $2 AND entity_id = $3', [a.sharedWorkspaceId, b.type, src.id]);
      await q('UPDATE reactions SET workspace_id = $1 WHERE entity_type = $2 AND entity_id = $3', [a.sharedWorkspaceId, b.type, src.id]);
      await logActivity(a.sharedWorkspaceId, b.type, src.id, a.user.id, 'shared', `Moved from ${a.user.display_name}'s private space to US`);
      created.push(moved);
      continue;
    }

    // COPY
    const cols = b.type === 'item' ? ITEM_COPY_COLS : b.type === 'task' ? TASK_COPY_COLS : EVENT_COPY_COLS;
    const values: Record<string, unknown> = Object.fromEntries(cols.map((k) => [k, src[k]]));
    if (edit.title) values.title = edit.title;
    if (edit.quantity !== undefined && b.type === 'item') values.quantity = edit.quantity;
    if (edit.notes !== undefined) values[b.type === 'item' ? 'notes' : 'description'] = edit.notes;
    if (b.type === 'item') {
      values.list_id = targetList;
      values.category_id = await remapCategory(a, src.category_id);
    }
    if (b.type === 'event' && values.source_snapshot) values.source_snapshot = JSON.stringify(values.source_snapshot);
    values[ORIGIN[b.type]] = src.id;
    Object.assign(values, {
      workspace_id: a.sharedWorkspaceId, origin_owner_id: src.origin_owner_id ?? src.created_by ?? a.user.id, shared_at: now, shared_by: a.user.id,
      created_by: src.created_by ?? a.user.id, updated_by: a.user.id, created_at: now, updated_at: now,
    });
    const keys = Object.keys(values);
    const copy = await q1<any>(
      `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      keys.map((k) => values[k]),
    );
    if (b.type === 'item') await copyTags(src.id, copy.id, a.sharedWorkspaceId);
    await copyAttachments(b.type, src.id, copy.id, a.sharedWorkspaceId, a.user.id);
    await logActivity(a.sharedWorkspaceId, b.type, copy.id, a.user.id, 'shared', `Shared from ${a.user.display_name}'s private space`);
    created.push(copy);
  }

  if (created.length && a.partner) {
    const title = created.length === 1
      ? `${a.user.display_name} shared “${created[0].title}” with US`
      : `${a.user.display_name} shared ${created.length} ${b.type === 'item' ? 'items' : b.type === 'task' ? 'tasks' : 'events'} with US`;
    await notify({
      recipients: [a.partner.id], actorId: a.user.id, workspaceId: a.sharedWorkspaceId, type: 'shared', title,
      entityType: created.length === 1 ? b.type : undefined, entityId: created.length === 1 ? created[0].id : undefined,
    });
  }
  const serialized = b.type === 'item' ? await serializeItems(a, created) : created;
  return c.json({ created: serialized, skipped });
});

/** "Remove from US": archive the shared copy (recoverable). Accepts either the private original or the US copy. */
shareRoutes.post('/share/remove', async (c) => {
  const a = requireAuth(c);
  const b = parse(z.object({ type: TYPE, id: uuid }), await c.req.json());
  const row = await loadEntity<any>(a, b.type, b.id);
  let targetId = row.id;
  if (row.workspace_id === a.personalWorkspaceId) {
    const copy = await q1<any>(`SELECT id FROM ${TABLE[b.type]} WHERE ${ORIGIN[b.type]} = $1 AND workspace_id = $2 AND archived_at IS NULL`, [row.id, a.sharedWorkspaceId]);
    if (!copy) throw badRequest('This item is not shared with US');
    targetId = copy.id;
  }
  await q(`UPDATE ${TABLE[b.type]} SET archived_at = now(), updated_at = now(), updated_by = $2 WHERE id = $1 AND workspace_id = $3`, [targetId, a.user.id, a.sharedWorkspaceId]);
  await logActivity(a.sharedWorkspaceId, b.type, targetId, a.user.id, 'unshared', 'Removed from US (archived)');
  return c.json({ ok: true, archived_id: targetId });
});
