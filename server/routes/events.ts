import { Hono } from 'hono';
import { z } from 'zod';
import { q, q1 } from '../db.js';
import { rateLimit, requireAuth } from '../lib/auth.js';
import { accessibleWorkspaceIds, assertMember, loadEntity, workspaceFor, type AppEnv, type Auth } from '../lib/access.js';
import { badRequest, dateStr, optText, parse, space, timeStr, uuid } from '../lib/http.js';
import { decorate } from '../lib/serialize.js';
import { logActivity, notify } from '../lib/notify.js';
import { addDays, todayIn, utcToZoned, zonedToUtc } from '../lib/time.js';
import { parseEventText, type EventDraft } from '../lib/nlp.js';
import { aiConfigured, extractEventsAI } from '../lib/ai.js';

export const eventRoutes = new Hono<AppEnv>();

export const eventInput = z.object({
  title: z.string().trim().min(1).max(300),
  date: dateStr,
  end_date: dateStr.nullish(),
  start_time: timeStr.nullish(),
  end_time: timeStr.nullish(),
  all_day: z.boolean().optional(),
  location: z.string().trim().max(500).optional(),
  description: z.string().max(10000).optional(),
  notes: z.string().max(5000).optional(),
  participants: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  category: optText(60),
  for_user_id: uuid.nullish(),
  source_type: z.enum(['manual', 'text']).optional(),
  yearly: z.boolean().optional(),
  is_plan: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});

/** Convert form fields (local wall-clock in household tz) to stored columns. */
export function eventColumns(b: Partial<z.infer<typeof eventInput>>, tz: string, existing?: any) {
  const date = b.date ?? existing?.start_date;
  const allDay = b.all_day ?? (b.start_time === undefined ? existing?.all_day ?? false : false);
  const startTime = b.start_time !== undefined ? b.start_time : existing?.starts_at ? utcToZoned(new Date(existing.starts_at), tz).time : null;
  const endTime = b.end_time !== undefined ? b.end_time : existing?.ends_at ? utcToZoned(new Date(existing.ends_at), tz).time : null;
  let endDate = b.end_date !== undefined ? b.end_date : existing?.end_date ?? null;
  if (b.date && b.end_date === undefined && existing && existing.end_date === existing.start_date) endDate = b.date;
  if (endDate && endDate < date) throw badRequest('The end date is before the start date');
  const cols: Record<string, unknown> = { start_date: date, end_date: endDate ?? date, all_day: allDay };
  if (allDay || !startTime) {
    Object.assign(cols, { starts_at: null, ends_at: null, time_unspecified: !allDay });
  } else {
    const starts = zonedToUtc(date, startTime, tz);
    let ends: Date | null = null;
    if (endTime) {
      ends = zonedToUtc(endDate ?? date, endTime, tz);
      if (ends < starts) ends = zonedToUtc(addDays(endDate ?? date, 1), endTime, tz); // e.g. 22:00–01:00
    }
    Object.assign(cols, { starts_at: starts, ends_at: ends, time_unspecified: false, end_date: ends ? utcToZoned(ends, tz).date : endDate ?? date });
  }
  for (const k of ['title', 'location', 'description', 'notes', 'participants', 'category', 'for_user_id', 'yearly', 'is_plan'] as const) if (b[k] !== undefined) cols[k] = b[k];
  if (b.tags !== undefined) cols.tags = [...new Set(b.tags.map((t) => t.trim()).filter(Boolean))];
  return cols;
}

export async function serializeEvents(a: Auth, rows: any[]) {
  if (!rows.length) return [];
  const exports = await q<any>(
    'SELECT event_id, google_calendar_id, exported_at, html_link FROM event_exports WHERE user_id = $1 AND event_id = ANY($2::uuid[]) ORDER BY exported_at DESC',
    [a.user.id, rows.map((r) => r.id)],
  );
  const names = new Map(a.members.map((m) => [m.id, m.display_name]));
  const tz = a.household.timezone;
  return (await decorate(a, 'event', rows)).map((e: any) => ({
    ...e,
    source_snapshot: undefined, // raw source data stays server-side
    start_time: e.starts_at ? utcToZoned(new Date(e.starts_at), tz).time : null,
    end_time: e.ends_at ? utcToZoned(new Date(e.ends_at), tz).time : null,
    imported_by_name: e.imported_by ? names.get(e.imported_by) ?? null : null,
    for_user_name: e.for_user_id ? names.get(e.for_user_id) ?? null : null,
    my_exports: exports.filter((x) => x.event_id === e.id),
  }));
}

