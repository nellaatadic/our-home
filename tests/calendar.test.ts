import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { household, resetDb, type Client } from './helpers.js';
import { FakeGoogle, iso } from './google-mock.js';
import { q } from '../server/db.js';

const google = new FakeGoogle();

beforeAll(async () => {
  process.env.GOOGLE_CLIENT_ID = 'test-client';
  process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.APP_URL = 'http://localhost';
  google.install();
  await resetDb();
});
afterAll(() => google.uninstall());

async function connect(c: Client, code: string, purpose: 'import' | 'export' = 'import') {
  const { url } = await c.ok('POST', '/google/connect', { purpose });
  const state = new URL(url).searchParams.get('state')!;
  expect(new URL(url).searchParams.get('scope')).toContain(purpose === 'import' ? 'calendar.events.readonly' : 'auth/calendar.events');
  const r = await c.get(`/google/callback?code=${code}&state=${state}`);
  expect(r.status).toBe(302);
  expect(r.headers.get('location')).toContain('connected=');
  return (await c.ok('GET', '/google/status')).connections;
}

function snapshotGoogle() {
  return JSON.stringify([...google.accounts.values()].map((a) => a.calendars.map((c) => c.events)));
}

describe('Scenario C — Google import into US (independent copies)', () => {
  it('imports selected calendars from two accounts, edits copies, never touches Google', async () => {
    const { me, you } = await household();
    google.addAccount('code-personal', {
      sub: 'g-personal', email: 'nella.personal@example.test', calendars: [
        { id: 'personal@example.test', summary: 'Personal', accessRole: 'owner', primary: true, events: [
          { id: 'p1', summary: 'Yoga', start: { dateTime: iso(2, 17) }, end: { dateTime: iso(2, 18) }, location: 'Studio A', updated: '2026-01-01T00:00:00Z' },
          { id: 'p2', summary: 'Doctor', start: { dateTime: iso(5, 9) }, end: { dateTime: iso(5, 10) }, visibility: 'private', description: 'Confidential', updated: '2026-01-01T00:00:00Z' },
          { id: 'p-old', summary: 'Past thing', start: { dateTime: iso(-10, 9) }, end: { dateTime: iso(-10, 10) } },
          { id: 'p-far', summary: 'Too far', start: { dateTime: iso(220, 9) }, end: { dateTime: iso(220, 10) } },
        ] },
        { id: 'family@example.test', summary: 'Family', accessRole: 'reader', events: [
          { id: 'f1', summary: 'Grandma visit', start: { date: iso(10).slice(0, 10) }, end: { date: iso(12).slice(0, 10) }, updated: '2026-01-01T00:00:00Z' },
        ] },
      ],
    });
    google.addAccount('code-work', {
      sub: 'g-work', email: 'nella@work.example.test', calendars: [
        { id: 'work@example.test', summary: 'Work', accessRole: 'owner', primary: true, events: [
          { id: 'w1', summary: 'Quarterly review', start: { dateTime: iso(3, 13) }, end: { dateTime: iso(3, 14) }, updated: '2026-01-01T00:00:00Z' },
        ] },
        { id: 'uni@example.test', summary: 'University', accessRole: 'reader', events: [] },
      ],
    });
    await connect(me, 'code-personal');
    const conns = await connect(me, 'code-work');
    expect(conns).toHaveLength(2);
    // tokens are never exposed
    expect(JSON.stringify(conns)).not.toMatch(/at-g-|rt-g-|token/);
    // YOU cannot see ME's connections
    expect((await you.ok('GET', '/google/status')).connections).toHaveLength(0);

    const cals = conns.flatMap((c: any) => c.calendars);
    const chosen = cals.filter((c: any) => ['Personal', 'Family', 'Work'].includes(c.summary)).map((c: any) => c.id);
    expect(chosen).toHaveLength(3);
    const before = snapshotGoogle();

    const preview = await me.ok('POST', '/google/import/preview', { calendar_ids: chosen, target: 'us' });
    const titles = preview.events.map((e: any) => e.title);
    expect(titles).toEqual(expect.arrayContaining(['Yoga', 'Doctor', 'Grandma visit', 'Quarterly review']));
    expect(titles).not.toContain('Too far'); // window: today → +6 months
    const doctor = preview.events.find((e: any) => e.google_event_id === 'p2');
    expect(doctor.suggested_availability_only).toBe(true);

    const selections = preview.events.map((e: any) => ({ calendar_id: e.calendar_id, google_event_id: e.google_event_id, availability_only: e.suggested_availability_only }));
    const res = await me.ok('POST', '/google/import', { target: 'us', selections });
    expect(res.imported).toBe(selections.length);
    // repeated import creates no duplicates
    const again = await me.ok('POST', '/google/import', { target: 'us', selections });
    expect(again.imported).toBe(0);
    expect(again.skipped_duplicates).toBe(selections.length);

    const from = new Date().toISOString().slice(0, 10);
    const to = iso(60).slice(0, 10);
    const evs = (await you.ok('GET', `/events?from=${from}&to=${to}&space=us`)).events;
    const byTitle = (t: string) => evs.find((e: any) => e.title === t);
    expect(byTitle('Busy (Personal)')).toBeTruthy(); // private → availability only
    expect(evs.some((e: any) => e.description === 'Confidential')).toBe(false);
    expect(byTitle('Grandma visit').all_day).toBe(true);
    expect(byTitle('Grandma visit').end_date).toBe(iso(11).slice(0, 10)); // Google end date is exclusive
    expect(byTitle('Yoga').imported_by_name).toBe('Nella');
    expect(byTitle('Yoga').google_calendar_name).toBe('Personal');

    // Rename one, move location of another, delete a third — from US
    await me.ok('PATCH', `/events/${byTitle('Yoga').id}`, { title: 'Yoga with Zsolt' });
    await you.ok('PATCH', `/events/${byTitle('Quarterly review').id}`, { location: 'Room 4' });
    await me.ok('POST', `/entities/event/${byTitle('Grandma visit').id}/archive`);

    // Google is unchanged and received no write requests during import/edit
    expect(snapshotGoogle()).toBe(before);
    expect(google.requests.filter((r) => r.method !== 'GET' && r.url.includes('/calendar/v3'))).toHaveLength(0);

    // Refresh: change Yoga + Work at the source, add a new event
    const personal = google.accounts.get('code-personal')!.calendars[0];
    personal.events[0].start = { dateTime: iso(2, 18) };
    personal.events[0].end = { dateTime: iso(2, 19) };
    personal.events.push({ id: 'p3', summary: 'New dentist', start: { dateTime: iso(7, 8) }, end: { dateTime: iso(7, 9) } });
    const work = google.accounts.get('code-work')!.calendars[0];
    work.events[0].summary = 'Quarterly review (moved)';
    const rp = await me.ok('POST', '/google/refresh/preview', {});
    expect(rp.new_events.map((e: any) => e.title)).toContain('New dentist');
    const yoga = rp.changed.find((x: any) => x.title === 'Yoga with Zsolt');
    expect(yoga.locally_modified).toBe(true);
    expect(yoga.suggested_action).toBe('keep');
    expect(yoga.differences.map((d: any) => d.field)).toEqual(expect.arrayContaining(['starts_at', 'ends_at']));
    expect(rp.changed.some((x: any) => x.title === 'Grandma visit')).toBe(false); // deleted copies are never resurrected

    const qr = rp.changed.find((x: any) => x.title === 'Quarterly review');
    await me.ok('POST', '/google/refresh/apply', { changes: [{ event_id: yoga.event_id, action: 'keep' }, { event_id: qr.event_id, action: 'replace' }] });
    const after = (await me.ok('GET', `/events?from=${from}&to=${to}&space=us`)).events;
    expect(after.find((e: any) => e.id === yoga.event_id).title).toBe('Yoga with Zsolt'); // local change preserved
    expect(after.find((e: any) => e.id === qr.event_id).title).toBe('Quarterly review (moved)');
    // acknowledged changes are not offered again
    const rp2 = await me.ok('POST', '/google/refresh/preview', {});
    expect(rp2.changed).toHaveLength(0);
    expect(google.requests.filter((r) => r.method !== 'GET' && r.url.includes('/calendar/v3'))).toHaveLength(0);
  });

  it('reports a clear error when Google is not configured', async () => {
    const { me } = await household({ partner: false });
    const saved = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      const st = await me.ok('GET', '/google/status');
      expect(st.configured).toBe(false);
      expect(st.missing).toContain('GOOGLE_CLIENT_ID');
      expect((await me.post('/google/connect', {})).status).toBe(503);
    } finally {
      process.env.GOOGLE_CLIENT_ID = saved;
    }
  });

  it('rejects a callback whose state belongs to another user', async () => {
    const { me, you } = await household();
    google.addAccount('code-x', { sub: 'g-x', email: 'x@example.test', calendars: [] });
    const { url } = await me.ok('POST', '/google/connect', {});
    const state = new URL(url).searchParams.get('state');
    const r = await you.get(`/google/callback?code=code-x&state=${state}`);
    expect(r.headers.get('location')).toContain('google_error');
    expect((await you.ok('GET', '/google/status')).connections).toHaveLength(0);
  });
});

