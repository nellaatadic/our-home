import { q, q1 } from '../db.js';
import { workspaceAudience } from './access.js';

export type NotificationType = 'mention' | 'reply' | 'shared' | 'assigned' | 'reminder' | 'calendar' | 'decision';

const PREF_COLUMN: Record<NotificationType, string> = {
  mention: 'notify_mentions',
  reply: 'notify_replies',
  shared: 'notify_shared',
  assigned: 'notify_assigned',
  reminder: 'notify_reminders',
  calendar: 'notify_calendar',
  decision: 'notify_decisions',
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
  return n;
}
