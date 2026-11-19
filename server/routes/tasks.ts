import { Hono } from 'hono';
import { z } from 'zod';
import { q, q1 } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { assertMember, loadEntity, workspaceFor, type AppEnv, type Auth } from '../lib/access.js';
import { badRequest, dateStr, parse, priority, space, timeStr, uuid } from '../lib/http.js';
import { decorate } from '../lib/serialize.js';
import { logActivity, notify } from '../lib/notify.js';
import { addDays, addMonths, todayIn, zonedToUtc } from '../lib/time.js';

export const taskRoutes = new Hono<AppEnv>();

const STATUS = z.enum(['todo', 'planned', 'in_progress', 'waiting', 'completed', 'archived']);
const taskFields = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional(),
  kind: z.enum(['todo', 'maintenance']).optional(),
  due_date: dateStr.nullish(),
  due_time: timeStr.nullish(),
  priority: priority.optional(),
  assignee: z.enum(['none', 'user', 'both']).optional(),
  assigned_user_id: uuid.nullish(),
  status: STATUS.optional(),
  reminder_at: z.string().datetime({ offset: true }).nullish(),
  recurrence_unit: z.enum(['day', 'week', 'month', 'year']).nullish(),
  recurrence_interval: z.number().int().min(1).max(365).nullish(),
  related_event_id: uuid.nullish(),
  related_item_id: uuid.nullish(),
});
const COLS = ['title', 'description', 'kind', 'due_date', 'due_time', 'priority', 'assignee', 'assigned_user_id', 'status', 'reminder_at',
  'recurrence_unit', 'recurrence_interval', 'related_event_id', 'related_item_id'] as const;

async function validate(a: Auth, workspaceId: string, b: Partial<z.infer<typeof taskFields>>, existing?: any) {
  const assignee = b.assignee ?? existing?.assignee ?? 'none';
  const assignedUser = b.assigned_user_id !== undefined ? b.assigned_user_id : existing?.assigned_user_id;
  if (assignee === 'user' && !assignedUser) throw badRequest('Choose who the task is assigned to');
  if (assignee !== 'user') b.assigned_user_id = null;
  assertMember(a, b.assigned_user_id);
  if (workspaceId === a.personalWorkspaceId && b.assigned_user_id && b.assigned_user_id !== a.user.id) {
    throw badRequest('Private tasks can only be assigned to yourself. Share it with US to assign it to your partner.');
  }
  if ((b.recurrence_unit == null) !== (b.recurrence_interval == null) && (b.recurrence_unit !== undefined || b.recurrence_interval !== undefined)) {
    if (b.recurrence_unit && b.recurrence_interval == null) b.recurrence_interval = 1;
    else if (!b.recurrence_unit) b.recurrence_interval = null;
  }
  if (b.related_event_id) await loadEntity(a, 'event', b.related_event_id);
  if (b.related_item_id) await loadEntity(a, 'item', b.related_item_id);
}

export async function serializeTasks(a: Auth, rows: any[]) {
  const d = await decorate(a, 'task', rows);
  const names = new Map(a.members.map((m) => [m.id, m.display_name]));
  return d.map((t: any) => ({
    ...t,
    assigned_user_name: t.assigned_user_id ? names.get(t.assigned_user_id) ?? null : null,
    completed_by_name: t.completed_by ? names.get(t.completed_by) ?? null : null,
  }));
}

function notifyAssignment(a: Auth, task: any, previous?: any) {
  const recipients: string[] = [];
  if (task.assignee === 'user' && task.assigned_user_id && (!previous || previous.assigned_user_id !== task.assigned_user_id || previous.assignee !== 'user')) recipients.push(task.assigned_user_id);
  if (task.assignee === 'both' && (!previous || previous.assignee !== 'both')) recipients.push(...a.members.map((m) => m.id));
  if (!recipients.length) return;
  return notify({
    recipients, actorId: a.user.id, workspaceId: task.workspace_id, type: 'assigned',
    title: `${a.user.display_name} assigned you “${task.title}”`, entityType: 'task', entityId: task.id,
  });
}