describe('Scenario D — export a YOU event into ME’s Google Calendar', () => {
  it('previews, requires confirmation, creates one copy, warns on duplicates', async () => {
    const { me, you } = await household();
    google.addAccount('code-zsolt', {
      sub: 'g-zsolt', email: 'zsolt@example.test', calendars: [{ id: 'zsolt@example.test', summary: 'Zsolt', accessRole: 'owner', primary: true, events: [
        { id: 'z1', summary: 'Meeting with Peter', start: { dateTime: iso(4, 9) }, end: { dateTime: iso(4, 10) }, location: 'Office' },
      ] }],
    });
    google.addAccount('code-nella-export', {
      sub: 'g-nella', email: 'nella@example.test', calendars: [{ id: 'nella@example.test', summary: 'Nella', accessRole: 'owner', primary: true, events: [] }],
    });
    google.grantedScopes.set('code-nella-export', 'openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events');
    const yc = await connect(you, 'code-zsolt');
    const prev = await you.ok('POST', '/google/import/preview', { calendar_ids: [yc[0].calendars[0].id], target: 'us' });
    await you.ok('POST', '/google/import', { target: 'us', selections: prev.events.map((e: any) => ({ calendar_id: e.calendar_id, google_event_id: e.google_event_id })) });
    const zsoltBefore = JSON.stringify(google.accounts.get('code-zsolt')!.calendars[0].events);

    const from = new Date().toISOString().slice(0, 10);
    const ev = (await me.ok('GET', `/events?from=${from}&to=${iso(30).slice(0, 10)}&space=us`)).events.find((e: any) => e.title === 'Meeting with Peter');
    expect(ev.imported_by_name).toBe('Zsolt');

    const mc = await connect(me, 'code-nella-export', 'export');
    const exp = await me.ok('GET', `/events/${ev.id}/export`);
    expect(exp.proposal.title).toBe('Meeting with Peter');
    expect(exp.destinations).toHaveLength(1);
    expect(exp.destinations[0].can_write).toBe(true);
    // YOU's calendars are never offered to ME
    expect(exp.destinations.some((d: any) => d.google_email === 'zsolt@example.test')).toBe(false);

    const payload = { ...exp.proposal, title: 'Zsolt: meeting with Peter', calendar_id: exp.destinations[0].id };
    expect((await me.post(`/events/${ev.id}/export`, payload)).status).toBe(400); // confirm flag required
    const done = await me.ok('POST', `/events/${ev.id}/export`, { ...payload, confirm: true });
    expect(done.google_event_id).toBeTruthy();
    const nellaCal = google.accounts.get('code-nella-export')!.calendars[0].events;
    expect(nellaCal).toHaveLength(1);
    expect(nellaCal[0].summary).toBe('Zsolt: meeting with Peter');

    // duplicate protection, explicit override allowed
    const dup = await me.post(`/events/${ev.id}/export`, { ...payload, confirm: true });
    expect(dup.status).toBe(409);
    await me.ok('POST', `/events/${ev.id}/export`, { ...payload, confirm: true, allow_duplicate: true });
    expect(nellaCal).toHaveLength(2);
    const rows = await q('SELECT * FROM event_exports WHERE event_id = $1', [ev.id]);
    expect(rows).toHaveLength(2);

    // YOU's original Google event is unchanged and no write went to YOU's calendar
    expect(JSON.stringify(google.accounts.get('code-zsolt')!.calendars[0].events)).toBe(zsoltBefore);
    const writes = google.requests.filter((r) => r.method === 'POST' && r.url.includes('/calendar/v3'));
    expect(writes.every((w) => w.url.includes(encodeURIComponent('nella@example.test')))).toBe(true);

    // A read-only connection cannot export
    expect(mc[0].can_export).toBe(true);
    expect((await you.ok('GET', '/google/status')).connections[0].can_export).toBe(false);
  });

  it('disconnects and revokes a connection while keeping imported copies', async () => {
    const { me } = await household({ partner: false });
    google.addAccount('code-dc', { sub: 'g-dc', email: 'dc@example.test', calendars: [{ id: 'dc', summary: 'DC', accessRole: 'owner', events: [
      { id: 'd1', summary: 'Keep me', start: { dateTime: iso(1, 9) }, end: { dateTime: iso(1, 10) } },
    ] }] });
    const conns = await connect(me, 'code-dc');
    const p = await me.ok('POST', '/google/import/preview', { calendar_ids: [conns[0].calendars[0].id], target: 'me' });
    await me.ok('POST', '/google/import', { target: 'me', selections: p.events.map((e: any) => ({ calendar_id: e.calendar_id, google_event_id: e.google_event_id })) });
    await me.ok('POST', `/google/connections/${conns[0].id}/disconnect`);
    expect(google.requests.some((r) => r.url.includes('/revoke'))).toBe(true);
    expect((await me.ok('GET', '/google/status')).connections).toHaveLength(0);
    const evs = (await me.ok('GET', `/events?from=${new Date().toISOString().slice(0, 10)}&to=${iso(5).slice(0, 10)}&space=me`)).events;
    expect(evs.map((e: any) => e.title)).toContain('Keep me');
    const [row] = await q('SELECT access_token_enc, refresh_token_enc FROM google_connections WHERE id = $1', [conns[0].id]);
    expect(row.access_token_enc).toBeNull();
    expect(row.refresh_token_enc).toBeNull();
  });
});

