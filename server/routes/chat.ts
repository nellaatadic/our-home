import { Hono } from 'hono';
import { z } from 'zod';
import { q, q1 } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { accessibleWorkspaceIds, loadEntity, spaceOf, type AppEnv, type Auth } from '../lib/access.js';
import { parse } from '../lib/http.js';
import { logActivity } from '../lib/notify.js';

/**
 * The Chat page: every conversation as a card (one per record or topic), plus
 * one ongoing general chat per household. Threads themselves are read and
 * written through the normal /threads routes, so access == access to the record.
 */
export const chatRoutes = new Hono<AppEnv>();

export async function generalTopic(a: Auth) {
  const existing = await q1<any>('SELECT * FROM topics WHERE workspace_id = $1 AND is_general', [a.sharedWorkspaceId]);
  if (existing) return existing;
  return q1<any>(
    `INSERT INTO topics (workspace_id, title, is_general, created_by) VALUES ($1, 'Our chat', true, $2)
     ON CONFLICT (workspace_id) WHERE is_general DO UPDATE SET title = topics.title RETURNING *`,
    [a.sharedWorkspaceId, a.user.id],
  );
}

chatRoutes.get('/chat/general', async (c) => {
  const a = requireAuth(c);
  return c.json({ topic: await generalTopic(a) });
});

const TITLE_SQL = `CASE t.entity_type
    WHEN 'item' THEN (SELECT title FROM items WHERE id = t.entity_id)
    WHEN 'task' THEN (SELECT title FROM tasks WHERE id = t.entity_id)
    WHEN 'event' THEN (SELECT title FROM events WHERE id = t.entity_id)
    WHEN 'topic' THEN (SELECT title FROM topics WHERE id = t.entity_id)
    WHEN 'inventory' THEN (SELECT name FROM inventory_items WHERE id = t.entity_id)
    WHEN 'expense' THEN (SELECT title FROM expenses WHERE id = t.entity_id)
    WHEN 'pin' THEN (SELECT title FROM pins WHERE id = t.entity_id AND archived_at IS NULL)
    WHEN 'list' THEN (SELECT CASE module WHEN 'grocery' THEN 'Groceries' WHEN 'home' THEN 'Home & Gadgets' WHEN 'idea' THEN 'Shopping & Other' ELSE name END FROM lists WHERE id = t.entity_id AND archived_at IS NULL)
  END`;

/** Conversation cards, newest activity first. The general chat is not a card. */
chatRoutes.get('/chat/cards', async (c) => {
  const a = requireAuth(c);
  const f = parse(z.object({ q: z.string().max(100).optional() }), c.req.query());
  const rows = await q<any>(
    `WITH cards AS (
       SELECT t.id AS thread_id, t.entity_type, t.entity_id, t.workspace_id, ${TITLE_SQL} AS title,
              (SELECT module FROM items WHERE id = t.entity_id AND t.entity_type = 'item') AS module,
              (SELECT list_id FROM items WHERE id = t.entity_id AND t.entity_type = 'item') AS list_id,
              (SELECT is_plan FROM events WHERE id = t.entity_id AND t.entity_type = 'event') AS is_plan,
              count(m.id) FILTER (WHERE m.deleted_at IS NULL)::int AS total,
              count(m.id) FILTER (WHERE m.deleted_at IS NULL AND m.author_id IS DISTINCT FROM $2 AND m.mirrored_from_id IS NULL AND m.created_at > COALESCE(r.last_read_at, 'epoch'))::int AS unread,
              max(m.created_at) AS last_at
         FROM threads t
         JOIN messages m ON m.thread_id = t.id
         LEFT JOIN thread_reads r ON r.thread_id = t.id AND r.user_id = $2
        WHERE t.workspace_id = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM topics tp WHERE tp.id = t.entity_id AND t.entity_type = 'topic' AND (tp.is_general OR tp.archived_at IS NOT NULL))
        GROUP BY t.id
       UNION ALL
       -- Topics nobody has written in yet still show up as cards.
       SELECT NULL, 'topic', tp.id, tp.workspace_id, tp.title, NULL, NULL::uuid, NULL::boolean, 0, 0, tp.created_at
         FROM topics tp
        WHERE tp.workspace_id = ANY($1::uuid[]) AND NOT tp.is_general AND tp.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM threads t JOIN messages m ON m.thread_id = t.id WHERE t.entity_type = 'topic' AND t.entity_id = tp.id)
     )
     SELECT cards.*,
            (SELECT CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END FROM messages m WHERE m.thread_id = cards.thread_id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
            (SELECT u.display_name FROM messages m JOIN users u ON u.id = m.author_id WHERE m.thread_id = cards.thread_id ORDER BY m.created_at DESC LIMIT 1) AS last_author
       FROM cards
      WHERE title IS NOT NULL AND ($3::text IS NULL OR title ILIKE '%' || $3 || '%')
      ORDER BY last_at DESC NULLS LAST
      LIMIT 200`,
    [accessibleWorkspaceIds(a), a.user.id, f.q?.trim() || null],
  );
  return c.json({
    cards: rows.map((r) => ({
      entity_type: r.entity_type, entity_id: r.entity_id, title: r.title, module: r.module, list_id: r.list_id, is_plan: Boolean(r.is_plan), space: spaceOf(a, r.workspace_id),
      total: r.total, unread: r.unread, last_at: r.last_at, last_body: (r.last_body ?? '').slice(0, 160), last_author: r.last_author,
    })),
  });
});