/** Dates on which a yearly event (birthday, anniversary) falls inside [from, to]. 29 Feb → 28 Feb in other years. */
export function yearlyOccurrences(startDate: string, from: string, to: string): string[] {
  const md = startDate.slice(5);
  const out: string[] = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    if (y < Number(startDate.slice(0, 4))) continue;
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const d = `${y}-${md === '02-29' && !leap ? '02-28' : md}`;
    if (d >= from && d <= to) out.push(d);
  }
  return out;
}

/** Load events in a date range, expanding yearly ones into their occurrences. */
export async function eventsInRange(a: Auth, wss: string[], from: string, to: string, archived = false) {
  const rows = await q<any>(
    `SELECT * FROM events WHERE workspace_id = ANY($1::uuid[]) AND NOT yearly AND start_date <= $3 AND COALESCE(end_date, start_date) >= $2
       AND (CASE WHEN $4 THEN archived_at IS NOT NULL ELSE archived_at IS NULL END)
     ORDER BY start_date, all_day DESC, starts_at NULLS FIRST LIMIT 2000`,
    [wss, from, to, archived],
  );
  const yearly = await q<any>(
    `SELECT * FROM events WHERE workspace_id = ANY($1::uuid[]) AND yearly AND start_date <= $2
       AND (CASE WHEN $3 THEN archived_at IS NOT NULL ELSE archived_at IS NULL END) LIMIT 500`,
    [wss, to, archived],
  );
  const serialized = await serializeEvents(a, [...rows, ...yearly]);
  const plain = serialized.slice(0, rows.length);
  const expanded = serialized.slice(rows.length).flatMap((e: any) =>
    yearlyOccurrences(e.start_date, from, to).map((d) => ({
      ...e, start_date: d, end_date: d, occurrence_of: e.start_date,
      years: Number(d.slice(0, 4)) - Number(e.start_date.slice(0, 4)),
    })),
  );
  return [...plain, ...expanded].sort((x: any, y: any) => (x.start_date < y.start_date ? -1 : x.start_date > y.start_date ? 1 : (x.start_time ?? '') < (y.start_time ?? '') ? -1 : 1));
}

/**
 * The partner's private time as anonymous "Busy" blocks — only if the partner
 * turned on "Show my private time as Busy". Only times are selected: no ids,
 * titles, places or notes ever leave their private space.
 */
export async function partnerBusy(a: Auth, from: string, to: string) {
  if (!a.partner) return [];
  const p = await q1<any>(
    `SELECT w.id FROM workspaces w JOIN user_settings s ON s.user_id = w.owner_user_id
      WHERE w.kind = 'personal' AND w.owner_user_id = $1 AND w.household_id = $2 AND s.share_availability`,
    [a.partner.id, a.household.id],
  );
  if (!p) return [];
  const rows = await q<any>(
    `SELECT start_date, end_date, all_day, starts_at, ends_at FROM events
      WHERE workspace_id = $1 AND archived_at IS NULL AND NOT yearly AND start_date <= $3 AND COALESCE(end_date, start_date) >= $2 AND NOT time_unspecified
      ORDER BY start_date, starts_at LIMIT 500`,
    [p.id, from, to],
  );
  const tz = a.household.timezone;
  return rows.map((r) => ({
    user_id: a.partner!.id, start_date: r.start_date, end_date: r.end_date, all_day: r.all_day,
    start_time: r.starts_at ? utcToZoned(new Date(r.starts_at), tz).time : null,
    end_time: r.ends_at ? utcToZoned(new Date(r.ends_at), tz).time : null,
  }));
}