describe('Scenario E — natural-language event creation', () => {
  it('identifies three separate drafts and never invents details', async () => {
    const { me } = await household();
    const r = await me.ok('POST', '/events/parse', {
      text: '- Dinner with Mary on Thursday at 7 PM.\n- Dentist appointment on December 4 at 2 PM.\n- Oil change next Saturday morning.',
    });
    expect(r.message).toBe('3 calendar events identified.');
    const [dinner, dentist, oil] = r.drafts;
    expect(dinner.title).toBe('Dinner with Mary');
    expect(dinner.start_time).toBe('19:00');
    expect(dinner.participants).toEqual(['Mary']);
    // on a Thursday, "Thursday" is ambiguous (today or next week) and must be confirmed
    expect(dinner.date ?? dinner.issues.find((i: any) => i.code === 'ambiguous_date').options[0].value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dinner.end_time).toBeNull(); // not stated → not invented
    expect(dentist.title).toBe('Dentist appointment');
    expect(dentist.date).toMatch(/-12-04$/);
    expect(dentist.start_time).toBe('14:00');
    expect(dentist.category).toBe('Health');
    expect(oil.title).toBe('Oil change');
    expect(oil.start_time).toBeNull(); // "morning" is not a time
    expect(oil.time_hint).toBe('morning');
    expect(oil.issues.map((i: any) => i.code)).toEqual(expect.arrayContaining(['ambiguous_date', 'part_of_day']));
    expect(oil.date).toBeNull(); // "next Saturday" needs clarification
    expect(oil.issues.find((i: any) => i.code === 'ambiguous_date').options).toHaveLength(2);

    // Saving each independently
    const saved = [];
    const pick = (d: any) => ({ ...d, date: d.date ?? d.issues.find((i: any) => i.code === 'ambiguous_date').options[0].value });
    for (const d of [pick(dinner), dentist, pick(oil)]) {
      saved.push((await me.ok('POST', '/spaces/us/events', {
        title: d.title, date: d.date, start_time: d.start_time, end_time: d.end_time, location: d.location, participants: d.participants,
        description: d.time_hint ? `Time: ${d.time_hint}` : '', category: d.category, source_type: 'text',
      })).event);
    }
    expect(saved[2].time_unspecified).toBe(true);
    expect(saved[2].starts_at).toBeNull();
    expect(saved[0].start_time).toBe('19:00');
  });

  it('associates events with household members and handles ambiguous numeric dates', async () => {
    const { me } = await household();
    const r = await me.ok('POST', '/events/parse', { text: 'Zsolt has a meeting with Peter next Tuesday at 10. Party 4/12 from 7 to 10pm' });
    expect(r.drafts).toHaveLength(2);
    expect(r.drafts[0].for_person).toBe('Zsolt');
    expect(r.drafts[0].for_user_id).toBeTruthy();
    expect(r.drafts[0].issues.map((i: any) => i.code)).toContain('ambiguous_time');
    expect(r.drafts[1].date).toBeNull();
    expect(r.drafts[1].issues[0].code).toBe('ambiguous_date');
    expect(r.drafts[1].end_time).toBe('22:00');
  });
});