chatRoutes.post('/chat/topics', async (c) => {
  const a = requireAuth(c);
  const b = parse(z.object({ title: z.string().trim().min(1).max(120), private: z.boolean().optional() }), await c.req.json());
  const ws = b.private ? a.personalWorkspaceId : a.sharedWorkspaceId;
  const row = await q1<any>('INSERT INTO topics (workspace_id, title, created_by) VALUES ($1,$2,$3) RETURNING *', [ws, b.title, a.user.id]);
  await logActivity(ws, 'topic', row.id, a.user.id, 'created', `Started “${row.title}”`);
  return c.json({ topic: { ...row, space: spaceOf(a, ws) } }, 201);
});

chatRoutes.get('/topics/:id', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'topic', c.req.param('id'));
  return c.json({ topic: { ...row, space: spaceOf(a, row.workspace_id) } });
});

chatRoutes.patch('/topics/:id', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'topic', c.req.param('id'));
  const b = parse(z.object({ title: z.string().trim().min(1).max(120).optional(), archived: z.boolean().optional() }), await c.req.json());
  const updated = await q1(
    `UPDATE topics SET title = COALESCE($2, title), updated_at = now(),
       archived_at = CASE WHEN $3::boolean IS NULL OR is_general THEN archived_at WHEN $3 THEN now() ELSE NULL END
     WHERE id = $1 RETURNING *`,
    [row.id, b.title ?? null, b.archived ?? null],
  );
  return c.json({ topic: updated });
});

/**
 * Cards that can be @-referenced in a message. In a shared conversation only
 * shared (US) records are offered, so a reference never points the partner at
 * something they cannot open.
 */
chatRoutes.get('/chat/references', async (c) => {
  const a = requireAuth(c);
  const f = parse(z.object({ q: z.string().max(100).optional(), scope: z.enum(['us', 'all']).optional() }), c.req.query());
  const wss = f.scope === 'all' ? accessibleWorkspaceIds(a) : [a.sharedWorkspaceId];
  const term = f.q?.trim() || null;
  const rows = await q<any>(
    `(SELECT 'item' AS type, i.id, i.title, CASE WHEN i.module = 'custom' THEN l.name ELSE i.module END AS sub, i.updated_at FROM items i JOIN lists l ON l.id = i.list_id
        WHERE i.workspace_id = ANY($1::uuid[]) AND i.archived_at IS NULL AND ($2::text IS NULL OR i.title ILIKE '%' || $2 || '%') ORDER BY i.updated_at DESC LIMIT 8)
     UNION ALL
     (SELECT 'list', id, CASE module WHEN 'grocery' THEN 'Groceries' WHEN 'home' THEN 'Home & Gadgets' WHEN 'idea' THEN 'Shopping & Other' ELSE name END,
             CASE WHEN event_id IS NULL THEN 'list' ELSE 'plan list' END, updated_at FROM lists
        WHERE workspace_id = ANY($1::uuid[]) AND archived_at IS NULL AND (module = 'custom' OR (is_default AND workspace_id = $3))
          AND ($2::text IS NULL OR (CASE module WHEN 'grocery' THEN 'Groceries' WHEN 'home' THEN 'Home & Gadgets' WHEN 'idea' THEN 'Shopping & Other' ELSE name END) ILIKE '%' || $2 || '%')
        ORDER BY updated_at DESC LIMIT 4)
     UNION ALL
     (SELECT 'pin', id, title, 'board', updated_at FROM pins
        WHERE workspace_id = ANY($1::uuid[]) AND archived_at IS NULL AND ($2::text IS NULL OR title ILIKE '%' || $2 || '%' OR body ILIKE '%' || $2 || '%') ORDER BY updated_at DESC LIMIT 5)
     UNION ALL
     (SELECT 'event', id, title, CASE WHEN is_plan THEN 'plan · ' ELSE '' END || to_char(start_date, 'Mon DD'), updated_at FROM events
        WHERE workspace_id = ANY($1::uuid[]) AND archived_at IS NULL AND ($2::text IS NULL OR title ILIKE '%' || $2 || '%') ORDER BY abs(start_date - CURRENT_DATE) LIMIT 5)
     UNION ALL
     (SELECT 'task', id, title, 'to-do', updated_at FROM tasks
        WHERE workspace_id = ANY($1::uuid[]) AND archived_at IS NULL AND status NOT IN ('completed','archived') AND ($2::text IS NULL OR title ILIKE '%' || $2 || '%') ORDER BY updated_at DESC LIMIT 5)
     UNION ALL
     (SELECT 'topic', id, title, 'topic', updated_at FROM topics
        WHERE workspace_id = ANY($1::uuid[]) AND archived_at IS NULL AND NOT is_general AND ($2::text IS NULL OR title ILIKE '%' || $2 || '%') ORDER BY updated_at DESC LIMIT 5)`,
    [wss, term, a.sharedWorkspaceId],
  );
  const label: Record<string, string> = { grocery: 'Groceries', home: 'Home & Gadgets', idea: 'Shopping & Other' };
  return c.json({ references: rows.map((r) => ({ type: r.type, id: r.id, title: r.title, subtitle: label[r.sub] ?? r.sub })) });
});

/** Unread messages across all conversations, for the Chat badge. */
chatRoutes.get('/chat/unread', async (c) => {
  const a = requireAuth(c);
  const row = await q1<{ n: number }>(
    `SELECT count(*)::int AS n FROM threads t JOIN messages m ON m.thread_id = t.id
       LEFT JOIN thread_reads r ON r.thread_id = t.id AND r.user_id = $1
      WHERE t.workspace_id = ANY($2::uuid[]) AND m.author_id IS DISTINCT FROM $1 AND m.deleted_at IS NULL AND m.mirrored_from_id IS NULL AND m.created_at > COALESCE(r.last_read_at, 'epoch')`,
    [a.user.id, accessibleWorkspaceIds(a)],
  );
  return c.json({ unread: row?.n ?? 0 });
});
