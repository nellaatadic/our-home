import { Hono } from 'hono';
import { z } from 'zod';
import { q, q1, tx } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { accessibleWorkspaceIds, loadEntity, type AppEnv, type Auth } from '../lib/access.js';
import { badRequest, conflict, forbidden, httpUrl, optUrl, parse, uuid } from '../lib/http.js';
import { decorate } from '../lib/serialize.js';
import { logActivity } from '../lib/notify.js';
import { fetchLinkPreview } from '../lib/linkpreview.js';
import { insertItem, serializeItems } from './items.js';

/**
 * The Board: a wall of sticky notes, photos, links and words. Pins are shared
 * unless locked, like everything else. Positions are in wall units (the wall
 * is 1200 wide and grows downwards); the browser scales them to fit.
 */
export const boardRoutes = new Hono<AppEnv>();

export const WALL_WIDTH = 1200;
const KIND = z.enum(['note', 'photo', 'link', 'text']);
const COLOR = z.enum(['butter', 'blush', 'sage', 'sky', 'lilac', 'paper', 'ink']);
const geometry = {
  x: z.number().int().min(0).max(WALL_WIDTH).optional(),
  y: z.number().int().min(0).max(50000).optional(),
  w: z.number().int().min(120).max(WALL_WIDTH).optional(),
  h: z.number().int().min(80).max(1600).optional(),
  rotation: z.number().min(-8).max(8).optional(),
  z: z.number().int().min(0).max(1_000_000).optional(),
};
const tags = z.array(z.string().trim().min(1).max(40)).max(20).optional();

export async function serializePins(a: Auth, rows: any[]) {
  if (!rows.length) return [];
  const images = await q<any>(
    `SELECT id, entity_id, filename FROM attachments WHERE entity_type = 'pin' AND entity_id = ANY($1::uuid[]) AND content_type LIKE 'image/%' ORDER BY created_at`,
    [rows.map((r) => r.id)],
  );
  const items = await pinItems(a, rows.map((r) => r.item_id).filter(Boolean));
  return (await decorate(a, 'pin', rows)).map((p: any) => ({
    ...p,
    item: p.item_id ? items.get(p.item_id) ?? null : null,
    private: p.workspace_id === a.personalWorkspaceId,
    can_lock: p.created_by === a.user.id,
    images: images.filter((i) => i.entity_id === p.id).map((i) => ({ id: i.id, filename: i.filename, url: `/api/attachments/${i.id}` })),
  }));
}

const LIST_NAMES: Record<string, string> = { grocery: 'Groceries', home: 'Home & Gadgets', idea: 'Shopping & Other' };

/** The item a sticky stands for, summarised: where it lives and the few details that matter. */
async function pinItems(a: Auth, ids: string[]) {
  const out = new Map<string, any>();
  if (!ids.length) return out;
  const rows = await q('SELECT * FROM items WHERE id = ANY($1::uuid[]) AND workspace_id = ANY($2::uuid[])', [ids, accessibleWorkspaceIds(a)]);
  const lists = await q<any>('SELECT id, module, name, emoji, color FROM lists WHERE id = ANY($1::uuid[])', [rows.map((r: any) => r.list_id)]);
  for (const it of await serializeItems(a, rows)) {
    const l = lists.find((x) => x.id === it.list_id);
    out.set(it.id, {
      id: it.id, title: it.title, notes: it.notes, due_date: it.due_date, tags: it.tags, image: it.images[0]?.url ?? null, link_url: it.link_url,
      urgent: it.urgent, state: it.grocery_state, archived: Boolean(it.archived_at), thread: it.thread, quantity: it.quantity, unit: it.unit,
      list: l ? { id: l.id, key: l.module === 'custom' ? l.id : l.module, name: LIST_NAMES[l.module] ?? l.name, emoji: l.emoji, color: l.color, module: l.module } : null,
    });
  }
  return out;
}

/** Items that are not on the Board yet, to pin from the "Add" sheet (groceries stay off the Board). */
boardRoutes.get('/board/candidates', async (c) => {
  const a = requireAuth(c);
  const term = (c.req.query('q') ?? '').trim().slice(0, 80) || null;
  const rows = await q<any>(
    `SELECT i.id, i.title, l.module, l.name, l.emoji FROM items i JOIN lists l ON l.id = i.list_id
      WHERE i.workspace_id = ANY($1::uuid[]) AND i.archived_at IS NULL AND i.module <> 'grocery' AND i.grocery_state = 'need'
        AND NOT EXISTS (SELECT 1 FROM pins p WHERE p.item_id = i.id AND p.archived_at IS NULL)
        AND ($2::text IS NULL OR i.title ILIKE '%' || $2 || '%')
      ORDER BY i.updated_at DESC LIMIT 30`,
    [accessibleWorkspaceIds(a), term],
  );
  return c.json({ items: rows.map((r) => ({ id: r.id, title: r.title, list: LIST_NAMES[r.module] ?? r.name, emoji: r.emoji })) });
});