taskRoutes.get('/spaces/:space/tasks', async (c) => {
  const a = requireAuth(c);
  const ws = workspaceFor(a, parse(space, c.req.param('space')));
  const f = parse(
    z.object({
      status: z.enum(['open', 'completed', 'archived', 'all']).optional(), assigned: z.enum(['me', 'partner', 'both', 'none']).optional(),
      kind: z.enum(['todo', 'maintenance']).optional(), q: z.string().max(100).optional(),
    }),
    c.req.query(),
  );
  const status = f.status ?? 'open';
  const partnerId = a.partner?.id ?? '00000000-0000-0000-0000-000000000000';
  const rows = await q(
    `SELECT * FROM tasks WHERE workspace_id = $1
       AND (CASE $2 WHEN 'open' THEN status NOT IN ('completed','archived') AND archived_at IS NULL
                    WHEN 'completed' THEN status = 'completed' AND archived_at IS NULL
                    WHEN 'archived' THEN (status = 'archived' OR archived_at IS NOT NULL)
                    ELSE true END)
       AND (CASE $3::text WHEN 'me' THEN (assignee = 'user' AND assigned_user_id = $4) OR assignee = 'both'
                          WHEN 'partner' THEN (assignee = 'user' AND assigned_user_id = $5) OR assignee = 'both'
                          WHEN 'both' THEN assignee = 'both'
                          WHEN 'none' THEN assignee = 'none'
                          ELSE true END)
       AND ($6::text IS NULL OR kind = $6)
       AND ($7::text IS NULL OR title ILIKE '%' || $7 || '%' OR description ILIKE '%' || $7 || '%')
     ORDER BY (due_date IS NULL), due_date, due_time NULLS LAST,
              array_position(ARRAY['urgent','high','normal','low'], priority), created_at DESC
     LIMIT 500`,
    [ws, status, f.assigned ?? null, a.user.id, partnerId, f.kind ?? null, f.q ?? null],
  );
  return c.json({ tasks: await serializeTasks(a, rows) });
});

taskRoutes.post('/spaces/:space/tasks', async (c) => {
  const a = requireAuth(c);
  const ws = workspaceFor(a, parse(space, c.req.param('space')));
  const b = parse(taskFields, await c.req.json());
  await validate(a, ws, b);
  const cols: Record<string, unknown> = {};
  for (const k of COLS) if ((b as any)[k] !== undefined) cols[k] = (b as any)[k];
  if (cols.recurrence_unit && !cols.recurrence_interval) cols.recurrence_interval = 1;
  const keys = Object.keys(cols);
  const row = await q1<any>(
    `INSERT INTO tasks (workspace_id, created_by, updated_by${keys.map((k) => `, ${k}`).join('')})
     VALUES ($1,$2,$2${keys.map((_, i) => `, $${i + 3}`).join('')}) RETURNING *`,
    [ws, a.user.id, ...keys.map((k) => cols[k])],
  );
  await logActivity(ws, 'task', row.id, a.user.id, 'created', `Created task “${row.title}”`);
  await notifyAssignment(a, row);
  return c.json({ task: (await serializeTasks(a, [row]))[0] }, 201);
});

taskRoutes.get('/tasks/:id', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'task', c.req.param('id'));
  const [task] = await serializeTasks(a, [row]);
  const [completions, activity, event, item] = await Promise.all([
    q(`SELECT tc.*, u.display_name AS completed_by_name FROM task_completions tc LEFT JOIN users u ON u.id = tc.completed_by WHERE task_id = $1 ORDER BY completed_at DESC LIMIT 50`, [row.id]),
    q(`SELECT ac.action, ac.summary, ac.created_at, u.display_name AS actor_name FROM activity ac LEFT JOIN users u ON u.id = ac.actor_id WHERE entity_type = 'task' AND entity_id = $1 ORDER BY ac.created_at DESC LIMIT 50`, [row.id]),
    row.related_event_id ? q1('SELECT id, title, start_date FROM events WHERE id = $1 AND workspace_id = ANY($2::uuid[])', [row.related_event_id, [a.personalWorkspaceId, a.sharedWorkspaceId]]) : null,
    row.related_item_id ? q1('SELECT id, title, module FROM items WHERE id = $1 AND workspace_id = ANY($2::uuid[])', [row.related_item_id, [a.personalWorkspaceId, a.sharedWorkspaceId]]) : null,
  ]);
  await q(`INSERT INTO recently_viewed (user_id, entity_type, entity_id) VALUES ($1,'task',$2) ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE SET viewed_at = now()`, [a.user.id, row.id]);
  return c.json({ task: { ...task, completions, activity, related_event: event, related_item: item } });
});

function nextDue(due: string, unit: string, n: number) {
  if (unit === 'day') return addDays(due, n);
  if (unit === 'week') return addDays(due, 7 * n);
  if (unit === 'month') return addMonths(due, n);
  return addMonths(due, 12 * n);
}

