import { Hono } from 'hono';
import { q, q1 } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { accessibleWorkspaceIds, type AppEnv, type Auth } from '../lib/access.js';
import { dispatchDueReminders } from '../lib/notify.js';
import { addDays, todayIn } from '../lib/time.js';
import { serializeItems } from './items.js';
import { serializeTasks } from './tasks.js';
import { eventsInRange, partnerBusy } from './events.js';

export const homeRoutes = new Hono<AppEnv>();

/** Event categories that count as "Important dates" on the dashboard. */
export const IMPORTANT_CATEGORIES = ['birthday', 'anniversary', 'social', 'holiday', 'important'];

export const DEFAULT_WIDGETS = {
  grocery: { max: 6, size: 'm', hidden: false },
  home: { max: 5, size: 's', hidden: false },
  idea: { max: 5, size: 's', hidden: false },
} as const;

export async function dashboardPrefs(a: Auth) {
  const s = await q1<{ dashboard: any; share_availability: boolean }>('SELECT dashboard, share_availability FROM user_settings WHERE user_id = $1', [a.user.id]);
  const widgets = { ...DEFAULT_WIDGETS, ...(s?.dashboard?.widgets ?? {}) } as Record<'grocery' | 'home' | 'idea', { max: number; size: string; hidden?: boolean }>;
  return { widgets, share_availability: s?.share_availability ?? false };
}

const NEED_ORDER = `i.urgent DESC, i.flagged DESC, array_position(ARRAY['urgent','high','normal','low'], i.priority), i.due_date NULLS LAST, i.created_at DESC`;

homeRoutes.get('/dashboard', async (c) => {
  const a = requireAuth(c);
  await dispatchDueReminders(a.household.id);
  const tz = a.household.timezone;
  const today = todayIn(tz);
  const wss = accessibleWorkspaceIds(a);
  const prefs = await dashboardPrefs(a);

  const lists: Record<string, { items: any[]; need: number; stock: number }> = {};
  for (const module of ['grocery', 'home', 'idea'] as const) {
    const w = prefs.widgets[module];
    const [rows, counts] = await Promise.all([
      q(`SELECT i.* FROM items i WHERE i.workspace_id = ANY($1::uuid[]) AND i.module = $2 AND i.grocery_state = 'need' AND i.archived_at IS NULL ORDER BY ${NEED_ORDER} LIMIT $3`,
        [wss, module, w.max]),
      q1<any>(`SELECT count(*) FILTER (WHERE grocery_state = 'need')::int AS need, count(*) FILTER (WHERE grocery_state = 'stock')::int AS stock
                 FROM items WHERE workspace_id = ANY($1::uuid[]) AND module = $2 AND archived_at IS NULL`, [wss, module]),
    ]);
    lists[module] = { items: await serializeItems(a, rows), need: counts?.need ?? 0, stock: counts?.stock ?? 0 };
  }

  // Important dates: the next four months of birthdays, anniversaries, social events, holidays.
  const ahead = await eventsInRange(a, wss, today, addDays(today, 120));
  const important = ahead.filter((e: any) => e.yearly || IMPORTANT_CATEGORIES.includes(String(e.category ?? '').toLowerCase())).slice(0, 8);

  // To do & reminders: open to-dos plus list items with a date, overdue first.
  const horizon = addDays(today, 14);
  const [tasks, datedItems] = await Promise.all([
    q(`SELECT * FROM tasks WHERE workspace_id = ANY($1::uuid[]) AND archived_at IS NULL AND status NOT IN ('completed','archived')
        ORDER BY due_date NULLS LAST, array_position(ARRAY['urgent','high','normal','low'], priority), created_at DESC LIMIT 30`, [wss]),
    q(`SELECT i.* FROM items i WHERE i.workspace_id = ANY($1::uuid[]) AND i.archived_at IS NULL AND i.grocery_state = 'need'
        AND i.due_date IS NOT NULL AND i.due_date <= $2 ORDER BY i.due_date, i.due_time NULLS LAST LIMIT 20`, [wss, horizon]),
  ]);

  const [todayEvents, busy, unread] = await Promise.all([
    eventsInRange(a, wss, today, today),
    partnerBusy(a, today, today),
    q1<{ n: number }>(
      `SELECT count(*)::int AS n FROM threads t JOIN messages m ON m.thread_id = t.id
         LEFT JOIN thread_reads r ON r.thread_id = t.id AND r.user_id = $1
        WHERE t.workspace_id = ANY($2::uuid[]) AND m.author_id IS DISTINCT FROM $1 AND m.deleted_at IS NULL AND m.created_at > COALESCE(r.last_read_at, 'epoch')`,
      [a.user.id, wss],
    ),
  ]);

  return c.json({
    today,
    timezone: tz,
    prefs,
    lists,
    important_dates: important,
    todos: await serializeTasks(a, tasks),
    dated_items: await serializeItems(a, datedItems),
    today_events: todayEvents,
    partner_busy: busy,
    unread_messages: unread?.n ?? 0,
  });
});
