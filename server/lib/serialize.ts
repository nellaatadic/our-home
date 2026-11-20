import { q } from '../db.js';
import { spaceOf, type Auth } from './access.js';

/**
 * Decorate rows of any entity type with: space label, provenance, thread
 * counts (incl. unread for this user), reactions, favorite flag and whether a
 * shared copy exists. Every lookup is keyed by ids already authorized.
 */
export async function decorate<T extends { id: string; workspace_id: string }>(
  auth: Auth,
  type: 'item' | 'task' | 'event' | 'inventory' | 'expense' | 'topic' | 'pin' | 'list',
  rows: T[],
): Promise<(T & Record<string, unknown>)[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [threads, reactions, favs] = await Promise.all([
    q<{ entity_id: string; total: number; unread: number; last_at: Date | null }>(
      `SELECT t.entity_id,
              count(m.id) FILTER (WHERE m.deleted_at IS NULL)::int AS total,
              count(m.id) FILTER (WHERE m.deleted_at IS NULL AND m.author_id IS DISTINCT FROM $3 AND m.mirrored_from_id IS NULL AND m.created_at > COALESCE(r.last_read_at, 'epoch'))::int AS unread,
              max(m.created_at) AS last_at
         FROM threads t
         LEFT JOIN messages m ON m.thread_id = t.id
         LEFT JOIN thread_reads r ON r.thread_id = t.id AND r.user_id = $3
        WHERE t.entity_type = $1 AND t.entity_id = ANY($2::uuid[])
        GROUP BY t.entity_id`,
      [type, ids, auth.user.id],
    ),
    q<{ entity_id: string; user_id: string; reaction: string }>(
      'SELECT entity_id, user_id, reaction FROM reactions WHERE entity_type = $1 AND entity_id = ANY($2::uuid[])',
      [type, ids],
    ),
    q<{ entity_id: string }>('SELECT entity_id FROM favorites WHERE user_id = $1 AND entity_type = $2 AND entity_id = ANY($3::uuid[])', [auth.user.id, type, ids]),
  ]);
  const tmap = new Map(threads.map((t) => [t.entity_id, t]));
  const favSet = new Set(favs.map((f) => f.entity_id));
  const names = new Map(auth.members.map((m) => [m.id, m.display_name]));

  // Shared copies of personal records (only meaningful for types that can be shared).
  let copies = new Map<string, { id: string; shared_at: Date }>();
  const originCol = type === 'item' ? 'origin_item_id' : type === 'task' ? 'origin_task_id' : type === 'event' ? 'origin_event_id' : null;
  const table = type === 'item' ? 'items' : type === 'task' ? 'tasks' : type === 'event' ? 'events' : null;
  if (originCol && table) {
    const personalIds = rows.filter((r) => r.workspace_id === auth.personalWorkspaceId).map((r) => r.id);
    if (personalIds.length) {
      const cs = await q<{ id: string; origin: string; shared_at: Date }>(
        `SELECT id, ${originCol} AS origin, shared_at FROM ${table}
          WHERE ${originCol} = ANY($1::uuid[]) AND workspace_id = $2 AND archived_at IS NULL`,
        [personalIds, auth.sharedWorkspaceId],
      );
      copies = new Map(cs.map((c) => [c.origin, { id: c.id, shared_at: c.shared_at }]));
    }
  }

  return rows.map((r: any) => {
    const t = tmap.get(r.id);
    const copy = copies.get(r.id);
    const sharedAt = r.shared_at ? new Date(r.shared_at).getTime() : null;
    return {
      ...r,
      space: spaceOf(auth, r.workspace_id),
      created_by_name: names.get(r.created_by) ?? null,
      origin_owner_name: r.origin_owner_id ? names.get(r.origin_owner_id) ?? 'Former member' : null,
      modified_since_shared: sharedAt ? new Date(r.updated_at).getTime() > sharedAt : false,
      shared_copy_id: copy?.id ?? null,
      original_changed_since_shared: copy ? new Date(r.updated_at).getTime() > new Date(copy.shared_at).getTime() : false,
      thread: { total: t?.total ?? 0, unread: t?.unread ?? 0, last_at: t?.last_at ?? null },
      reactions: reactions.filter((x) => x.entity_id === r.id).map((x) => ({ user_id: x.user_id, name: names.get(x.user_id), reaction: x.reaction })),
      favorite: favSet.has(r.id),
    };
  });
}
