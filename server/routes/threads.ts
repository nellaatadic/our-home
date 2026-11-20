import { Hono } from 'hono';
import { z } from 'zod';
import { q, q1 } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { canAccessWorkspace, ENTITY_TABLES, isEntityType, loadEntity, THREAD_ENTITY_TYPES, type AppEnv, type Auth, type ThreadEntityType } from '../lib/access.js';
import { badRequest, forbidden, HttpError, notFound, parse, uuid } from '../lib/http.js';
import { logActivity, notify } from '../lib/notify.js';
import { getStorage } from '../lib/storage.js';
import { parseRefs } from '../lib/refs.js';
import { archivePlanParts } from './plans.js';
import { LIST_NAMES } from '../lib/defaults.js';

const listTitle = (l: any) => (l.module === 'custom' ? l.name : LIST_NAMES[l.module as keyof typeof LIST_NAMES] ?? l.name);

/** One discussion thread per record. Access to a thread == access to its record. */
export const threadRoutes = new Hono<AppEnv>();

const ENTITY = z.enum(THREAD_ENTITY_TYPES);

async function getOrCreateThread(workspaceId: string, type: ThreadEntityType, id: string) {
  const existing = await q1<any>('SELECT * FROM threads WHERE entity_type = $1 AND entity_id = $2', [type, id]);
  if (existing) {
    // Keep workspace in sync if the record was moved between spaces.
    if (existing.workspace_id !== workspaceId) await q('UPDATE threads SET workspace_id = $1 WHERE id = $2', [workspaceId, existing.id]);
    return { ...existing, workspace_id: workspaceId };
  }
  return q1<any>(
    `INSERT INTO threads (workspace_id, entity_type, entity_id) VALUES ($1,$2,$3)
     ON CONFLICT (entity_type, entity_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id RETURNING *`,
    [workspaceId, type, id],
  );
}

/**
 * Resolve @mentions to household members who can see this workspace.
 * Supports @Name (display name, first word), @ME / @YOU (relative to the author).
 */
export function resolveMentions(a: Auth, body: string, audience: string[]): string[] {
  const out = new Set<string>();
  const tokens = [...body.matchAll(/@([\p{L}\p{N}_.-]{1,40})/gu)].map((m) => m[1].toLowerCase());
  for (const t of tokens) {
    if (t === 'me') out.add(a.user.id);
    else if (t === 'you' && a.partner) out.add(a.partner.id);
    else {
      for (const m of a.members) {
        const full = m.display_name.toLowerCase().replace(/\s+/g, '');
        const first = m.display_name.toLowerCase().split(/\s+/)[0];
        if (t === first || t === full) out.add(m.id);
      }
    }
  }
  return [...out].filter((u) => audience.includes(u));
}

async function serializeMessages(threadId: string) {
  const rows = await q<any>(
    `SELECT m.id, m.author_id, u.display_name AS author_name, m.reply_to_id, m.mirrored_from_id, m.created_at, m.edited_at, m.deleted_at,
            CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END AS body,
            COALESCE((SELECT array_agg(user_id) FROM mentions WHERE message_id = m.id), '{}') AS mention_ids
       FROM messages m LEFT JOIN users u ON u.id = m.author_id
      WHERE m.thread_id = $1 ORDER BY m.created_at`,
    [threadId],
  );
  const atts = await q<any>(
    `SELECT a.id, a.entity_id, a.filename, a.content_type, a.size_bytes FROM attachments a
      WHERE a.entity_type = 'message' AND a.entity_id = ANY($1::uuid[])`,
    [rows.map((r) => r.id)],
  );
  return rows.map((r) => ({
    ...r,
    attachments: r.deleted_at ? [] : atts.filter((x) => x.entity_id === r.id).map((x) => ({ ...x, url: `/api/attachments/${x.id}` })),
  }));
}

