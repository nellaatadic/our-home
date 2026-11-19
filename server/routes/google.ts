import { Hono } from 'hono';
import { z } from 'zod';
import { q, q1 } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { loadEntity, type AppEnv, type Auth } from '../lib/access.js';
import { badRequest, conflict, dateStr, HttpError, notFound, parse, timeStr, uuid } from '../lib/http.js';
import { logActivity, notify } from '../lib/notify.js';
import { addDays, addMonths, todayIn, utcToZoned, zonedToUtc } from '../lib/time.js';
import {
  completeAuth, consumeState, googleConfig, insertGoogleEvent, listCalendarEvents, normalizeGoogleEvent, revokeConnection, startAuth,
  syncCalendarList, WRITE_SCOPE, type SourceSnapshot,
} from '../lib/google.js';
import { serializeEvents } from './events.js';

export const googleRoutes = new Hono<AppEnv>();

const TARGET = z.enum(['us', 'me']);

async function ownConnection(a: Auth, id: string) {
  const conn = await q1<any>('SELECT * FROM google_connections WHERE id = $1 AND user_id = $2', [parse(uuid, id), a.user.id]);
  if (!conn) throw notFound();
  return conn;
}

async function ownCalendar(a: Auth, calendarRowId: string) {
  const cal = await q1<any>(
    `SELECT gc.*, row_to_json(con.*) AS conn FROM google_calendars gc JOIN google_connections con ON con.id = gc.connection_id
      WHERE gc.id = $1 AND con.user_id = $2 AND con.status <> 'disconnected'`,
    [calendarRowId, a.user.id],
  );
  if (!cal) throw notFound('Unknown calendar');
  return cal;
}

/** Status for the settings/calendar screens. Never includes tokens. */
googleRoutes.get('/google/status', async (c) => {
  const a = requireAuth(c);
  const cfg = googleConfig();
  const conns = await q<any>(
    `SELECT id, google_email, status, last_error, scopes, created_at FROM google_connections WHERE user_id = $1 AND status <> 'disconnected' ORDER BY created_at`,
    [a.user.id],
  );
  const cals = conns.length
    ? await q<any>('SELECT id, connection_id, google_calendar_id, summary, color, access_role, is_primary, selected, last_import_at FROM google_calendars WHERE connection_id = ANY($1::uuid[]) ORDER BY is_primary DESC, summary', [conns.map((x) => x.id)])
    : [];
  return c.json({
    configured: cfg.configured,
    missing: cfg.missing,
    connections: conns.map((x) => ({
      id: x.id, google_email: x.google_email, status: x.status, last_error: x.last_error, created_at: x.created_at,
      can_export: String(x.scopes).split(' ').includes(WRITE_SCOPE),
      calendars: cals.filter((k) => k.connection_id === x.id).map((k) => ({ ...k, writable: ['owner', 'writer'].includes(k.access_role) })),
    })),
  });
});

googleRoutes.post('/google/connect', async (c) => {
  const a = requireAuth(c);
  const b = parse(z.object({ purpose: z.enum(['import', 'export']).default('import'), connection_id: uuid.optional() }), await c.req.json().catch(() => ({})));
  const hint = b.connection_id ? (await ownConnection(a, b.connection_id)).google_email : undefined;
  return c.json({ url: await startAuth(a.user.id, b.purpose, hint) });
});

/** OAuth redirect target (top-level navigation from Google). */
googleRoutes.get('/google/callback', async (c) => {
  const a = c.get('auth');
  const url = new URL(c.req.url);
  const back = (params: Record<string, string>) => c.redirect(`/calendar/connections?${new URLSearchParams(params)}`, 302);
  if (url.searchParams.get('error')) return back({ google_error: url.searchParams.get('error') === 'access_denied' ? 'You declined access in Google.' : 'Google sign-in was cancelled.' });
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const st = state ? await consumeState(state) : null;
  if (!st || !code) return back({ google_error: 'This sign-in link expired. Please try again.' });
  if (!a || a.user.id !== st.userId) return back({ google_error: 'Please sign in to OUR HOME as the same person who started connecting.' });
  try {
    const conn = await completeAuth(st.userId, code, st.verifier);
    return back({ connected: conn.google_email });
  } catch (e) {
    return back({ google_error: e instanceof HttpError ? e.message : 'Connecting Google failed.' });
  }
});