eventRoutes.get('/events', async (c) => {
  const a = requireAuth(c);
  const f = parse(z.object({ from: dateStr, to: dateStr, space: z.enum(['me', 'us', 'all']).optional(), archived: z.enum(['true']).optional(), busy: z.enum(['true']).optional() }), c.req.query());
  if (f.to < f.from || f.to > addDays(f.from, 800)) throw badRequest('Choose a shorter date range');
  const wss = f.space === 'me' ? [a.personalWorkspaceId] : f.space === 'us' ? [a.sharedWorkspaceId] : accessibleWorkspaceIds(a);
  const events = await eventsInRange(a, wss, f.from, f.to, f.archived === 'true');
  return c.json({ events, busy: f.busy === 'true' ? await partnerBusy(a, f.from, f.to) : [], timezone: a.household.timezone });
});

eventRoutes.post('/spaces/:space/events', async (c) => {
  const a = requireAuth(c);
  const ws = workspaceFor(a, parse(space, c.req.param('space')));
  const b = parse(eventInput, await c.req.json());
  assertMember(a, b.for_user_id);
  const cols = { ...eventColumns(b, a.household.timezone), source_type: b.source_type ?? 'manual' };
  const keys = Object.keys(cols);
  const row = await q1<any>(
    `INSERT INTO events (workspace_id, created_by, updated_by, ${keys.join(', ')}) VALUES ($1,$2,$2, ${keys.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING *`,
    [ws, a.user.id, ...keys.map((k) => (cols as any)[k])],
  );
  await logActivity(ws, 'event', row.id, a.user.id, 'created', `Created event “${row.title}”`);
  if (ws === a.sharedWorkspaceId && a.partner) {
    await notify({ recipients: [a.partner.id], actorId: a.user.id, workspaceId: ws, type: 'calendar', title: `${a.user.display_name} added “${row.title}” to the US calendar`, entityType: 'event', entityId: row.id });
  }
  return c.json({ event: (await serializeEvents(a, [row]))[0] }, 201);
});

eventRoutes.get('/events/:id', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'event', c.req.param('id'));
  const [ev] = await serializeEvents(a, [row]);
  const [activity, tasks, allExports] = await Promise.all([
    q(`SELECT ac.action, ac.summary, ac.created_at, u.display_name AS actor_name FROM activity ac LEFT JOIN users u ON u.id = ac.actor_id WHERE entity_type = 'event' AND entity_id = $1 ORDER BY ac.created_at DESC LIMIT 50`, [row.id]),
    q(`SELECT id, title, status, due_date FROM tasks WHERE related_event_id = $1 AND workspace_id = ANY($2::uuid[]) AND archived_at IS NULL`, [row.id, accessibleWorkspaceIds(a)]),
    q(`SELECT ex.exported_at, ex.google_calendar_id, ex.html_link, gc.summary AS calendar_name, gcon.google_email
         FROM event_exports ex LEFT JOIN google_connections gcon ON gcon.id = ex.connection_id
         LEFT JOIN google_calendars gc ON gc.connection_id = ex.connection_id AND gc.google_calendar_id = ex.google_calendar_id
        WHERE ex.event_id = $1 AND ex.user_id = $2 ORDER BY ex.exported_at DESC`, [row.id, a.user.id]),
  ]);
  await q(`INSERT INTO recently_viewed (user_id, entity_type, entity_id) VALUES ($1,'event',$2) ON CONFLICT (user_id, entity_type, entity_id) DO UPDATE SET viewed_at = now()`, [a.user.id, row.id]);
  return c.json({ event: { ...ev, activity, follow_up_tasks: tasks, my_exports: allExports } });
});

