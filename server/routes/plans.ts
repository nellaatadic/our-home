import { Hono } from 'hono';
import { z } from 'zod';
import { q, q1 } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { accessibleWorkspaceIds, loadEntity, spaceOf, THREAD_ENTITY_TYPES, type AppEnv, type Auth } from '../lib/access.js';
import { badRequest, parse } from '../lib/http.js';
import { parseRefs, resolveCards, REF_TYPES, type Ref } from '../lib/refs.js';
import { todayIn } from '../lib/time.js';
import { serializeItems } from './items.js';
import { serializeTasks } from './tasks.js';
import { serializeEvents } from './events.js';

/**
 * Plans are events marked "plan": they get their own page with a checklist
 * (to-dos linked to the event), lists of their own, everything that was
 * linked to them, and their conversation. Plans are temporary, so they are not
 * in the sidebar; once the date has passed the page asks whether to archive.
 */
export const planRoutes = new Hono<AppEnv>();

/** A plan is over the day after it ends. */
function isOver(e: { start_date: string; end_date: string | null }, today: string) {
  return String(e.end_date ?? e.start_date).slice(0, 10) < today;
}

async function progress(a: Auth, ids: string[]) {
  if (!ids.length) return new Map<string, { total: number; done: number }>();
  const rows = await q<{ id: string; total: number; done: number }>(
    `SELECT related_event_id AS id, count(*)::int AS total, count(*) FILTER (WHERE status = 'completed')::int AS done
       FROM tasks WHERE related_event_id = ANY($1::uuid[]) AND workspace_id = ANY($2::uuid[]) AND archived_at IS NULL GROUP BY related_event_id`,
    [ids, accessibleWorkspaceIds(a)],
  );
  return new Map(rows.map((r) => [r.id, { total: r.total, done: r.done }]));
}

/** Plans that are not archived, soonest first. */
export async function activePlans(a: Auth) {
  const today = todayIn(a.household.timezone);
  const rows = await q<any>(
    `SELECT id, title, start_date::text AS start_date, end_date::text AS end_date, workspace_id, archive_prompt_dismissed_at FROM events
      WHERE workspace_id = ANY($1::uuid[]) AND is_plan AND archived_at IS NULL ORDER BY start_date LIMIT 50`,
    [accessibleWorkspaceIds(a)],
  );
  const prog = await progress(a, rows.map((r) => r.id));
  return rows.map((r) => {
    const over = isOver(r, today);
    return {
      id: r.id, title: r.title, start_date: r.start_date, end_date: r.end_date, space: spaceOf(a, r.workspace_id),
      checklist: prog.get(r.id) ?? { total: 0, done: 0 }, over, ask_to_archive: over && !r.archive_prompt_dismissed_at,
    };
  });
}

planRoutes.get('/plans', async (c) => {
  const a = requireAuth(c);
  return c.json({ plans: await activePlans(a) });
});

planRoutes.get('/plans/:id', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'event', c.req.param('id'));
  const wss = accessibleWorkspaceIds(a);
  const today = todayIn(a.household.timezone);
  const [ev] = await serializeEvents(a, [row]);
  const [tasks, lists] = await Promise.all([
    q(`SELECT * FROM tasks WHERE related_event_id = $1 AND workspace_id = ANY($2::uuid[]) AND (archived_at IS NULL OR archived_at = $3)
        ORDER BY status = 'completed', due_date NULLS LAST, created_at`, [row.id, wss, row.archived_at]),
    q<any>(`SELECT * FROM lists WHERE event_id = $1 AND workspace_id = ANY($2::uuid[]) AND (archived_at IS NULL OR archived_at = $3) ORDER BY position, created_at`, [row.id, wss, row.archived_at]),
  ]);
  const listItems = lists.length
    ? await q<any>(
      `SELECT i.* FROM items i LEFT JOIN categories c ON c.id = i.category_id
        WHERE i.list_id = ANY($1::uuid[]) AND i.workspace_id = ANY($2::uuid[]) AND (i.archived_at IS NULL OR i.archived_at = $3)
        ORDER BY i.grocery_state, lower(COALESCE(c.name, '~')), i.created_at`,
      [lists.map((l) => l.id), wss, row.archived_at],
    )
    : [];
  const items = await serializeItems(a, listItems);
  const over = isOver(row, today);
  return c.json({
    plan: { ...ev, over, ask_to_archive: over && !row.archived_at && !row.archive_prompt_dismissed_at },
    checklist: await serializeTasks(a, tasks),
    lists: lists.map((l) => ({
      id: l.id, name: l.name, emoji: l.emoji, color: l.color, private: l.workspace_id === a.personalWorkspaceId,
      items: items.filter((i: any) => i.list_id === l.id),
    })),
  });
});

/** "Not yet": stop asking to archive this plan. */
planRoutes.post('/plans/:id/keep', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'event', c.req.param('id'));
  await q('UPDATE events SET archive_prompt_dismissed_at = now() WHERE id = $1', [row.id]);
  return c.json({ ok: true });
});

/**
 * Archiving a plan archives its checklist and lists with the same timestamp,
 * so restoring the plan brings back exactly those.
 */