describe('unit: natural-language parser with a fixed clock', () => {
  it('resolves relative dates in the household time zone', async () => {
    const { parseEventText } = await import('../server/lib/nlp.js');
    // Wednesday 18 Nov 2026, 22:30 UTC = Wednesday 23:30 in Budapest
    const now = new Date('2026-11-18T22:30:00Z');
    const [d] = parseEventText('Dinner with Mary on Thursday at 7 PM', { timezone: 'Europe/Budapest', now });
    expect(d.date).toBe('2026-11-19');
    expect(d.issues).toHaveLength(0);
    // 23:30 UTC is already Thursday in Budapest → "Thursday" is ambiguous
    const [t] = parseEventText('Dinner on Thursday at 19:00', { timezone: 'Europe/Budapest', now: new Date('2026-11-18T23:30:00Z') });
    expect(t.date).toBeNull();
    expect(t.issues[0].options!.map((o: any) => o.value)).toEqual(['2026-11-19', '2026-11-26']);
    expect(t.start_time).toBe('19:00');
    const [g] = parseEventText('Buy Christmas gifts with Lia on Saturday afternoon', { timezone: 'Europe/Budapest', now });
    expect(g.date).toBe('2026-11-21');
    expect(g.start_time).toBeNull();
    expect(g.time_hint).toBe('afternoon');
    expect(g.participants).toEqual(['Lia']);
    expect(g.title).toBe('Buy Christmas gifts with Lia');
  });
  it('extracts a location and duration without inventing an end time', async () => {
    const { parseEventText } = await import('../server/lib/nlp.js');
    const now = new Date('2026-11-18T10:00:00Z');
    const [d] = parseEventText('Lunch at Café Central on Friday at 12:30 for 2 hours', { timezone: 'Europe/Budapest', now });
    expect(d.location).toBe('Café Central');
    expect(d.title).toBe('Lunch');
    expect(d.duration_minutes).toBe(120);
    expect(d.end_time).toBeNull();
    const none = parseEventText('Call the plumber', { timezone: 'Europe/Budapest', now });
    expect(none[0].date).toBeNull();
    expect(none[0].issues[0].code).toBe('missing_date');
  });
});