/** "New sticky 3": the next free number among the pins this person can see. */
async function nextStickyName(a: Auth) {
  const r = await q1<{ n: number }>(
    `SELECT COALESCE(max((substring(title FROM '^New sticky ([0-9]{1,6})$'))::int), 0) + 1 AS n FROM pins WHERE workspace_id = ANY($1::uuid[])`,
    [accessibleWorkspaceIds(a)],
  );
  return `New sticky ${r?.n ?? 1}`;
}

boardRoutes.get('/board', async (c) => {
  const a = requireAuth(c);
  const rows = await q('SELECT * FROM pins WHERE workspace_id = ANY($1::uuid[]) AND archived_at IS NULL ORDER BY z, created_at', [accessibleWorkspaceIds(a)]);
  return c.json({ pins: await serializePins(a, rows), wall_width: WALL_WIDTH });
});

boardRoutes.post('/pins', async (c) => {
  const a = requireAuth(c);
  const b = parse(
    z.object({
      kind: KIND.optional(), title: z.string().trim().max(120).optional(), body: z.string().max(5000).optional(), color: COLOR.optional(),
      link_url: optUrl, preview: z.boolean().optional(), private: z.boolean().optional(), tags, item_id: uuid.optional(), ...geometry,
    }),
    await c.req.json(),
  );
  // A sticky for an item lives where the item lives (private items make private stickies).
  let item: any = null;
  if (b.item_id) {
    item = await loadEntity<any>(a, 'item', b.item_id);
    if (await q1(`SELECT 1 FROM pins WHERE item_id = $1 AND archived_at IS NULL`, [item.id])) throw conflict('That item is already on the Board');
    b.title = b.title || item.title;
    b.private = item.workspace_id === a.personalWorkspaceId;
  }
  const kind = b.kind ?? (b.link_url ? 'link' : 'note');
  if (kind === 'link' && !b.link_url) throw badRequest('Add the link');
  const ws = b.private ? a.personalWorkspaceId : a.sharedWorkspaceId;
  let preview: any = null;
  if (b.link_url && b.preview !== false) {
    const p = await fetchLinkPreview(b.link_url);
    if (p.ok) preview = p;
  }
  const title = b.title?.trim() || (kind === 'link' && preview?.title ? String(preview.title).slice(0, 120) : await nextStickyName(a));
  const top = await q1<{ z: number; y: number }>('SELECT COALESCE(max(z), 0) + 1 AS z, COALESCE(max(y + h), 0) AS y FROM pins WHERE workspace_id = ANY($1::uuid[]) AND archived_at IS NULL', [accessibleWorkspaceIds(a)]);
  const w = b.w ?? (kind === 'text' ? 360 : kind === 'photo' ? 300 : 240);
  const h = b.h ?? (kind === 'text' ? 170 : kind === 'photo' ? 320 : kind === 'link' ? 260 : 220);
  const row = await q1<any>(
    `INSERT INTO pins (workspace_id, kind, title, body, color, link_url, link_title, link_image_url, link_site_name, x, y, w, h, rotation, z, tags, created_by, updated_by, item_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,$18) RETURNING *`,
    [
      ws, kind, title, b.body ?? '', b.color ?? (kind === 'text' ? 'paper' : 'butter'), b.link_url ?? null, preview?.title ?? null, preview?.image_url ?? null,
      preview?.site_name ?? null, Math.min(b.x ?? 40, WALL_WIDTH - w), b.y ?? Math.min((top?.y ?? 0) + 24, 49000), w, h,
      b.rotation ?? Math.round((Math.random() * 4 - 2) * 10) / 10, b.z ?? top?.z ?? 1, [...new Set(b.tags ?? [])], a.user.id, item?.id ?? null,
    ],
  );
  await logActivity(ws, 'pin', row.id, a.user.id, 'created', `Pinned “${row.title}”`);
  return c.json({ pin: (await serializePins(a, [row]))[0] }, 201);
});

boardRoutes.get('/pins/:id', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'pin', c.req.param('id'));
  return c.json({ pin: (await serializePins(a, [row]))[0] });
});