export async function archivePlanParts(eventId: string, archivedAt: Date | string | null, restoreFrom?: Date | string | null) {
  if (archivedAt) {
    await q(`UPDATE tasks SET archived_at = $2 WHERE related_event_id = $1 AND archived_at IS NULL`, [eventId, archivedAt]);
    await q(`UPDATE items SET archived_at = $2 WHERE list_id IN (SELECT id FROM lists WHERE event_id = $1) AND archived_at IS NULL`, [eventId, archivedAt]);
    await q(`UPDATE lists SET archived_at = $2 WHERE event_id = $1 AND archived_at IS NULL`, [eventId, archivedAt]);
  } else if (restoreFrom) {
    await q(`UPDATE tasks SET archived_at = NULL WHERE related_event_id = $1 AND archived_at = $2`, [eventId, restoreFrom]);
    await q(`UPDATE items SET archived_at = NULL WHERE list_id IN (SELECT id FROM lists WHERE event_id = $1) AND archived_at = $2`, [eventId, restoreFrom]);
    await q(`UPDATE lists SET archived_at = NULL WHERE event_id = $1 AND archived_at = $2`, [eventId, restoreFrom]);
  }
}

// ------------------------------------------------------------------ links
const LINK_TYPE = z.enum(REF_TYPES);

async function tagsOf(type: string, id: string): Promise<string[]> {
  if (type === 'item') return (await q<{ name: string }>('SELECT t.name FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE it.item_id = $1', [id])).map((r) => r.name);
  if (type === 'event') return (await q1<{ tags: string[] }>('SELECT tags FROM events WHERE id = $1', [id]))?.tags ?? [];
  if (type === 'pin') return (await q1<{ tags: string[] }>('SELECT tags FROM pins WHERE id = $1', [id]))?.tags ?? [];
  return [];
}

/**
 * Everything connected to a card: cards its conversation links to, cards
 * whose conversations link to it, and records that share one of its tags.
 * Only what the viewer may open is returned.
 */
planRoutes.get('/links/:type/:id', async (c) => {
  const a = requireAuth(c);
  const type = parse(LINK_TYPE, c.req.param('type'));
  const id = c.req.param('id');
  if (type === 'list') {
    const l = await q1<any>('SELECT id FROM lists WHERE id = $1 AND workspace_id = ANY($2::uuid[])', [id, accessibleWorkspaceIds(a)]);
    if (!l) throw badRequest('Unknown list');
  } else {
    await loadEntity(a, type, id);
  }
  const wss = accessibleWorkspaceIds(a);
  const self = `${type}:${id}`;

  // Out: references written in this card's own conversation.
  const own = (THREAD_ENTITY_TYPES as readonly string[]).includes(type)
    ? await q<{ body: string }>(`SELECT m.body FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.entity_type = $1 AND t.entity_id = $2 AND m.deleted_at IS NULL`, [type, id])
    : [];
  const outRefs = parseRefs(own.map((m) => m.body).join('\n')).filter((r) => `${r.type}:${r.id}` !== self);

  // In: conversations elsewhere that reference this card.
  const incoming = await q<{ entity_type: string; entity_id: string; is_general: boolean; n: number }>(
    `SELECT t.entity_type, t.entity_id, COALESCE(tp.is_general, false) AS is_general, count(*)::int AS n
       FROM messages m JOIN threads t ON t.id = m.thread_id
       LEFT JOIN topics tp ON t.entity_type = 'topic' AND tp.id = t.entity_id
      WHERE t.workspace_id = ANY($1::uuid[]) AND m.deleted_at IS NULL AND m.mirrored_from_id IS NULL
        AND strpos(m.body, $2) > 0 AND NOT (t.entity_type = $3 AND t.entity_id::text = $4)
      GROUP BY t.entity_type, t.entity_id, tp.is_general`,
    [wss, `](${self})`, type, id],
  );
  const inRefs: Ref[] = incoming.filter((r) => !r.is_general && (REF_TYPES as readonly string[]).includes(r.entity_type)).map((r) => ({ type: r.entity_type as Ref['type'], id: r.entity_id }));

  // Tagged: records sharing a tag with this one.
  const tagList = await tagsOf(type, id);
  const tags = tagList.map((t) => t.toLowerCase());
  let tagged: Ref[] = [];
  if (tags.length) {
    const rows = await q<{ type: Ref['type']; id: string }>(
      `(SELECT 'item' AS type, i.id FROM items i JOIN item_tags it ON it.item_id = i.id JOIN tags t ON t.id = it.tag_id
         WHERE i.workspace_id = ANY($1::uuid[]) AND i.archived_at IS NULL AND lower(t.name) = ANY($2::text[]) LIMIT 30)
       UNION
       (SELECT 'event', e.id FROM events e WHERE e.workspace_id = ANY($1::uuid[]) AND e.archived_at IS NULL
         AND EXISTS (SELECT 1 FROM unnest(e.tags) x WHERE lower(x) = ANY($2::text[])) LIMIT 30)
       UNION
       (SELECT 'pin', p.id FROM pins p WHERE p.workspace_id = ANY($1::uuid[]) AND p.archived_at IS NULL
         AND EXISTS (SELECT 1 FROM unnest(p.tags) x WHERE lower(x) = ANY($2::text[])) LIMIT 30)`,
      [wss, tags],
    );
    tagged = rows.filter((r) => `${r.type}:${r.id}` !== self);
  }

  const [mentions, mentionedIn, sameTag] = await Promise.all([resolveCards(a, outRefs), resolveCards(a, inRefs), resolveCards(a, tagged)]);
  return c.json({
    mentions,
    mentioned_in: mentionedIn,
    in_main_chat: incoming.filter((r) => r.is_general).reduce((s, r) => s + r.n, 0),
    tags: tagList,
    tagged: sameTag,
  });
});

