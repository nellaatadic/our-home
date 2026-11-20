import { q, q1 } from '../db.js';
import { workspaceAudience } from './access.js';

export type NotificationType = 'mention' | 'reply' | 'shared' | 'assigned' | 'reminder' | 'calendar' | 'decision' | 'activity';

const PREF_COLUMN: Record<NotificationType, string> = {
  mention: 'notify_mentions',
  reply: 'notify_replies',
  shared: 'notify_shared',
  assigned: 'notify_assigned',
  reminder: 'notify_reminders',
  calendar: 'notify_calendar',
  decision: 'notify_decisions',
  activity: 'notify_activity',
};

export interface NotifyInput {
  recipients: string[];
  actorId: string | null;
  workspaceId: string;
  type: NotificationType;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
  messageId?: string;
  dedupeKey?: string;
}

/**
 * Create notifications. Recipients are filtered to people who can actually see
 * the workspace (so a mention inside a private item never reaches the partner),
 * who are not the actor, and who have not turned this type off.
 */
export async function notify(n: NotifyInput): Promise<number> {
  const audience = new Set(await workspaceAudience(n.workspaceId));
  const targets = [...new Set(n.recipients)].filter((u) => u && u !== n.actorId && audience.has(u));
  let created = 0;
  for (const userId of targets) {
    const pref = await q1<Record<string, boolean>>(`SELECT ${PREF_COLUMN[n.type]} AS on FROM user_settings WHERE user_id = $1`, [userId]);
    if (pref && pref.on === false) continue;
    const rows = await q(
      `INSERT INTO notifications (user_id, workspace_id, type, title, body, entity_type, entity_id, message_id, actor_id, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
      [userId, n.workspaceId, n.type, n.title.slice(0, 200), (n.body ?? '').slice(0, 500), n.entityType ?? null, n.entityId ?? null,
        n.messageId ?? null, n.actorId, n.dedupeKey ?? null],
    );
    created += rows.length;
  }
  return created;
}

export async function logActivity(workspaceId: string, entityType: string, entityId: string, actorId: string | null, action: string, summary = '') {
  await q('INSERT INTO activity (workspace_id, entity_type, entity_id, actor_id, action, summary) VALUES ($1,$2,$3,$4,$5,$6)', [
    workspaceId, entityType, entityId, actorId, action, summary.slice(0, 500),
  ]);
}

/** Generate due task reminders as notifications. Idempotent (reminder_sent_at + dedupe key). */
export async function dispatchDueReminders(householdId?: string): Promise<number> {
  const due = await q<any>(
    `SELECT t.id, t.title, t.reminder_at, t.workspace_id, t.assignee, t.assigned_user_id, t.created_by, w.household_id
       FROM tasks t JOIN workspaces w ON w.id = t.workspace_id
      WHERE t.reminder_at IS NOT NULL AND t.reminder_at <= now() AND t.reminder_sent_at IS NULL
        AND t.status NOT IN ('completed','archived') AND t.archived_at IS NULL
        AND ($1::uuid IS NULL OR w.household_id = $1)
      LIMIT 200`,
    [householdId ?? null],
  );
  let n = 0;
  for (const t of due) {
    let recipients: string[];
    if (t.assignee === 'user') recipients = [t.assigned_user_id];
    else recipients = await workspaceAudience(t.workspace_id);
    if (t.assignee === 'none' && t.created_by) recipients = [t.created_by];
    n += await notify({
      recipients, actorId: null, workspaceId: t.workspace_id, type: 'reminder',
      title: `Reminder: ${t.title}`, entityType: 'task', entityId: t.id, dedupeKey: `reminder:${t.id}:${new Date(t.reminder_at).toISOString()}`,
    });
    await q('UPDATE tasks SET reminder_sent_at = now() WHERE id = $1', [t.id]);
  }
  // List items with a date (e.g. "Eggs, today 2 PM"). Urgent ones go to both of you in US.
  const items = await q<any>(
    `SELECT i.id, i.title, i.reminder_at, i.workspace_id, i.assigned_to, i.created_by, i.urgent
       FROM items i JOIN workspaces w ON w.id = i.workspace_id
      WHERE i.reminder_at IS NOT NULL AND i.reminder_at <= now() AND i.reminder_sent_at IS NULL
        AND i.grocery_state = 'need' AND i.archived_at IS NULL
        AND ($1::uuid IS NULL OR w.household_id = $1)
      LIMIT 200`,
    [householdId ?? null],
  );
  for (const it of items) {
    const recipients = it.urgent ? await workspaceAudience(it.workspace_id) : [it.assigned_to ?? it.created_by].filter(Boolean);
    n += await notify({
      recipients, actorId: null, workspaceId: it.workspace_id, type: 'reminder',
      title: `${it.urgent ? 'Urgent: ' : 'Reminder: '}${it.title}`, entityType: 'item', entityId: it.id,
      dedupeKey: `reminder:item:${it.id}:${new Date(it.reminder_at).toISOString()}`,
    });
    await q('UPDATE items SET reminder_sent_at = now() WHERE id = $1', [it.id]);
  }
  return n;
}

const BUILTIN_LIST_NAMES: Record<string, string> = { grocery: 'Groceries', home: 'Home & Gadgets', idea: 'Shopping & Other' };

export async function listLabel(listId: string | null): Promise<string | null> {
  if (!listId) return null;
  const l = await q1<{ module: string; name: string }>('SELECT module, name FROM lists WHERE id = $1', [listId]);
  return l ? BUILTIN_LIST_NAMES[l.module] ?? l.name : null;
}

/**
 * Tell the partner what just happened to a shared item, in one short line:
 * "Nella marked Milk as urgent in @Groceries". Several additions to the same
 * list in a row are folded into one line while it is still unread.
 */
export async function tellPartner(
  actor: { id: string; display_name: string }, partnerId: string | null | undefined,
  item: { id: string; title: string; workspace_id: string; list_id: string | null },
  verb: 'added' | 'completed' | 'urgent' | 'removed' | 'moved', extra?: string,
) {
  if (!partnerId) return;
  const audience = await workspaceAudience(item.workspace_id);
  if (!audience.includes(partnerId)) return;
  const list = await listLabel(item.list_id);
  const where = list ? ` in @${list}` : '';
  const name = actor.display_name.split(' ')[0];
  if (verb === 'added') {
    const key = `added:${actor.id}:${item.list_id}`;
    const open = await q1<{ id: string; body: string }>(
      `SELECT id, body FROM notifications WHERE user_id = $1 AND type = 'activity' AND read_at IS NULL AND dedupe_key LIKE $2 || ':%'
         AND created_at > now() - interval '3 hours' ORDER BY created_at DESC LIMIT 1`, [partnerId, key]);
    if (open) {
      const titles = [...open.body.split('\n').filter(Boolean), item.title];
      const shown = titles.length <= 2 ? titles.join(' and ') : `${titles.slice(0, 2).join(', ')} +${titles.length - 2}`;
      await q('UPDATE notifications SET title = $2, body = $3, entity_id = $4, created_at = now() WHERE id = $1',
        [open.id, `${name} added ${shown} to @${list ?? 'a list'}`.slice(0, 200), titles.join('\n').slice(0, 500), item.id]);
      return;
    }
    await notify({ recipients: [partnerId], actorId: actor.id, workspaceId: item.workspace_id, type: 'activity',
      title: `${name} added ${item.title} to @${list ?? 'a list'}`, body: item.title, entityType: 'item', entityId: item.id, dedupeKey: `${key}:${Date.now()}` });
    return;
  }
  const text = verb === 'completed' ? `${name} completed ${item.title}${where}`
    : verb === 'urgent' ? `${name} marked ${item.title} as urgent${where}`
    : verb === 'removed' ? `${name} removed ${item.title}${where}`
    : `${name} moved ${item.title} to ${extra ?? 'another list'}`;
  await notify({ recipients: [partnerId], actorId: actor.id, workspaceId: item.workspace_id, type: 'activity', title: text,
    entityType: 'item', entityId: item.id, dedupeKey: `${verb}:${item.id}:${Date.now()}` });
}