googleRoutes.post('/google/connections/:id/sync', async (c) => {
  const a = requireAuth(c);
  const conn = await ownConnection(a, c.req.param('id'));
  const n = await syncCalendarList(conn);
  return c.json({ calendars: n });
});

googleRoutes.post('/google/connections/:id/disconnect', async (c) => {
  const a = requireAuth(c);
  const conn = await ownConnection(a, c.req.param('id'));
  await revokeConnection(conn);
  // Imported copies stay (they are OUR HOME events now); only credentials are removed.
  await q(`UPDATE google_connections SET status = 'disconnected', access_token_enc = NULL, refresh_token_enc = NULL, token_expires_at = NULL, updated_at = now() WHERE id = $1`, [conn.id]);
  await q('UPDATE google_calendars SET selected = false WHERE connection_id = $1', [conn.id]);
  return c.json({ ok: true });
});

googleRoutes.patch('/google/calendars/:id', async (c) => {
  const a = requireAuth(c);
  const cal = await ownCalendar(a, parse(uuid, c.req.param('id')));
  const b = parse(z.object({ selected: z.boolean() }), await c.req.json());
  await q('UPDATE google_calendars SET selected = $1 WHERE id = $2', [b.selected, cal.id]);
  return c.json({ ok: true });
});

function importWindow(a: Auth) {
  const tz = a.household.timezone;
  const today = todayIn(tz);
  return { from: today, to: addMonths(today, 6), timeMin: zonedToUtc(today, '00:00', tz), timeMax: zonedToUtc(addMonths(today, 6), '23:59', tz) };
}

async function fetchSelected(a: Auth, calendarIds: string[]) {
  const win = importWindow(a);
  const out: { cal: any; snapshot: SourceSnapshot; google_event_id: string }[] = [];
  const errors: { calendar: string; message: string }[] = [];
  for (const id of calendarIds) {
    const cal = await ownCalendar(a, id);
    try {
      const events = await listCalendarEvents(cal.conn, cal.google_calendar_id, win.timeMin, win.timeMax);
      for (const ev of events) out.push({ cal, snapshot: normalizeGoogleEvent(ev, a.household.timezone), google_event_id: ev.id });
    } catch (e) {
      errors.push({ calendar: cal.summary, message: (e as Error).message });
    }
  }
  return { events: out, errors, window: win };
}

/** Step 1 of import: list eligible events (today → +6 months) from chosen calendars. Nothing is saved. */
googleRoutes.post('/google/import/preview', async (c) => {
  const a = requireAuth(c);
  const b = parse(z.object({ calendar_ids: z.array(uuid).min(1).max(20), target: TARGET.default('us') }), await c.req.json());
  const ws = b.target === 'us' ? a.sharedWorkspaceId : a.personalWorkspaceId;
  const { events, errors, window } = await fetchSelected(a, b.calendar_ids);
  const existing = events.length
    ? await q<any>(
      `SELECT id, google_connection_id, google_calendar_id, google_event_id, archived_at FROM events WHERE workspace_id = $1 AND google_event_id = ANY($2::text[])`,
      [ws, events.map((e) => e.google_event_id)],
    )
    : [];
  const key = (conn: string, cal: string, ev: string) => `${conn}|${cal}|${ev}`;
  const ex = new Map(existing.map((e) => [key(e.google_connection_id, e.google_calendar_id, e.google_event_id), e]));
  return c.json({
    window, errors,
    events: events.map((e) => {
      const found = ex.get(key(e.cal.connection_id, e.cal.google_calendar_id, e.google_event_id));
      return {
        calendar_id: e.cal.id, calendar_name: e.cal.summary, google_event_id: e.google_event_id,
        ...e.snapshot,
        status: found ? (found.archived_at ? 'removed_from_space' : 'already_imported') : 'new',
        existing_event_id: found?.id ?? null,
        suggested_availability_only: e.snapshot.restricted,
      };
    }),
  });
});

