import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronLeft, ChevronRight, ListChecks, Lock, MapPin, MessageCircle, MoreHorizontal, Plus, RefreshCw, Settings2, Sparkles, Download, Users } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { useMe, useSession } from '../lib/session';
import { addDays, day, eventTime, time12, todayLocal } from '../lib/format';
import { TimeGrid } from '../components/TimeGrid';
import { useOpen } from '../components/Layout';
import { EventForm } from '../components/forms';
import { Field, Loading, Segmented, Sheet, SpaceTag, useAction, useToast } from '../components/ui';

function monthGrid(anchor: string) {
  const [y, m] = anchor.split('-').map(Number);
  const first = `${y}-${String(m).padStart(2, '0')}-01`;
  const dow = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday first
  const start = addDays(first, -dow);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

function weekStart(d: string) {
  const dow = (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(d, -dow);
}

export function CalendarPage() {
  const me = useMe();
  const { config } = useSession();
  const open = useOpen();
  const today = todayLocal(me.household.timezone);
  const [anchor, setAnchor] = useState(today);
  const [view, setView] = useState<'cards' | 'day' | 'week' | 'month'>('cards');
  const [menu, setMenu] = useState(false);
  const [scope, setScope] = useState<'all' | 'us' | 'me'>('all');
  const [adding, setAdding] = useState<{ date: string; start_time?: string } | null>(null);
  const [pasting, setPasting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const grid = useMemo(() => monthGrid(anchor.slice(0, 8) + '01'), [anchor]);
  const week = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart(anchor), i)), [anchor]);
  const from = view === 'month' ? grid[0] : view === 'week' || view === 'cards' ? week[0] : anchor;
  const to = view === 'month' ? grid[41] : view === 'week' ? week[6] : view === 'cards' ? addDays(week[0], 41) : anchor;
  const { data: plansData } = useApi<{ plans: any[] }>(view === 'cards' ? '/plans' : null);
  const { data } = useApi<{ events: any[]; busy: any[] }>(`/events?from=${from}&to=${to}&space=${scope}&busy=${scope === 'all' ? 'true' : 'false'}`);
  const { data: gstatus } = useApi<any>('/google/status');
  const byDay = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const e of data?.events ?? []) {
      let d = e.start_date;
      const end = e.end_date ?? e.start_date;
      for (let i = 0; d <= end && i < 62; i++, d = addDays(d, 1)) map.set(d, [...(map.get(d) ?? []), e]);
    }
    return map;
  }, [data]);
  const shift = (n: number) => {
    if (view === 'day') return setAnchor(addDays(anchor, n));
    if (view === 'week' || view === 'cards') return setAnchor(addDays(anchor, 7 * n));
    const [y, m] = anchor.split('-').map(Number);
    setAnchor(new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10));
  };
  const title = view === 'cards' ? day(week[0], { month: 'long', year: 'numeric' }) : view === 'day' ? day(anchor, { weekday: 'long', month: 'long', day: 'numeric' })
    : view === 'week' ? `${day(week[0], { month: 'short', day: 'numeric' })} – ${day(week[6], { month: 'short', day: 'numeric', year: 'numeric' })}`
    : day(anchor, { month: 'long', year: 'numeric' });
  const hasConnections = (gstatus?.connections?.length ?? 0) > 0;

  return (
    <div className="page calendar-page">
      <header className="page-head compact cal-head">
        <h1>Calendar</h1>
        <div className="row gap-s">
          <button className="icon-btn" onClick={() => setAdding({ date: anchor })} aria-label="New event"><Plus size={20} /></button>
          <div className="menu-wrap">
            <button className="icon-btn" onClick={() => setMenu((x) => !x)} aria-label="More" aria-expanded={menu}><MoreHorizontal size={20} /></button>
            {menu && (
              <div className="pop-menu" role="menu" onMouseLeave={() => setMenu(false)}>
                <button role="menuitem" onClick={() => { setMenu(false); setPasting(true); }}><Sparkles size={14} /> Add from text</button>
                {config.google_configured && hasConnections && <button role="menuitem" onClick={() => { setMenu(false); setImporting(true); }}><Download size={14} /> Import from Google</button>}
                {config.google_configured && hasConnections && <button role="menuitem" onClick={() => { setMenu(false); setRefreshing(true); }}><RefreshCw size={14} /> Check Google for changes</button>}
                <Link role="menuitem" className="pop-link" to="/calendar/connections"><Settings2 size={14} /> Google Calendar{config.google_configured ? '' : ' (not set up)'}</Link>
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="toolbar cal-toolbar">
        <Segmented label="View" value={view} onChange={setView} options={[{ value: 'cards', label: 'Cards' }, { value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} />
        <Segmented label="Show" value={scope} onChange={setScope} options={[{ value: 'all', label: 'All' }, { value: 'us', label: 'Shared' }, { value: 'me', label: 'Mine' }]} />
      </div>
      <div className="month-head">
        <button className="icon-btn" onClick={() => shift(-1)} aria-label="Previous"><ChevronLeft size={18} /></button>
        <h2>{title}</h2>
        <button className="icon-btn" onClick={() => shift(1)} aria-label="Next"><ChevronRight size={18} /></button>
        <button className="btn small ghost" onClick={() => setAnchor(today)}>Today</button>
        <span className="grow" />
        {view !== 'cards' && <span className="legend"><i className="ev-us" /> Shared <i className="ev-me" /> Private {scope === 'all' && <><i className="busy" /> {me.partner?.display_name ?? 'Partner'} busy</>}</span>}
      </div>
      {view === 'cards' && <CardsView week={week} anchor={anchor} setAnchor={setAnchor} today={today} byDay={byDay} plans={plansData?.plans ?? []} onAdd={(d) => setAdding({ date: d })} />}
      {(view === 'day' || view === 'week') && (
        <TimeGrid days={view === 'day' ? [anchor] : week} events={data?.events ?? []} busy={data?.busy ?? []} lanes={view === 'day' && Boolean(me.partner)}
          hourHeight={view === 'day' ? 52 : 44} onAdd={(date, start_time) => setAdding({ date, start_time })} />
      )}
      {view === 'month' && (
        <div className="month">
          <div className="month-grid" role="grid">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="dow" role="columnheader">{d}</div>)}
            {grid.map((d) => {
              const evs = byDay.get(d) ?? [];
              return (
                <div key={d} role="gridcell" className={`cell ${d.slice(0, 7) !== anchor.slice(0, 7) ? 'other' : ''} ${d === today ? 'today' : ''}`} onDoubleClick={() => setAdding({ date: d })}>
                  <button className="cell-day" onClick={() => { setAnchor(d); setView('day'); }} aria-label={`Open ${d}`}>{Number(d.slice(8))}</button>
                  {evs.slice(0, 3).map((e) => (
                    <button key={e.id + d} className={`ev ev-${e.space} ${e.availability_only ? 'busy' : ''}`} onClick={() => open('event', e.id)} title={e.title}>
                      {!e.all_day && e.start_time && d === e.start_date && <span className="ev-time">{time12(e.start_time).replace(':00', '')}</span>}{e.title}
                    </button>
                  ))}
                  {evs.length > 3 && <button className="more" onClick={() => { setAnchor(d); setView('day'); }}>+{evs.length - 3} more</button>}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {view === 'day' && !me.partner && <p className="muted small">Invite your partner in Settings to see both schedules side by side.</p>}
      {adding && <Sheet title="New event" onClose={() => setAdding(null)} wide><EventForm space="us" chooseSpace initial={adding} onCancel={() => setAdding(null)} onSaved={() => { setAdding(null); emitChange(); }} /></Sheet>}
      {pasting && <PasteEvents onClose={() => setPasting(false)} />}
      {importing && <ImportDialog status={gstatus} onClose={() => setImporting(false)} />}
      {refreshing && <RefreshDialog onClose={() => setRefreshing(false)} />}
    </div>
  );
}

// ------------------------------------------------------ text → events
function PasteEvents({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<any>(null);
  const [saved, setSaved] = useState<Set<number>>(new Set());
  const [discarded, setDiscarded] = useState<Set<number>>(new Set());
  const { busy, run } = useAction();
  const parse = () => run(async () => { setResult(await api.post('/events/parse', { text })); setSaved(new Set()); setDiscarded(new Set()); });
  return (
    <Sheet title="Add events from text" onClose={onClose} wide>
      {!result ? (
        <div className="form">
          <Field label="Paste or type events" hint="One per line works best. Bullet lists and several sentences are fine.">
            <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} autoFocus placeholder={'Dinner with Mary on Thursday at 7 PM.\nDentist appointment on December 4 at 2 PM.\nOil change next Saturday morning.'} />
          </Field>
          <div className="row end"><button className="btn primary" disabled={!text.trim() || busy} onClick={parse}>Find events</button></div>
        </div>
      ) : (
        <div className="stack">
          <p className="note">{result.message}{result.note ? ` ${result.note}` : ''}</p>
          {result.drafts.map((d: any, i: number) => (
            <DraftCard key={i} draft={d} done={saved.has(i)} discarded={discarded.has(i)} onSaved={() => setSaved((s) => new Set(s).add(i))} onDiscard={() => setDiscarded((s) => new Set(s).add(i))} />
          ))}
          <div className="row gap-s end">
            <button className="btn ghost" onClick={() => setResult(null)}>Edit text</button>
            <button className="btn" onClick={onClose}>{saved.size ? 'Done' : 'Close'}</button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

function DraftCard({ draft, done, discarded, onSaved, onDiscard }: { draft: any; done: boolean; discarded: boolean; onSaved: () => void; onDiscard: () => void }) {
  const [date, setDate] = useState<string>(draft.date ?? '');
  const [time, setTime] = useState<string>(draft.start_time ?? '');
  const [key, setKey] = useState(0);
  if (done) return <div className="draft done">✓ Saved “{draft.title}”</div>;
  if (discarded) return <div className="draft done muted">Skipped “{draft.title}”</div>;
  const dateIssue = draft.issues.find((x: any) => x.field === 'date');
  const timeIssue = draft.issues.find((x: any) => x.field === 'time');
  return (
    <div className="draft">
      <p className="muted small">“{draft.source_text}”</p>
      {dateIssue && (
        <div className={`note ${date ? 'subtle' : 'warn'}`}>
          {dateIssue.message}
          {dateIssue.options?.length > 0 && <div className="row gap-s wrap">{dateIssue.options.map((o: any) => (
            <button key={o.value} type="button" className={`chip button ${date === o.value ? 'on' : ''}`} onClick={() => { setDate(o.value); setKey((k) => k + 1); }}>{o.label}</button>
          ))}</div>}
        </div>
      )}
      {timeIssue && (
        <div className="note subtle">
          {timeIssue.message}
          {timeIssue.options?.length > 0 && <div className="row gap-s wrap">{timeIssue.options.map((o: any) => (
            <button key={o.value} type="button" className={`chip button ${time === o.value ? 'on' : ''}`} onClick={() => { setTime(o.value); setKey((k) => k + 1); }}>{o.label}</button>
          ))}</div>}
        </div>
      )}
      <EventForm key={key} space="us" chooseSpace
        initial={{
          title: draft.title, date, start_time: time, end_time: draft.end_time ?? (draft.duration_minutes && time ? addMinutes(time, draft.duration_minutes) : ''),
          location: draft.location, participants: draft.participants, participantsText: draft.participants.join(', '),
          description: [draft.description, draft.time_hint ? `Time: ${draft.time_hint}` : ''].filter(Boolean).join('\n'),
          category: draft.category ?? '', for_user_id: draft.for_user_id, from_text: true,
        }}
        onCancel={onDiscard} onSaved={() => { emitChange(); onSaved(); }} />
    </div>
  );
}

function addMinutes(t: string, n: number) {
  const [h, m] = t.split(':').map(Number);
  const total = (h * 60 + m + n) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------ import
function ImportDialog({ status, onClose }: { status: any; onClose: () => void }) {
  const me = useMe();
  const calendars = (status?.connections ?? []).flatMap((c: any) => c.calendars.map((k: any) => ({ ...k, email: c.google_email })));
  const [chosen, setChosen] = useState<Set<string>>(new Set(calendars.filter((c: any) => c.selected).map((c: any) => c.id)));
  const [target, setTarget] = useState<'us' | 'me'>('us');
  const [preview, setPreview] = useState<any>(null);
  const [sel, setSel] = useState<Record<string, { on: boolean; availability_only: boolean }>>({});
  const { busy, run } = useAction();
  const toast = useToast();
  const load = () => run(async () => {
    const p = await api.post('/google/import/preview', { calendar_ids: [...chosen], target });
    setPreview(p);
    setSel(Object.fromEntries(p.events.map((e: any) => [`${e.calendar_id}|${e.google_event_id}`, { on: e.status === 'new', availability_only: e.suggested_availability_only }])));
  });
  const keyOf = (e: any) => `${e.calendar_id}|${e.google_event_id}`;
  const doImport = () => run(async () => {
    const selections = preview.events.filter((e: any) => sel[keyOf(e)]?.on).map((e: any) => ({ calendar_id: e.calendar_id, google_event_id: e.google_event_id, availability_only: sel[keyOf(e)].availability_only }));
    const r = await api.post('/google/import', { target, selections });
    toast(`${r.imported} event${r.imported === 1 ? '' : 's'} imported${r.skipped_duplicates ? `, ${r.skipped_duplicates} already there` : ''}`);
    emitChange();
    onClose();
  });
  const count = Object.values(sel).filter((s) => s.on).length;
  return (
    <Sheet title="Import from Google Calendar" wide onClose={onClose} footer={preview ? <>
      <span className="grow muted small">{count} selected</span>
      <button className="btn ghost" onClick={() => setPreview(null)}>Back</button>
      <button className="btn primary" disabled={!count || busy} onClick={doImport}>Import {count} into {target === 'us' ? 'US' : 'ME'}</button>
    </> : <>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!chosen.size || busy} onClick={load}>Show events</button>
    </>}>
      {!preview ? (
        <div className="stack">
          <p className="muted small">Choose which of your calendars to look at. Events from today through the next six months are listed for you to pick — nothing is imported until you confirm. Imported events become independent copies: editing or deleting them never changes Google.</p>
          <ul className="pick-list">{calendars.map((c: any) => (
            <li key={c.id}><label className="check"><input type="checkbox" checked={chosen.has(c.id)} onChange={() => setChosen((s) => { const n = new Set(s); n.has(c.id) ? n.delete(c.id) : n.add(c.id); return n; })} /> {c.summary} <span className="muted small">{c.email}</span></label></li>
          ))}</ul>
          <Field label="Import into"><Segmented label="Target" value={target} onChange={setTarget} options={[{ value: 'us', label: 'US calendar (shared)' }, { value: 'me', label: 'My private calendar' }]} /></Field>
        </div>
      ) : (
        <div className="stack">
          {preview.errors.map((e: any, i: number) => <p key={i} className="note warn">{e.calendar}: {e.message}</p>)}
          <div className="row gap-s">
            <button className="btn small ghost" onClick={() => setSel((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { ...v, on: preview.events.find((e: any) => keyOf(e) === k)?.status === 'new' }])))}>Select all new</button>
            <button className="btn small ghost" onClick={() => setSel((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { ...v, on: false }])))}>Select none</button>
          </div>
          <ul className="share-list">{preview.events.map((e: any) => {
            const k = keyOf(e);
            const s = sel[k];
            const dup = e.status !== 'new';
            return (
              <li key={k} className={dup ? 'disabled' : ''}>
                <input type="checkbox" checked={Boolean(s?.on)} disabled={dup} onChange={() => setSel((x) => ({ ...x, [k]: { ...x[k], on: !x[k].on } }))} aria-label={`Import ${e.title}`} />
                <div className="grow">
                  <div><b>{e.title}</b> <span className="muted small">· {day(e.start_date)} · {e.all_day ? 'All day' : new Date(e.starts_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: me.household.timezone })} · {e.calendar_name}</span></div>
                  {dup && <div className="small muted">{e.status === 'already_imported' ? 'Already imported' : 'Previously removed from this calendar — will not be re-added'}</div>}
                  {!dup && <label className="check small"><input type="checkbox" checked={Boolean(s?.availability_only)} onChange={() => setSel((x) => ({ ...x, [k]: { ...x[k], availability_only: !x[k].availability_only } }))} /> Share as “Busy” only{e.restricted ? ' (private event)' : ''}</label>}
                </div>
              </li>
            );
          })}</ul>
          {!preview.events.length && <p className="muted">No upcoming events in the chosen calendars.</p>}
        </div>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------ refresh
function RefreshDialog({ onClose }: { onClose: () => void }) {
  const [res, setRes] = useState<any>(null);
  const [changes, setChanges] = useState<Record<string, 'replace' | 'keep'>>({});
  const [removed, setRemoved] = useState<Record<string, 'archive' | 'keep'>>({});
  const [newSel, setNewSel] = useState<Set<string>>(new Set());
  const { busy, run } = useAction();
  const toast = useToast();
  useEffect(() => {
    run(async () => {
      const r = await api.post('/google/refresh/preview', {});
      setRes(r);
      setChanges(Object.fromEntries(r.changed.map((c: any) => [c.event_id, c.suggested_action])));
      setRemoved(Object.fromEntries(r.removed.map((c: any) => [c.event_id, 'keep'])));
    }).then((r) => { if (r === undefined) setRes((x: any) => x ?? { changed: [], removed: [], new_events: [], errors: [{ calendar: 'Google', message: 'Could not check for changes' }] }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const apply = () => run(async () => {
    const r = await api.post('/google/refresh/apply', {
      changes: Object.entries(changes).map(([event_id, action]) => ({ event_id, action })),
      removed: Object.entries(removed).map(([event_id, action]) => ({ event_id, action })),
    });
    let imported = 0;
    if (newSel.size) {
      const sels = res.new_events.filter((e: any) => newSel.has(`${e.calendar_id}|${e.google_event_id}`)).map((e: any) => ({ calendar_id: e.calendar_id, google_event_id: e.google_event_id, availability_only: e.suggested_availability_only }));
      imported = (await api.post('/google/import', { target: 'us', selections: sels })).imported;
    }
    toast(`Updated ${r.replaced}, kept ${r.kept}, archived ${r.archived}, imported ${imported}`);
    emitChange();
    onClose();
  });
  const fmt = (f: string, v: any) => v == null ? '—' : ['starts_at', 'ends_at'].includes(f) ? new Date(v).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v).slice(0, 120) || '—';
  return (
    <Sheet title="Changes in your Google Calendars" wide onClose={onClose} footer={res && <>
      <button className="btn ghost" onClick={onClose}>Close</button>
      <button className="btn primary" disabled={busy || (!res.changed.length && !res.removed.length && !newSel.size)} onClick={apply}>Apply my choices</button>
    </>}>
      {!res ? <Loading /> : (
        <div className="stack">
          {res.errors.map((e: any, i: number) => <p key={i} className="note warn">{e.calendar}: {e.message}</p>)}
          {!res.changed.length && !res.new_events.length && !res.removed.length && <p>Everything is up to date.</p>}
          {res.changed.length > 0 && <h3>Changed at the source</h3>}
          {res.changed.map((c: any) => (
            <div key={c.event_id} className="draft">
              <div className="row between"><b>{c.title}</b><SpaceTag space={c.space} /></div>
              {c.locally_modified && <p className="note subtle">You edited this event in OUR HOME. Keeping your version is suggested.</p>}
              <table className="diff"><tbody>{c.differences.map((d: any) => <tr key={d.field}><th>{d.field.replace('_', ' ')}</th><td>{fmt(d.field, d.before)}</td><td>→ {fmt(d.field, d.after)}</td></tr>)}</tbody></table>
              <Segmented label="Action" value={changes[c.event_id]} onChange={(v) => setChanges((x) => ({ ...x, [c.event_id]: v }))} options={[{ value: 'keep', label: 'Keep OUR HOME version' }, { value: 'replace', label: 'Update from Google' }]} />
            </div>
          ))}
          {res.removed.length > 0 && <h3>No longer in Google</h3>}
          {res.removed.map((c: any) => (
            <div key={c.event_id} className="draft row between">
              <span><b>{c.title}</b> <span className="muted small">{day(c.start_date)}</span></span>
              <Segmented label="Action" value={removed[c.event_id]} onChange={(v) => setRemoved((x) => ({ ...x, [c.event_id]: v }))} options={[{ value: 'keep', label: 'Keep' }, { value: 'archive', label: 'Archive' }]} />
            </div>
          ))}
          {res.new_events.length > 0 && <h3>New events (import into US?)</h3>}
          <ul className="share-list">{res.new_events.map((e: any) => {
            const k = `${e.calendar_id}|${e.google_event_id}`;
            return <li key={k}><input type="checkbox" checked={newSel.has(k)} onChange={() => setNewSel((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; })} aria-label={`Import ${e.title}`} /><span className="grow">{e.restricted ? 'Busy (private)' : e.title} <span className="muted small">· {day(e.start_date)} · {e.calendar_name}</span></span></li>;
          })}</ul>
        </div>
      )}
    </Sheet>
  );
}

/**
 * The calendar's main view: a strip of the week's days and, below it, the
 * chosen day's events and what is coming up, as cards. A card opens the
 * event's pop-up (details, people, checklist, lists, chat).
 */
function CardsView({ week, anchor, setAnchor, today, byDay, plans, onAdd }: {
  week: string[]; anchor: string; setAnchor: (d: string) => void; today: string; byDay: Map<string, any[]>; plans: any[]; onAdd: (d: string) => void;
}) {
  const planMap = new Map(plans.map((p) => [p.id, p]));
  const dayEvents = byDay.get(anchor) ?? [];
  const upcoming: { date: string; events: any[] }[] = [];
  const seen = new Set(dayEvents.map((e) => e.id));
  for (let i = 1, d = addDays(anchor, 1); i <= 28 && upcoming.length < 8; i++, d = addDays(d, 1)) {
    const evs = (byDay.get(d) ?? []).filter((e) => e.start_date === d || !seen.has(e.id));
    evs.forEach((e) => seen.add(e.id));
    if (evs.length) upcoming.push({ date: d, events: evs });
  }
  return (
    <div className="cards-view">
      <div className="week-strip" role="tablist" aria-label="Days">
        {week.map((d) => {
          const n = (byDay.get(d) ?? []).length;
          return (
            <button key={d} role="tab" aria-selected={d === anchor} className={`ws-day ${d === anchor ? 'on' : ''} ${d === today ? 'today' : ''}`} onClick={() => setAnchor(d)}>
              <small>{day(d, { weekday: 'narrow' })}</small><b>{Number(d.slice(8))}</b><i className={n ? 'has' : ''} aria-label={n ? `${n} events` : undefined} />
            </button>
          );
        })}
      </div>
      <h2 className="sec">{anchor === today ? 'Today' : day(anchor, { weekday: 'long', month: 'short', day: 'numeric' })}</h2>
      {dayEvents.length ? dayEvents.map((e) => <EventCard key={e.id + anchor} e={e} plan={planMap.get(e.id)} />) : (
        <button className="add-card slim" onClick={() => onAdd(anchor)}><Plus size={15} /> Nothing planned. Add an event</button>
      )}
      {upcoming.length > 0 && <h2 className="sec">Coming up</h2>}
      {upcoming.map((g) => (
        <div key={g.date} className="up-group">
          <p className="up-date">{day(g.date, { weekday: 'short', month: 'short', day: 'numeric' })}</p>
          {g.events.map((e) => <EventCard key={e.id + g.date} e={e} plan={planMap.get(e.id)} />)}
        </div>
      ))}
    </div>
  );
}

function EventCard({ e, plan }: { e: any; plan?: any }) {
  const open = useOpen();
  const color = e.availability_only ? 'var(--normal)' : e.space === 'me' ? 'var(--me)' : 'var(--us)';
  return (
    <button className={`card-x event-card ${e.availability_only ? 'busy' : ''}`} style={{ ['--list' as any]: color }} onClick={() => !e.availability_only && open('event', e.id)} disabled={e.availability_only}>
      <span className="bar" aria-hidden />
      <span className="ec-title">{e.availability_only ? 'Busy' : e.title}{e.space === 'me' && !e.availability_only && <Lock size={12} className="muted" aria-label="Private" />}</span>
      <span className="ec-meta">
        <span>{eventTime(e)}</span>
        {e.location && <span><MapPin size={12} /> {e.location}</span>}
        {e.participants?.length > 0 && <span><Users size={12} /> {e.participants.length}</span>}
        {plan?.checklist.total > 0 && <span className={plan.checklist.done === plan.checklist.total ? 'ok' : ''}><Check size={12} /> {plan.checklist.done}/{plan.checklist.total}</span>}
        {e.thread?.total > 0 && <span><MessageCircle size={12} /> {e.thread.total}</span>}
        {plan && !plan.checklist.total && <span><ListChecks size={12} /> plan</span>}
      </span>
    </button>
  );
}