threadRoutes.get('/threads/:type/:id', async (c) => {
  const a = requireAuth(c);
  const type = parse(ENTITY, c.req.param('type'));
  const entity = await loadEntity<any>(a, type, c.req.param('id'));
  const thread = await q1<any>('SELECT * FROM threads WHERE entity_type = $1 AND entity_id = $2', [type, entity.id]);
  if (!thread) return c.json({ thread: null, messages: [], last_read_at: null });
  const read = await q1<any>('SELECT last_read_at FROM thread_reads WHERE thread_id = $1 AND user_id = $2', [thread.id, a.user.id]);
  return c.json({ thread, messages: await serializeMessages(thread.id), last_read_at: read?.last_read_at ?? null });
});

threadRoutes.post('/threads/:type/:id/read', async (c) => {
  const a = requireAuth(c);
  const type = parse(ENTITY, c.req.param('type'));
  const entity = await loadEntity<any>(a, type, c.req.param('id'));
  const thread = await q1<any>('SELECT id FROM threads WHERE entity_type = $1 AND entity_id = $2', [type, entity.id]);
  if (thread) {
    await q(
      `INSERT INTO thread_reads (thread_id, user_id, last_read_at) VALUES ($1,$2,now())
       ON CONFLICT (thread_id, user_id) DO UPDATE SET last_read_at = now()`,
      [thread.id, a.user.id],
    );
    // Opening a conversation also clears its notifications.
    await q(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3 AND type IN ('mention','reply') AND read_at IS NULL`, [
      a.user.id, type, entity.id,
    ]);
  }
  return c.json({ ok: true });
});

threadRoutes.post('/threads/:type/:id/messages', async (c) => {
  const a = requireAuth(c);
  const type = parse(ENTITY, c.req.param('type'));
  const entity = await loadEntity<any>(a, type, c.req.param('id'));
  const b = parse(
    z.object({
      body: z.string().trim().max(5000),
      reply_to_id: uuid.nullish(),
      attachment_ids: z.array(uuid).max(5).optional(),
    }),
    await c.req.json(),
  );
  if (!b.body && !b.attachment_ids?.length) throw badRequest('Write a message or attach a file');
  const thread = await getOrCreateThread(entity.workspace_id, type, entity.id);
  let replyTo: any = null;
  if (b.reply_to_id) {
    replyTo = await q1<any>('SELECT id, author_id FROM messages WHERE id = $1 AND thread_id = $2', [b.reply_to_id, thread.id]);
    if (!replyTo) throw badRequest('You can only reply to a message in this conversation');
  }
  const msg = await q1<any>('INSERT INTO messages (thread_id, author_id, body, reply_to_id) VALUES ($1,$2,$3,$4) RETURNING *', [
    thread.id, a.user.id, b.body, replyTo?.id ?? null,
  ]);
  if (b.attachment_ids?.length) {
    // Only the author's own, not-yet-attached pending uploads in this workspace.
    await q(
      `UPDATE attachments SET entity_type = 'message', entity_id = $1
        WHERE id = ANY($2::uuid[]) AND uploaded_by = $3 AND workspace_id = $4 AND entity_type = 'message' AND entity_id = '00000000-0000-0000-0000-000000000000'`,
      [msg.id, b.attachment_ids, a.user.id, entity.workspace_id],
    );
  }
  await q(
    `INSERT INTO thread_reads (thread_id, user_id, last_read_at) VALUES ($1,$2,now()) ON CONFLICT (thread_id, user_id) DO UPDATE SET last_read_at = now()`,
    [thread.id, a.user.id],
  );

  const audience = entity.workspace_id === a.sharedWorkspaceId ? a.members.map((m) => m.id) : [a.user.id];
  const mentioned = resolveMentions(a, b.body, audience).filter((u) => u !== a.user.id);
  for (const u of mentioned) await q('INSERT INTO mentions (message_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [msg.id, u]);
  const title = entity.title ?? (type === 'list' ? listTitle(entity) : entity.name) ?? 'an item';
  const preview = b.body.slice(0, 140);
  if (mentioned.length) {
    await notify({ recipients: mentioned, actorId: a.user.id, workspaceId: entity.workspace_id, type: 'mention', title: `${a.user.display_name} mentioned you on “${title}”`, body: preview, entityType: type, entityId: entity.id, messageId: msg.id });
  }
  // Replies: notify other participants of this conversation (and the record's creator) who weren't just mentioned.
  const participants = await q<{ author_id: string }>('SELECT DISTINCT author_id FROM messages WHERE thread_id = $1 AND author_id IS NOT NULL', [thread.id]);
  const replyRecipients = new Set<string>(participants.map((p) => p.author_id));
  if (entity.created_by) replyRecipients.add(entity.created_by);
  if (replyTo?.author_id) replyRecipients.add(replyTo.author_id);
  // A list's chat (e.g. Groceries) is for both of you, like the main chat.
  if (type === 'list') audience.forEach((u) => replyRecipients.add(u));
  mentioned.forEach((m) => replyRecipients.delete(m));
  replyRecipients.delete(a.user.id);
  if (replyRecipients.size) {
    await notify({ recipients: [...replyRecipients], actorId: a.user.id, workspaceId: entity.workspace_id, type: 'reply', title: type === 'topic' || type === 'list' ? `${a.user.display_name} wrote in “${title}”` : `${a.user.display_name} replied on “${title}”`, body: preview, entityType: type, entityId: entity.id, messageId: msg.id });
  }
  if (type === 'item' && entity.decision_status === 'idea' && entity.workspace_id === a.sharedWorkspaceId) {
    await q(`UPDATE items SET decision_status = 'discussing', updated_at = now() WHERE id = $1`, [entity.id]);
  }
  await mirrorIntoCards(a, thread, msg);
  const all = await serializeMessages(thread.id);
  return c.json({ message: all.find((m) => m.id === msg.id) }, 201);
});

/**
 * Main chat → cards. When someone replies to a message in the main chat that
 * references a card (@[Dinner with Marco](event:…)), that message and the
 * replies to it are copied into the card's own conversation, so the card keeps
 * the whole discussion. Copies keep their author and time, are never counted
 * as unread twice, and follow edits and deletions of the original.
 * Only cards the replying person can open receive a copy.
 */
async function mirrorIntoCards(a: Auth, thread: any, msg: any) {
  if (thread.entity_type !== 'topic' || !msg.reply_to_id) return;
  const topic = await q1<{ is_general: boolean }>('SELECT is_general FROM topics WHERE id = $1', [thread.entity_id]);
  if (!topic?.is_general) return;
  const chain = await q<any>(
    `WITH RECURSIVE up AS (
       SELECT id, reply_to_id, author_id, body, created_at, deleted_at, 0 AS depth FROM messages WHERE id = $1
       UNION ALL
       SELECT m.id, m.reply_to_id, m.author_id, m.body, m.created_at, m.deleted_at, up.depth + 1
         FROM messages m JOIN up ON m.id = up.reply_to_id WHERE up.depth < 25 AND m.thread_id = $2
     ) SELECT * FROM up WHERE deleted_at IS NULL ORDER BY created_at`,
    [msg.id, thread.id],
  );
  const refs = parseRefs(chain.map((m) => m.body).join('\n'));
  for (const ref of refs) {
    let entity: any;
    try { entity = await loadEntity<any>(a, ref.type as ThreadEntityType, ref.id); } catch { continue; }
    if (entity.archived_at || (ref.type === 'topic' && entity.is_general)) continue;
    const target = await getOrCreateThread(entity.workspace_id, ref.type as ThreadEntityType, entity.id);
    if (target.id === thread.id) continue;
    const existing = await q<{ id: string; mirrored_from_id: string }>(
      'SELECT id, mirrored_from_id FROM messages WHERE thread_id = $1 AND mirrored_from_id = ANY($2::uuid[])',
      [target.id, chain.map((m) => m.id)],
    );
    const copyOf = new Map(existing.map((e) => [e.mirrored_from_id, e.id]));
    for (const m of chain) {
      if (copyOf.has(m.id)) continue;
      const copy = await q1<{ id: string }>(
        `INSERT INTO messages (thread_id, author_id, body, reply_to_id, created_at, mirrored_from_id) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (thread_id, mirrored_from_id) WHERE mirrored_from_id IS NOT NULL DO NOTHING RETURNING id`,
        [target.id, m.author_id, m.body, m.reply_to_id ? copyOf.get(m.reply_to_id) ?? null : null, m.created_at, m.id],
      );
      if (copy) copyOf.set(m.id, copy.id);
    }
  }
}

async function loadOwnMessage(a: Auth, id: string) {
  const m = await q1<any>(
    `SELECT m.*, t.workspace_id, t.entity_type, t.entity_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = $1`,
    [parse(uuid, id)],
  );
  if (!m || !canAccessWorkspace(a, m.workspace_id)) throw notFound();
  if (m.author_id !== a.user.id) throw forbidden('You can only change your own messages');
  if (m.mirrored_from_id) throw forbidden('This is a copy from Our chat. Change the original there.');
  if (m.deleted_at) throw new HttpError(410, 'gone', 'This message was deleted');
  return m;
}

threadRoutes.patch('/messages/:id', async (c) => {
  const a = requireAuth(c);
  const m = await loadOwnMessage(a, c.req.param('id'));
  const b = parse(z.object({ body: z.string().trim().min(1).max(5000) }), await c.req.json());
  await q('UPDATE messages SET body = $1, edited_at = now() WHERE id = $2 OR mirrored_from_id = $2', [b.body, m.id]);
  return c.json({ ok: true });
});

threadRoutes.delete('/messages/:id', async (c) => {
  const a = requireAuth(c);
  const m = await loadOwnMessage(a, c.req.param('id'));
  // Soft delete keeps reply structure intact ("message deleted").
  await q('UPDATE messages SET deleted_at = now(), body = $2 WHERE id = $1 OR mirrored_from_id = $1', [m.id, '']);
  const atts = await q<any>(`SELECT id, blob_key FROM attachments WHERE entity_type = 'message' AND entity_id = $1`, [m.id]);
  for (const att of atts) await getStorage().delete(att.blob_key);
  await q(`DELETE FROM attachments WHERE entity_type = 'message' AND entity_id = $1`, [m.id]);
  return c.json({ ok: true });
});

// -------------------------------------------- generic per-entity operations
export const entityRoutes = new Hono<AppEnv>();

function entityType(c: any) {
  const t = c.req.param('type');
  // Lists are archived and deleted through /lists, which takes their items along.
  if (!isEntityType(t) || t === 'list') throw notFound();
  return t;
}

entityRoutes.post('/entities/:type/:id/archive', async (c) => {
  const a = requireAuth(c);
  const type = entityType(c);
  const row = await loadEntity<any>(a, type, c.req.param('id'));
  if (type === 'receipt') throw badRequest('Receipts cannot be archived');
  const archived = await q1<{ archived_at: Date }>(`UPDATE ${ENTITY_TABLES[type]} SET archived_at = date_trunc('milliseconds', now()) WHERE id = $1 RETURNING archived_at`, [row.id]);
  if (type === 'event' && row.is_plan && !row.archived_at) await archivePlanParts(row.id, archived!.archived_at);
  await logActivity(row.workspace_id, type, row.id, a.user.id, 'archived', 'Archived');
  return c.json({ ok: true });
});

entityRoutes.post('/entities/:type/:id/unarchive', async (c) => {
  const a = requireAuth(c);
  const type = entityType(c);
  const row = await loadEntity<any>(a, type, c.req.param('id'));
  if (type === 'receipt') throw badRequest('Receipts cannot be archived');
  await q(`UPDATE ${ENTITY_TABLES[type]} SET archived_at = NULL WHERE id = $1`, [row.id]);
  if (type === 'event' && row.is_plan && row.archived_at) await archivePlanParts(row.id, null, row.archived_at);
  if (type === 'task' && row.status === 'archived') await q(`UPDATE tasks SET status = 'todo' WHERE id = $1`, [row.id]);
  await logActivity(row.workspace_id, type, row.id, a.user.id, 'restored', 'Restored from archive');
  return c.json({ ok: true });
});

/**
 * Permanent deletion. Records must be archived first, and shared records also
 * need an explicit confirmation flag — deletion is never the default path.
 */
entityRoutes.delete('/entities/:type/:id', async (c) => {
  const a = requireAuth(c);
  const type = entityType(c);
  const row = await loadEntity<any>(a, type, c.req.param('id'));
  if (type !== 'receipt' && !row.archived_at) throw badRequest('Archive this first. Archived items can be restored; deletion is permanent.');
  if (row.workspace_id === a.sharedWorkspaceId && c.req.query('confirm') !== 'permanent') {
    throw new HttpError(428, 'confirmation_required', 'Deleting shared information is permanent. Confirm to continue.');
  }
  const atts = await q<any>('SELECT blob_key FROM attachments WHERE entity_type = $1 AND entity_id = $2', [type, row.id]);
  for (const att of atts) await getStorage().delete(att.blob_key);
  await q('DELETE FROM attachments WHERE entity_type = $1 AND entity_id = $2', [type, row.id]);
  await q('DELETE FROM threads WHERE entity_type = $1 AND entity_id = $2', [type, row.id]);
  await q('DELETE FROM reactions WHERE entity_type = $1 AND entity_id = $2', [type, row.id]);
  await q('DELETE FROM favorites WHERE entity_type = $1 AND entity_id = $2', [type, row.id]);
  await q('DELETE FROM recently_viewed WHERE entity_type = $1 AND entity_id = $2', [type, row.id]);
  await q('DELETE FROM notifications WHERE entity_type = $1 AND entity_id = $2', [type, row.id]);
  await q(`DELETE FROM ${ENTITY_TABLES[type]} WHERE id = $1`, [row.id]);
  await logActivity(row.workspace_id, type, row.id, a.user.id, 'deleted', `Permanently deleted “${row.title ?? row.name ?? row.merchant ?? 'record'}”`);
  return c.json({ ok: true });
});

entityRoutes.post('/entities/:type/:id/favorite', async (c) => {
  const a = requireAuth(c);
  const type = entityType(c);
  const row = await loadEntity<any>(a, type, c.req.param('id'));
  const b = parse(z.object({ favorite: z.boolean() }), await c.req.json());
  if (b.favorite) await q('INSERT INTO favorites (user_id, entity_type, entity_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [a.user.id, type, row.id]);
  else await q('DELETE FROM favorites WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3', [a.user.id, type, row.id]);
  return c.json({ ok: true });
});

entityRoutes.post('/entities/:type/:id/reaction', async (c) => {
  const a = requireAuth(c);
  const type = parse(ENTITY, c.req.param('type'));
  const row = await loadEntity<any>(a, type, c.req.param('id'));
  const b = parse(z.object({ reaction: z.enum(['love', 'yes', 'unsure', 'no']).nullable() }), await c.req.json());
  if (b.reaction === null) {
    await q('DELETE FROM reactions WHERE entity_type = $1 AND entity_id = $2 AND user_id = $3', [type, row.id, a.user.id]);
  } else {
    await q(
      `INSERT INTO reactions (entity_type, entity_id, workspace_id, user_id, reaction) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (entity_type, entity_id, user_id) DO UPDATE SET reaction = EXCLUDED.reaction, created_at = now()`,
      [type, row.id, row.workspace_id, a.user.id, b.reaction],
    );
    const label = { love: 'loves', yes: 'is in favour of', unsure: 'is unsure about', no: 'is not keen on' }[b.reaction];
    await notify({
      recipients: a.members.map((m) => m.id), actorId: a.user.id, workspaceId: row.workspace_id, type: 'decision',
      title: `${a.user.display_name} ${label} “${row.title ?? row.name}”`, entityType: type, entityId: row.id, dedupeKey: `reaction:${type}:${row.id}:${a.user.id}:${b.reaction}`,
    });
  }
  return c.json({ ok: true });
});

entityRoutes.get('/entities/:type/:id/activity', async (c) => {
  const a = requireAuth(c);
  const type = entityType(c);
  const row = await loadEntity<any>(a, type, c.req.param('id'));
  const rows = await q(
    `SELECT ac.action, ac.summary, ac.created_at, u.display_name AS actor_name FROM activity ac LEFT JOIN users u ON u.id = ac.actor_id
      WHERE ac.entity_type = $1 AND ac.entity_id = $2 AND ac.workspace_id = ANY($3::uuid[]) ORDER BY ac.created_at DESC LIMIT 100`,
    [type, row.id, [a.personalWorkspaceId, a.sharedWorkspaceId]],
  );
  return c.json({ activity: rows });
});