eventRoutes.patch('/events/:id', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'event', c.req.param('id'));
  const b = parse(eventInput.partial(), await c.req.json());
  assertMember(a, b.for_user_id);
  const cols: Record<string, unknown> = eventColumns(b, a.household.timezone, row);
  // Edits apply to OUR HOME's copy only. Google-sourced copies are flagged so a refresh never overwrites them silently.
  if (row.source_type === 'google') cols.locally_modified = true;
  const keys = Object.keys(cols);
  const updated = await q1<any>(
    `UPDATE events SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')}, updated_at = now(), updated_by = $2 WHERE id = $1 RETURNING *`,
    [row.id, a.user.id, ...keys.map((k) => cols[k])],
  );
  const changed = Object.keys(b).filter((k) => k !== 'source_type');
  await logActivity(row.workspace_id, 'event', row.id, a.user.id, 'updated', `Changed ${changed.join(', ').replace(/_/g, ' ')}`);
  if (row.workspace_id === a.sharedWorkspaceId && (b.date || b.start_time !== undefined) && a.partner) {
    await notify({ recipients: [a.partner.id], actorId: a.user.id, workspaceId: row.workspace_id, type: 'calendar', title: `${a.user.display_name} moved “${updated.title}”`, entityType: 'event', entityId: row.id });
  }
  return c.json({ event: (await serializeEvents(a, [updated]))[0] });
});

eventRoutes.post('/events/:id/follow-up', async (c) => {
  const a = requireAuth(c);
  const row = await loadEntity<any>(a, 'event', c.req.param('id'));
  const b = parse(z.object({ title: z.string().trim().min(1).max(200), due_date: dateStr.nullish() }), await c.req.json());
  const task = await q1<any>(
    `INSERT INTO tasks (workspace_id, title, due_date, related_event_id, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$5) RETURNING *`,
    [row.workspace_id, b.title, b.due_date ?? null, row.id, a.user.id],
  );
  await logActivity(row.workspace_id, 'task', task.id, a.user.id, 'created', `Follow-up for “${row.title}”`);
  return c.json({ task }, 201);
});

/** Natural-language → event drafts. Nothing is saved here. */
eventRoutes.post('/events/parse', async (c) => {
  const a = requireAuth(c);
  const b = parse(z.object({ text: z.string().trim().min(1).max(8000), engine: z.enum(['auto', 'rules']).optional() }), await c.req.json());
  const tz = a.household.timezone;
  const members = a.members.map((m) => m.display_name);
  let drafts: EventDraft[] | null = null;
  let engine: 'ai' | 'rules' = 'rules';
  let note: string | null = null;
  if (aiConfigured() && b.engine !== 'rules') {
    try {
      await rateLimit(`ai:${a.user.id}`, 60, 3600);
      const today = todayIn(tz);
      const weekday = new Date(`${today}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
      const ai = await extractEventsAI(b.text, { today, weekday, timezone: tz, members });
      if (ai) {
        engine = 'ai';
        drafts = ai.map((e) => ({
          source_text: e.source_text, title: e.title, date: e.date_ambiguous ? null : validDate(e.date), start_time: validTime(e.start_time), end_time: validTime(e.end_time),
          duration_minutes: e.duration_minutes, time_hint: e.time_hint, location: e.location, participants: e.participants, description: e.description,
          category: e.category, for_person: e.for_person,
          issues: [
            ...(e.date_ambiguous ? [{ field: 'date' as const, code: 'ambiguous_date' as const, message: 'This date is ambiguous. Choose one.', options: e.date_options.filter(validDate).map((d) => ({ label: d, value: d })) }] : []),
            ...(!e.date_ambiguous && !validDate(e.date) ? [{ field: 'date' as const, code: 'missing_date' as const, message: 'No date found. Choose a date.' }] : []),
            ...(e.time_hint && !e.start_time ? [{ field: 'time' as const, code: 'part_of_day' as const, message: `Only “${e.time_hint}” was given — the time is left unspecified.` }] : []),
          ],
        }));
      } else note = 'AI could not read this text; used the built-in parser instead.';
    } catch (err) {
      note = 'AI service unavailable; used the built-in parser instead.';
      console.error('ai parse failed', (err as Error).message);
    }
  }
  if (!drafts) drafts = parseEventText(b.text, { timezone: tz, memberNames: members });
  const withPeople = drafts.map((d) => ({ ...d, for_user_id: a.members.find((m) => m.display_name === d.for_person)?.id ?? null }));
  return c.json({ drafts: withPeople, engine, note, message: `${withPeople.length} calendar event${withPeople.length === 1 ? '' : 's'} identified.` });
});

function validDate(d: string | null) {
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) ? d : null;
}
function validTime(t: string | null) {
  return t && /^([01]\d|2[0-3]):[0-5]\d$/.test(t) ? t : null;
}