function columnsFromSnapshot(s: SourceSnapshot, availabilityOnly: boolean, calName: string) {
  return {
    title: availabilityOnly ? `Busy (${calName})` : s.title,
    description: availabilityOnly ? '' : s.description.slice(0, 10000),
    location: availabilityOnly ? '' : s.location.slice(0, 500),
    participants: availabilityOnly ? [] : s.participants,
    all_day: s.all_day,
    time_unspecified: false,
    start_date: s.start_date,
    end_date: s.end_date,
    starts_at: s.starts_at,
    ends_at: s.ends_at,
    availability_only: availabilityOnly,
    google_recurring_event_id: s.recurring_event_id,
    google_recurrence: s.recurrence,
  };
}

/** Step 2 of import: create independent OUR HOME copies of the selected events. */
googleRoutes.post('/google/import', async (c) => {
  const a = requireAuth(c);
  const b = parse(
    z.object({
      target: TARGET.default('us'),
      selections: z.array(z.object({ calendar_id: uuid, google_event_id: z.string().min(1).max(1024), availability_only: z.boolean().default(false) })).min(1).max(2000),
    }),
    await c.req.json(),
  );
  const ws = b.target === 'us' ? a.sharedWorkspaceId : a.personalWorkspaceId;
  const calIds = [...new Set(b.selections.map((s) => s.calendar_id))];
  // Re-read from Google on the server: the client cannot inject event content.
  const { events, errors } = await fetchSelected(a, calIds);
  const wanted = new Map(b.selections.map((s) => [`${s.calendar_id}|${s.google_event_id}`, s]));
  let imported = 0, skipped = 0;
  for (const e of events) {
    const sel = wanted.get(`${e.cal.id}|${e.google_event_id}`);
    if (!sel) continue;
    const cols = columnsFromSnapshot(e.snapshot, sel.availability_only || false, e.cal.summary);
    const row = await q1<any>(
      `INSERT INTO events (workspace_id, title, description, location, participants, all_day, time_unspecified, start_date, end_date, starts_at, ends_at,
          availability_only, google_recurring_event_id, google_recurrence, source_type, google_connection_id, google_calendar_id, google_calendar_name,
          google_event_id, source_snapshot, source_updated_at, imported_at, imported_by, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'google',$15,$16,$17,$18,$19,$20,now(),$21,$21,$21)
       ON CONFLICT (workspace_id, google_connection_id, google_calendar_id, google_event_id) WHERE google_event_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [ws, cols.title, cols.description, cols.location, cols.participants, cols.all_day, cols.time_unspecified, cols.start_date, cols.end_date,
        cols.starts_at, cols.ends_at, cols.availability_only, cols.google_recurring_event_id, cols.google_recurrence, e.cal.connection_id,
        e.cal.google_calendar_id, e.cal.summary, e.google_event_id, JSON.stringify(e.snapshot), e.snapshot.updated, a.user.id],
    );
    if (row) {
      imported++;
      await logActivity(ws, 'event', row.id, a.user.id, 'imported', `Imported from Google Calendar “${e.cal.summary}”`);
    } else skipped++;
  }
  await q('UPDATE google_calendars SET last_import_at = now(), selected = true WHERE id = ANY($1::uuid[])', [calIds]);
  if (imported && ws === a.sharedWorkspaceId && a.partner) {
    await notify({ recipients: [a.partner.id], actorId: a.user.id, workspaceId: ws, type: 'calendar', title: `${a.user.display_name} added ${imported} event${imported === 1 ? '' : 's'} to the US calendar` });
  }
  return c.json({ imported, skipped_duplicates: skipped, errors });
});

const DIFF_FIELDS: (keyof SourceSnapshot)[] = ['title', 'description', 'location', 'all_day', 'start_date', 'end_date', 'starts_at', 'ends_at'];

/**
 * Refresh step 1: compare connected calendars with what was imported.
 * Reports new events, changes at the source (with field-level differences),
 * and events that disappeared at the source. Changes nothing.
 */
googleRoutes.post('/google/refresh/preview', async (c) => {
  const a = requireAuth(c);
  const cals = await q<any>(
    `SELECT gc.id FROM google_calendars gc JOIN google_connections con ON con.id = gc.connection_id
      WHERE con.user_id = $1 AND con.status = 'active' AND (gc.selected OR EXISTS (
        SELECT 1 FROM events e WHERE e.google_connection_id = con.id AND e.google_calendar_id = gc.google_calendar_id AND e.imported_by = $1))`,
    [a.user.id],
  );
  if (!cals.length) return c.json({ new_events: [], changed: [], removed: [], errors: [] });
  const { events, errors, window } = await fetchSelected(a, cals.map((x) => x.id));
  const imported = await q<any>(
    `SELECT * FROM events WHERE imported_by = $1 AND google_event_id IS NOT NULL AND workspace_id = ANY($2::uuid[])`,
    [a.user.id, [a.personalWorkspaceId, a.sharedWorkspaceId]],
  );
  const bySource = new Map<string, any[]>();
  for (const ev of imported) {
    const k = `${ev.google_connection_id}|${ev.google_calendar_id}|${ev.google_event_id}`;
    bySource.set(k, [...(bySource.get(k) ?? []), ev]);
  }
  const seen = new Set<string>();
  const changed: any[] = [];
  const newEvents: any[] = [];
  for (const e of events) {
    const k = `${e.cal.connection_id}|${e.cal.google_calendar_id}|${e.google_event_id}`;
    seen.add(k);
    const copies = bySource.get(k);
    if (!copies) {
      if (e.cal.selected !== false) newEvents.push({ calendar_id: e.cal.id, calendar_name: e.cal.summary, google_event_id: e.google_event_id, ...e.snapshot, suggested_availability_only: e.snapshot.restricted });
      continue;
    }
    for (const copy of copies) {
      if (copy.archived_at) continue; // deleted from the space: never resurrect
      const prev = (copy.source_snapshot ?? {}) as SourceSnapshot;
      const diffs = DIFF_FIELDS.filter((f) => JSON.stringify(prev[f] ?? null) !== JSON.stringify(e.snapshot[f] ?? null))
        .filter((f) => !(copy.availability_only && ['title', 'description', 'location'].includes(f)))
        .map((f) => ({ field: f, before: prev[f] ?? null, after: e.snapshot[f] ?? null }));
      if (diffs.length) {
        changed.push({
          event_id: copy.id, space: copy.workspace_id === a.sharedWorkspaceId ? 'us' : 'me', title: copy.title, calendar_name: e.cal.summary,
          locally_modified: copy.locally_modified, differences: diffs, suggested_action: copy.locally_modified ? 'keep' : 'replace',
        });
      }
    }
  }
  const removed = imported
    .filter((ev) => !ev.archived_at && ev.start_date >= window.from && ev.start_date <= window.to)
    .filter((ev) => cals.length && !seen.has(`${ev.google_connection_id}|${ev.google_calendar_id}|${ev.google_event_id}`))
    .filter((ev) => !errors.length) // if a calendar failed to load we cannot tell what was removed
    .map((ev) => ({ event_id: ev.id, title: ev.title, start_date: ev.start_date, space: ev.workspace_id === a.sharedWorkspaceId ? 'us' : 'me', locally_modified: ev.locally_modified }));
  return c.json({ new_events: newEvents, changed, removed, errors, window });
});

/** Refresh step 2: apply only what the user chose. */
googleRoutes.post('/google/refresh/apply', async (c) => {
  const a = requireAuth(c);
  const b = parse(
    z.object({
      changes: z.array(z.object({ event_id: uuid, action: z.enum(['replace', 'keep']) })).max(2000).default([]),
      removed: z.array(z.object({ event_id: uuid, action: z.enum(['archive', 'keep']) })).max(2000).default([]),
    }),
    await c.req.json(),
  );
  let replaced = 0, kept = 0, archived = 0;
  for (const ch of b.changes) {
    const ev = await loadEntity<any>(a, 'event', ch.event_id);
    if (ev.imported_by !== a.user.id || !ev.google_event_id) throw badRequest('Only the person who imported an event can refresh it');
    const cal = await q1<any>(
      `SELECT gc.*, row_to_json(con.*) AS conn FROM google_calendars gc JOIN google_connections con ON con.id = gc.connection_id
        WHERE con.id = $1 AND gc.google_calendar_id = $2 AND con.user_id = $3`,
      [ev.google_connection_id, ev.google_calendar_id, a.user.id],
    );
    if (!cal) throw badRequest('The source calendar is no longer connected');
    const win = importWindow(a);
    const list = await listCalendarEvents(cal.conn, cal.google_calendar_id, win.timeMin, win.timeMax);
    const src = list.find((x) => x.id === ev.google_event_id);
    if (!src) continue;
    const snap = normalizeGoogleEvent(src, a.household.timezone);
    if (ch.action === 'replace') {
      const cols = columnsFromSnapshot(snap, ev.availability_only, cal.summary);
      await q(
        `UPDATE events SET title = $2, description = $3, location = $4, participants = $5, all_day = $6, time_unspecified = false, start_date = $7,
           end_date = $8, starts_at = $9, ends_at = $10, source_snapshot = $11, source_updated_at = $12, locally_modified = false, updated_at = now(), updated_by = $13
         WHERE id = $1`,
        [ev.id, cols.title, cols.description, cols.location, cols.participants, cols.all_day, cols.start_date, cols.end_date, cols.starts_at, cols.ends_at,
          JSON.stringify(snap), snap.updated, a.user.id],
      );
      await logActivity(ev.workspace_id, 'event', ev.id, a.user.id, 'refreshed', 'Updated from Google Calendar');
      replaced++;
    } else {
      // Keep local version; remember the source state so the same change is not offered again.
      await q('UPDATE events SET source_snapshot = $2, source_updated_at = $3 WHERE id = $1', [ev.id, JSON.stringify(snap), snap.updated]);
      kept++;
    }
  }
  for (const r of b.removed) {
    const ev = await loadEntity<any>(a, 'event', r.event_id);
    if (ev.imported_by !== a.user.id) throw badRequest('Only the person who imported an event can refresh it');
    if (r.action === 'archive') {
      await q('UPDATE events SET archived_at = now(), updated_at = now() WHERE id = $1', [ev.id]);
      await logActivity(ev.workspace_id, 'event', ev.id, a.user.id, 'archived', 'Archived: removed from the Google Calendar');
      archived++;
    }
  }
  return c.json({ replaced, kept, archived });
});

// ------------------------------------------------------------------ export
function googleBody(d: { title: string; description: string; location: string; date: string; end_date: string | null; start_time: string | null; end_time: string | null; all_day: boolean }, tz: string, eventId: string) {
  const base = {
    summary: d.title,
    description: [d.description, 'Added from OUR HOME'].filter(Boolean).join('\n\n'),
    location: d.location || undefined,
    extendedProperties: { private: { ourHomeEventId: eventId } },
  };
  if (d.all_day || !d.start_time) {
    return { ...base, start: { date: d.date }, end: { date: addDays(d.end_date ?? d.date, 1) } };
  }
  const start = zonedToUtc(d.date, d.start_time, tz);
  let end = d.end_time ? zonedToUtc(d.end_date ?? d.date, d.end_time, tz) : new Date(start.getTime() + 3600_000);
  if (end <= start) end = new Date(start.getTime() + 3600_000);
  return { ...base, start: { dateTime: start.toISOString(), timeZone: tz }, end: { dateTime: end.toISOString(), timeZone: tz } };
}

/** Export step 1: proposed details, destination calendars and previous exports. */
googleRoutes.get('/events/:id/export', async (c) => {
  const a = requireAuth(c);
  const ev = await loadEntity<any>(a, 'event', c.req.param('id'));
  const [s] = await serializeEvents(a, [ev]);
  const tz = a.household.timezone;
  const proposal = {
    title: ev.title, description: ev.description, location: ev.location, date: ev.start_date, end_date: ev.end_date,
    start_time: ev.starts_at ? utcToZoned(new Date(ev.starts_at), tz).time : null,
    end_time: ev.ends_at ? utcToZoned(new Date(ev.ends_at), tz).time : ev.starts_at ? utcToZoned(new Date(new Date(ev.starts_at).getTime() + 3600_000), tz).time : null,
    end_time_assumed: Boolean(ev.starts_at && !ev.ends_at),
    all_day: ev.all_day || !ev.starts_at,
  };
  const destinations = await q<any>(
    `SELECT gc.id, gc.summary, gc.is_primary, con.id AS connection_id, con.google_email, con.scopes
       FROM google_calendars gc JOIN google_connections con ON con.id = gc.connection_id
      WHERE con.user_id = $1 AND con.status = 'active' AND gc.access_role IN ('owner','writer') ORDER BY con.created_at, gc.is_primary DESC, gc.summary`,
    [a.user.id],
  );
  const previous = await q('SELECT exported_at, google_calendar_id, exported_title, html_link FROM event_exports WHERE event_id = $1 AND user_id = $2 ORDER BY exported_at DESC', [ev.id, a.user.id]);
  return c.json({
    event: s, proposal, previous_exports: previous,
    destinations: destinations.map((d) => ({ id: d.id, summary: d.summary, is_primary: d.is_primary, connection_id: d.connection_id, google_email: d.google_email, can_write: String(d.scopes).split(' ').includes(WRITE_SCOPE) })),
  });
});

/** Export step 2: create ONE new event in the chosen Google Calendar. One-way copy. */
googleRoutes.post('/events/:id/export', async (c) => {
  const a = requireAuth(c);
  const ev = await loadEntity<any>(a, 'event', c.req.param('id'));
  const b = parse(
    z.object({
      calendar_id: uuid,
      title: z.string().trim().min(1).max(300),
      description: z.string().max(8000).default(''),
      location: z.string().max(500).default(''),
      date: dateStr,
      end_date: dateStr.nullish(),
      start_time: timeStr.nullish(),
      end_time: timeStr.nullish(),
      all_day: z.boolean(),
      confirm: z.literal(true),
      allow_duplicate: z.boolean().default(false),
    }),
    await c.req.json(),
  );
  const cal = await ownCalendar(a, b.calendar_id);
  if (!['owner', 'writer'].includes(cal.access_role)) throw badRequest('You cannot add events to that calendar');
  const prior = await q<any>('SELECT exported_at FROM event_exports WHERE event_id = $1 AND user_id = $2', [ev.id, a.user.id]);
  if (prior.length && !b.allow_duplicate) {
    throw conflict('You already added this event to a Google Calendar. Confirm again to create another copy.', { previous_exports: prior });
  }
  const body = googleBody({ ...b, end_date: b.end_date ?? null, start_time: b.start_time ?? null, end_time: b.end_time ?? null }, a.household.timezone, ev.id);
  const created = await insertGoogleEvent(cal.conn, cal.google_calendar_id, body);
  await q(
    `INSERT INTO event_exports (event_id, user_id, connection_id, google_calendar_id, google_event_id, html_link, exported_title) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ev.id, a.user.id, cal.connection_id, cal.google_calendar_id, created.id, created.htmlLink ?? null, b.title],
  );
  await logActivity(ev.workspace_id, 'event', ev.id, a.user.id, 'exported', `Added to ${a.user.display_name}'s Google Calendar “${cal.summary}”`);
  return c.json({ ok: true, google_event_id: created.id, html_link: created.htmlLink ?? null, calendar: cal.summary });
});