taskRoutes.patch('/tasks/:id', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'task', c.req.param('id'));
  const b = parse(taskFields.partial(), await c.req.json());
  await validate(a, row.workspace_id, b, row);
  const cols: Record<string, unknown> = {};
  for (const k of COLS) if ((b as any)[k] !== undefined) cols[k] = (b as any)[k];
  if ('reminder_at' in cols) cols.reminder_sent_at = null;

  const completing = b.status === 'completed' && row.status !== 'completed';
  if (completing) {
    await q('INSERT INTO task_completions (task_id, due_date, completed_by) VALUES ($1,$2,$3)', [row.id, row.due_date, a.user.id]);
    const unit = cols.recurrence_unit ?? row.recurrence_unit;
    const interval = (cols.recurrence_interval ?? row.recurrence_interval) as number | null;
    if (unit && interval) {
      // Recurring: roll forward to the next occurrence instead of closing.
      const base = (row.due_date as string) ?? todayIn(a.household.timezone);
      let next = nextDue(base, unit as string, interval);
      const today = todayIn(a.household.timezone);
      while (next <= today && base < today) next = nextDue(next, unit as string, interval);
      cols.status = 'todo';
      cols.due_date = next;
      if (row.reminder_at) {
        const shift = new Date(zonedToUtc(next, '00:00', a.household.timezone)).getTime() - new Date(zonedToUtc(base, '00:00', a.household.timezone)).getTime();
        cols.reminder_at = new Date(new Date(row.reminder_at).getTime() + shift).toISOString();
        cols.reminder_sent_at = null;
      }
      cols.completed_at = new Date();
      cols.completed_by = a.user.id;
    } else {
      cols.completed_at = new Date();
      cols.completed_by = a.user.id;
    }
  } else if (b.status && b.status !== 'completed' && row.status === 'completed') {
    cols.completed_at = null;
    cols.completed_by = null;
  }
  const keys = Object.keys(cols);
  if (!keys.length) return c.json({ task: (await serializeTasks(a, [row]))[0] });
  const updated = await q1<any>(
    `UPDATE tasks SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
    [row.id, a.user.id, ...keys.map((k) => cols[k])],
  );
  const summary = completing
    ? updated.status === 'todo' ? `Completed; next due ${updated.due_date}` : 'Completed'
    : b.status && b.status !== row.status ? `Status: ${b.status.replace('_', ' ')}` : `Updated ${keys.filter((k) => k !== 'reminder_sent_at').join(', ').replace(/_/g, ' ')}`;
  await logActivity(row.workspace_id, 'task', row.id, a.user.id, completing ? 'completed' : 'updated', summary);
  await notifyAssignment(a, updated, row);
  if ((completing || (b.status && b.status !== row.status)) && row.workspace_id === a.sharedWorkspaceId) {
    const watchers = [row.created_by, row.assigned_user_id].filter(Boolean);
    await notify({
      recipients: watchers, actorId: a.user.id, workspaceId: row.workspace_id, type: 'assigned',
      title: `${a.user.display_name} ${completing ? 'completed' : `set “${row.title}” to ${updated.status.replace('_', ' ')}`}${completing ? ` “${row.title}”` : ''}`,
      entityType: 'task', entityId: row.id,
    });
  }
  return c.json({ task: (await serializeTasks(a, [updated]))[0] });
});

/** Reminder → calendar event. */
taskRoutes.post('/tasks/:id/to-event', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'task', c.req.param('id'));
  const b = parse(z.object({ date: dateStr.optional(), time: timeStr.nullish(), duration_minutes: z.number().int().min(5).max(1440).nullish() }), await c.req.json().catch(() => ({})));
  const date = b.date ?? row.due_date;
  if (!date) throw badRequest('Choose a date for the event');
  const time = b.time !== undefined ? b.time : row.due_time;
  const tz = a.household.timezone;
  const starts = time ? zonedToUtc(date, time, tz) : null;
  const ends = starts && b.duration_minutes ? new Date(starts.getTime() + b.duration_minutes * 60000) : null;
  const ev = await q1<any>(
    `INSERT INTO events (workspace_id, title, description, start_date, end_date, starts_at, ends_at, all_day, time_unspecified, source_type, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$4,$5,$6,false,$7,'task',$8,$8) RETURNING *`,
    [row.workspace_id, row.title, row.description, date, starts, ends, !time, a.user.id],
  );
  await q('UPDATE tasks SET related_event_id = $1, due_date = COALESCE(due_date, $2), updated_at = now() WHERE id = $3', [ev.id, date, row.id]);
  await logActivity(row.workspace_id, 'event', ev.id, a.user.id, 'created', `Created from task “${row.title}”`);
  return c.json({ event: ev }, 201);
});