boardRoutes.patch('/pins/:id', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'pin', c.req.param('id'));
  const b = parse(
    z.object({ title: z.string().trim().min(1).max(120).optional(), body: z.string().max(5000).optional(), color: COLOR.optional(), link_url: z.union([httpUrl, z.null()]).optional(), tags, ...geometry }),
    await c.req.json(),
  );
  const cols: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) if (v !== undefined) cols[k] = k === 'tags' ? [...new Set(v as string[])] : v;
  const w = (cols.w as number) ?? row.w;
  if (cols.x !== undefined || cols.w !== undefined) cols.x = Math.max(0, Math.min((cols.x as number) ?? row.x, WALL_WIDTH - w));
  const keys = Object.keys(cols);
  if (!keys.length) return c.json({ pin: (await serializePins(a, [row]))[0] });
  const updated = await q1(
    `UPDATE pins SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
    [row.id, a.user.id, ...keys.map((k) => cols[k])],
  );
  // Moving and resizing are not worth a history entry; content changes are.
  const content = keys.filter((k) => !['x', 'y', 'w', 'h', 'z', 'rotation'].includes(k));
  if (content.length) await logActivity(row.workspace_id, 'pin', row.id, a.user.id, 'updated', `Changed ${content.join(', ').replace(/_/g, ' ')}`);
  return c.json({ pin: (await serializePins(a, [updated]))[0] });
});

/** Lock or unlock a pin (creator only). Its conversation and photos move with it. */
boardRoutes.post('/pins/:id/privacy', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'pin', c.req.param('id'));
  const b = parse(z.object({ private: z.boolean() }), await c.req.json());
  if (row.created_by !== a.user.id) throw forbidden('Only the person who pinned this can lock or unlock it');
  const target = b.private ? a.personalWorkspaceId : a.sharedWorkspaceId;
  if (row.workspace_id === target) return c.json({ pin: (await serializePins(a, [row]))[0] });
  const moved = await tx(async (db) => {
    const updated = (await db.query<any>('UPDATE pins SET workspace_id = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *', [row.id, target, a.user.id])).rows[0];
    const thread = (await db.query<any>(`SELECT id FROM threads WHERE entity_type = 'pin' AND entity_id = $1`, [row.id])).rows[0];
    if (thread) {
      await db.query('UPDATE threads SET workspace_id = $2 WHERE id = $1', [thread.id, target]);
      await db.query(`UPDATE attachments SET workspace_id = $2 WHERE entity_type = 'message' AND entity_id IN (SELECT id FROM messages WHERE thread_id = $1)`, [thread.id, target]);
    }
    await db.query(`UPDATE attachments SET workspace_id = $2 WHERE entity_type = 'pin' AND entity_id = $1`, [row.id, target]);
    await db.query(`UPDATE reactions SET workspace_id = $2 WHERE entity_type = 'pin' AND entity_id = $1`, [row.id, target]);
    await db.query(`UPDATE activity SET workspace_id = $2 WHERE entity_type = 'pin' AND entity_id = $1`, [row.id, target]);
    if (b.private && a.partner) {
      for (const t of ['notifications', 'favorites', 'recently_viewed', 'reactions']) {
        await db.query(`DELETE FROM ${t} WHERE user_id = $1 AND entity_type = 'pin' AND entity_id = $2`, [a.partner.id, row.id]);
      }
    }
    return updated;
  });
  await logActivity(target, 'pin', row.id, a.user.id, b.private ? 'locked' : 'unlocked', b.private ? 'Made private' : 'Shared with both of you');
  return c.json({ pin: (await serializePins(a, [moved]))[0] });
});

/**
 * Commit a floating idea to a list: it becomes an item there (name, note and
 * link carried over), and the sticky from then on shows that item's details.
 */
boardRoutes.post('/pins/:id/commit', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'pin', c.req.param('id'));
  if (row.item_id) throw badRequest('This sticky is already on a list');
  const b = parse(z.object({ list: z.union([z.enum(['home', 'idea', 'grocery']), uuid]) }), await c.req.json());
  const custom = !['home', 'idea', 'grocery'].includes(b.list);
  const item = await insertItem(a, row.workspace_id === a.personalWorkspaceId ? 'me' : 'us', {
    module: custom ? 'custom' : (b.list as any), list_id: custom ? b.list : undefined, title: row.title, notes: row.body || undefined,
    link_url: row.link_url ?? undefined, tags: row.tags?.length ? row.tags : undefined,
  } as any);
  const updated = await q1('UPDATE pins SET item_id = $2, updated_at = now(), updated_by = $3 WHERE id = $1 RETURNING *', [row.id, item.id, a.user.id]);
  await logActivity(row.workspace_id, 'pin', row.id, a.user.id, 'updated', `Added to a list as “${item.title}”`);
  return c.json({ pin: (await serializePins(a, [updated]))[0], item });
});
