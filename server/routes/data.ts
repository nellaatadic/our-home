import { Hono } from 'hono';
import { q, q1 } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { accessibleWorkspaceIds, type AppEnv } from '../lib/access.js';
import { addDays, addMonths, todayIn, weekdayOf } from '../lib/time.js';
import { eventsInRange, partnerBusy } from './events.js';

/**
 * Data analysis. Every figure is computed only from the viewer's two
 * workspaces (their private space and US); the partner's private space is
 * never read, except their opt-in anonymous "Busy" times for calendar load.
 */
export const dataRoutes = new Hono<AppEnv>();

dataRoutes.get('/data', async (c) => {
  const a = requireAuth(c);
  const wss = accessibleWorkspaceIds(a);
  const today = todayIn(a.household.timezone);
  const monthStart = `${today.slice(0, 7)}-01`;
  const from6 = addMonths(monthStart, -5);
  const names = new Map(a.members.map((m) => [m.id, m.display_name]));

  // ---------------------------------------------------------------- spending
  // Expenses, plus confirmed receipts that were not turned into an expense.
  const spendRows = await q<any>(
    `SELECT e.purchase_date AS date, e.amount_cents AS cents, COALESCE(NULLIF(e.category, ''), 'Other') AS category, e.purchaser_id AS payer, e.workspace_id
       FROM expenses e WHERE e.workspace_id = ANY($1::uuid[]) AND e.archived_at IS NULL AND e.purchase_date >= $2
     UNION ALL
     SELECT COALESCE(r.purchase_date, r.created_at::date), r.total_cents, 'Groceries', r.uploaded_by, r.workspace_id
       FROM receipts r WHERE r.workspace_id = ANY($1::uuid[]) AND r.status = 'confirmed' AND r.total_cents IS NOT NULL
        AND COALESCE(r.purchase_date, r.created_at::date) >= $2
        AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.receipt_id = r.id)`,
    [wss, from6],
  );
  const months: { month: string; cents: number }[] = [];
  for (let i = 0; i < 6; i++) months.push({ month: addMonths(from6, i).slice(0, 7), cents: 0 });
  const byCategory = new Map<string, number>();
  const byPayer = new Map<string, number>();
  for (const r of spendRows) {
    const m = months.find((x) => x.month === String(r.date).slice(0, 7));
    if (m) m.cents += Number(r.cents);
    byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + Number(r.cents));
    const who = names.get(r.payer) ?? 'Someone';
    byPayer.set(who, (byPayer.get(who) ?? 0) + Number(r.cents));
  }
  // Shared expenses: who paid vs who is responsible → who owes whom.
  const alloc = await q<any>(
    `SELECT e.purchaser_id, ea.user_id, ea.amount_cents FROM expenses e JOIN expense_allocations ea ON ea.expense_id = e.id
      WHERE e.workspace_id = $1 AND e.archived_at IS NULL`,
    [a.sharedWorkspaceId],
  );
  const net = new Map<string, number>(a.members.map((m) => [m.id, 0]));
  for (const r of alloc) {
    if (r.user_id === r.purchaser_id) continue;
    net.set(r.purchaser_id, (net.get(r.purchaser_id) ?? 0) + Number(r.amount_cents));
    net.set(r.user_id, (net.get(r.user_id) ?? 0) - Number(r.amount_cents));
  }
  const creditor = [...net.entries()].sort((x, y) => y[1] - x[1])[0];
  const balance = creditor && creditor[1] > 0 && a.partner
    ? { owed_to: names.get(creditor[0]), owed_by: names.get(creditor[0] === a.user.id ? a.partner.id : a.user.id), cents: creditor[1] }
    : null;

  // ---------------------------------------------------------- grocery habits
  const since = addDays(today, -90);
  const [bought, ranOut, waits] = await Promise.all([
    q<any>(
      `SELECT lower(i.title) AS key, min(i.title) AS title, count(*)::int AS n FROM activity ac JOIN items i ON i.id = ac.entity_id
        WHERE ac.entity_type = 'item' AND ac.action IN ('purchased','restocked') AND ac.workspace_id = ANY($1::uuid[]) AND i.module = 'grocery'
          AND ac.created_at >= $2::date GROUP BY 1 ORDER BY n DESC, title LIMIT 10`,
      [wss, since],
    ),
    q<any>(
      `SELECT lower(i.title) AS key, min(i.title) AS title, count(*)::int AS n FROM activity ac JOIN items i ON i.id = ac.entity_id
        WHERE ac.entity_type = 'item' AND ac.action = 'needed' AND ac.workspace_id = ANY($1::uuid[]) AND i.module = 'grocery'
          AND ac.created_at >= $2::date GROUP BY 1 ORDER BY n DESC, title LIMIT 8`,
      [wss, since],
    ),
    // Time from "added / ran out" to "bought", per purchase.
    q<any>(
      `SELECT avg(extract(epoch FROM (x.created_at - x.prev_at)) / 86400)::float AS days, count(*)::int AS n FROM (
         SELECT ac.action, ac.created_at,
                lag(ac.created_at) OVER (PARTITION BY ac.entity_id ORDER BY ac.created_at) AS prev_at,
                lag(ac.action) OVER (PARTITION BY ac.entity_id ORDER BY ac.created_at) AS prev_action
           FROM activity ac JOIN items i ON i.id = ac.entity_id
          WHERE ac.entity_type = 'item' AND ac.workspace_id = ANY($1::uuid[]) AND i.module = 'grocery'
            AND ac.action IN ('created','needed','purchased','restocked') AND ac.created_at >= $2::date
       ) x WHERE x.action IN ('purchased','restocked') AND x.prev_action IN ('created','needed')`,
      [wss, since],
    ),
  ]);

  // ------------------------------------------------------------ open topics
  const [todoRows, decisions, chats] = await Promise.all([
    q<any>(
      `SELECT assignee, assigned_user_id, due_date FROM tasks
        WHERE workspace_id = ANY($1::uuid[]) AND archived_at IS NULL AND status NOT IN ('completed','archived')`,
      [wss],
    ),
    q<any>(
      `SELECT count(*) FILTER (WHERE decision_status IN ('considering','discussing'))::int AS deciding,
              count(*) FILTER (WHERE flagged)::int AS flagged,
              count(*) FILTER (WHERE urgent)::int AS urgent,
              count(*) FILTER (WHERE due_date < $2)::int AS overdue_items
         FROM items WHERE workspace_id = ANY($1::uuid[]) AND archived_at IS NULL AND grocery_state = 'need'`,
      [wss, today],
    ),
    q<any>(
      `SELECT DISTINCT ON (t.id) t.id, t.entity_type, t.entity_id, m.author_id, m.created_at
         FROM threads t JOIN messages m ON m.thread_id = t.id
        WHERE t.workspace_id = ANY($1::uuid[]) AND m.deleted_at IS NULL
        ORDER BY t.id, m.created_at DESC`,
      [wss],
    ),
  ]);
  const todos = { mine: 0, partner: 0, both: 0, unassigned: 0, overdue: 0, total: todoRows.length };
  for (const t of todoRows) {
    if (t.assignee === 'both') todos.both++;
    else if (t.assignee === 'user' && t.assigned_user_id === a.user.id) todos.mine++;
    else if (t.assignee === 'user') todos.partner++;
    else todos.unassigned++;
    if (t.due_date && t.due_date < today) todos.overdue++;
  }
  const waitingOnMe = chats.filter((x) => x.author_id && x.author_id !== a.user.id).length;
  const waitingOnPartner = chats.filter((x) => x.author_id === a.user.id).length;

  // ---------------------------------------------------------- calendar load
  const weekStart = addDays(today, -((weekdayOf(today) + 6) % 7)); // Monday
  const end = addDays(weekStart, 8 * 7 - 1);
  const [evs, busy] = await Promise.all([eventsInRange(a, wss, weekStart, end), partnerBusy(a, weekStart, end)]);
  const weeks = Array.from({ length: 8 }, (_, i) => ({ week: addDays(weekStart, i * 7), shared: 0, mine: 0, partner_busy: 0 }));
  const bucket = (d: string) => weeks[Math.floor((Date.parse(d) - Date.parse(weekStart)) / (7 * 86400000))];
  for (const e of evs) {
    const w = bucket(e.start_date);
    if (!w) continue;
    if (e.space === 'us') w.shared++;
    else w.mine++;
  }
  for (const b of busy) {
    const w = bucket(b.start_date);
    if (w) w.partner_busy++;
  }

  return c.json({
    currency: a.household.currency,
    partner_name: a.partner?.display_name ?? null,
    partner_shares_availability: a.partner ? Boolean((await q1<any>('SELECT share_availability FROM user_settings WHERE user_id = $1', [a.partner.id]))?.share_availability) : false,
    spending: {
      months,
      by_category: [...byCategory.entries()].map(([name, cents]) => ({ name, cents })).sort((x, y) => y.cents - x.cents).slice(0, 8),
      by_payer: [...byPayer.entries()].map(([name, cents]) => ({ name, cents })).sort((x, y) => y.cents - x.cents),
      total_cents: months.reduce((s, m) => s + m.cents, 0),
      balance,
    },
    groceries: {
      most_bought: bought.map((r) => ({ title: r.title, n: r.n })),
      ran_out: ranOut.map((r) => ({ title: r.title, n: r.n })),
      avg_days_to_buy: waits[0]?.n ? Math.round(waits[0].days * 10) / 10 : null,
      purchases_counted: waits[0]?.n ?? 0,
    },
    open: { todos, ...decisions[0], waiting_on_me: waitingOnMe, waiting_on_partner: waitingOnPartner },
    calendar: { weeks },
  });
});
