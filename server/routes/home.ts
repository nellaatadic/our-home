import { Hono } from 'hono';
import { z } from 'zod';
import { parse } from '../lib/http.js';
import { q, q1 } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { accessibleWorkspaceIds, type AppEnv, type Auth } from '../lib/access.js';
import { dispatchDueReminders } from '../lib/notify.js';
import { addDays, todayIn } from '../lib/time.js';
import { serializeItems } from './items.js';
import { serializeTasks } from './tasks.js';
import { eventsInRange, partnerBusy } from './events.js';
import { activePlans } from './plans.js';

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
  const widgets = { ...DEFAULT_WIDGETS, ...(s?.dashboard?.widgets ?? {}) } as Record<string, { max: number; size: string; hidden?: boolean }>;
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

  // One widget per list: the three built-in ones (by module) and each list the household made (by id).
  const custom = await q<{ id: string }>(
    `SELECT id FROM lists WHERE workspace_id = ANY($1::uuid[]) AND module = 'custom' AND event_id IS NULL AND archived_at IS NULL ORDER BY position, created_at`, [wss]);
  const keys: { key: string; module: string; listId: string | null }[] = [
    ...(['grocery', 'home', 'idea'] as const).map((m) => ({ key: m, module: m, listId: null })),
    ...custom.map((l) => ({ key: l.id, module: 'custom', listId: l.id })),
  ];
  const lists: Record<string, { items: any[]; need: number; stock: number; completed?: any[] }> = {};
  for (const k of keys) {
    const w = prefs.widgets[k.key] ?? (prefs.widgets[k.key] = { max: 5, size: 's', hidden: false });
    const [rows, counts, completed] = await Promise.all([
      q(`SELECT i.* FROM items i WHERE i.workspace_id = ANY($1::uuid[]) AND i.module = $2 AND ($4::uuid IS NULL OR i.list_id = $4)
           AND i.grocery_state = 'need' AND i.archived_at IS NULL ORDER BY ${NEED_ORDER} LIMIT $3`,
        [wss, k.module, w.max, k.listId]),
      q1<any>(`SELECT count(*) FILTER (WHERE grocery_state = 'need' AND archived_at IS NULL)::int AS need,
                      count(*) FILTER (WHERE grocery_state = 'stock' AND archived_at IS NULL)::int AS stock, max(updated_at) AS updated_at
                 FROM items WHERE workspace_id = ANY($1::uuid[]) AND module = $2 AND ($3::uuid IS NULL OR list_id = $3)`, [wss, k.module, k.listId]),
      recentlyCompleted(wss, k.module, k.listId),
    ]);
    lists[k.key] = {
      items: await serializeItems(a, rows), need: counts?.need ?? 0, stock: counts?.stock ?? 0, updated_at: counts?.updated_at ?? null,
      completed: await serializeItems(a, completed),
    } as any;
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
        WHERE t.workspace_id = ANY($2::uuid[]) AND m.author_id IS DISTINCT FROM $1 AND m.deleted_at IS NULL AND m.mirrored_from_id IS NULL AND m.created_at > COALESCE(r.last_read_at, 'epoch')`,
      [a.user.id, wss],
    ),
  ]);

  return c.json({
    cards: await homeCards(a),
    today,
    timezone: tz,
    prefs,
    lists,
    important_dates: important,
    plans: await activePlans(a),
    todos: await serializeTasks(a, tasks),
    dated_items: await serializeItems(a, datedItems),
    today_events: todayEvents,
    partner_busy: busy,
    unread_messages: unread?.n ?? 0,
  });
});

/**
 * Ticked-off items stay under "Completed" so a slip of the finger can be
 * undone. They go away once both of you have seen it: a quarter of an hour for
 * the one who ticked it, and until the partner has read the "completed" line.
 */
export async function recentlyCompleted(wss: string[], module: string, listId: string | null) {
  return q(
    `SELECT i.* FROM items i
      WHERE i.workspace_id = ANY($1::uuid[]) AND i.module = $2 AND ($3::uuid IS NULL OR i.list_id = $3)
        AND i.completed_at > now() - interval '3 days'
        AND (i.grocery_state = 'stock' OR i.archived_at IS NOT NULL)
        AND (i.completed_at > now() - interval '15 minutes'
             OR EXISTS (SELECT 1 FROM notifications n WHERE n.entity_type = 'item' AND n.entity_id = i.id AND n.type = 'activity'
                          AND n.dedupe_key LIKE 'completed:%' AND n.read_at IS NULL))
      ORDER BY i.completed_at DESC LIMIT 12`,
    [wss, module, listId],
  );
}

const CARD_TITLES = { dates: 'Important Dates', todos: 'To do & Reminders' } as const;
type CardKey = keyof typeof CARD_TITLES;

/** The Important Dates and To do cards: each has a chat (a shared topic) and its own emoji and colour. */
export async function homeCard(a: Auth, key: CardKey) {
  const existing = await q1<any>('SELECT * FROM topics WHERE workspace_id = $1 AND card_key = $2', [a.sharedWorkspaceId, key]);
  if (existing) return existing;
  return q1<any>(
    `INSERT INTO topics (workspace_id, title, card_key, created_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (workspace_id, card_key) WHERE card_key IS NOT NULL DO UPDATE SET title = topics.title RETURNING *`,
    [a.sharedWorkspaceId, CARD_TITLES[key], key, a.user.id],
  );
}

async function homeCards(a: Auth) {
  const out: Record<string, { topic_id: string; emoji: string | null; color: string | null; unread: number }> = {};
  for (const key of Object.keys(CARD_TITLES) as CardKey[]) {
    const t = await homeCard(a, key);
    const u = await q1<{ n: number }>(
      `SELECT count(*)::int AS n FROM threads th JOIN messages m ON m.thread_id = th.id
         LEFT JOIN thread_reads r ON r.thread_id = th.id AND r.user_id = $2
        WHERE th.entity_type = 'topic' AND th.entity_id = $1 AND m.author_id IS DISTINCT FROM $2 AND m.deleted_at IS NULL
          AND m.mirrored_from_id IS NULL AND m.created_at > COALESCE(r.last_read_at, 'epoch')`, [t.id, a.user.id]);
    out[key] = { topic_id: t.id, emoji: t.emoji, color: t.color, unread: u?.n ?? 0 };
  }
  return out;
}

homeRoutes.patch('/home/cards/:key', async (c) => {
  const a = requireAuth(c);
  const key = parse(z.enum(['dates', 'todos']), c.req.param('key'));
  const b = parse(z.object({ emoji: z.string().trim().min(1).max(16).optional(), color: z.string().regex(/^#[0-9a-f]{6}$/i).optional() }), await c.req.json());
  const t = await homeCard(a, key);
  await q('UPDATE topics SET emoji = COALESCE($2, emoji), color = COALESCE($3, color), updated_at = now() WHERE id = $1', [t.id, b.emoji ?? null, b.color ?? null]);
  return c.json({ cards: await homeCards(a) });
});
