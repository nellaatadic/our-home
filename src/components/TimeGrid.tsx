import { useEffect, useMemo, useRef } from 'react';
import { useMe } from '../lib/session';
import { day, time12, todayLocal } from '../lib/format';
import { useOpen } from './Layout';

interface Block { key: string; id?: string; title: string; start: number; end: number; kind: 'us' | 'me' | 'busy'; lane: number; span: boolean; col?: number; cols?: number; event?: any }

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

/** Which person's lane an event belongs to: -1 means both of you (spans the lanes). */
function laneFor(e: any, me: ReturnType<typeof useMe>): number {
  if (e.space === 'me') return 0;
  if (e.for_user_id) return e.for_user_id === me.user.id ? 0 : 1;
  const names = (e.participants ?? []).map((p: string) => p.toLowerCase());
  const mine = names.some((n: string) => n.startsWith(me.user.display_name.toLowerCase().split(' ')[0]));
  const theirs = me.partner ? names.some((n: string) => n.startsWith(me.partner!.display_name.toLowerCase().split(' ')[0])) : false;
  if (mine && !theirs) return 0;
  if (theirs && !mine) return 1;
  return -1;
}

/** Side-by-side columns for overlapping blocks. */
function layout(blocks: Block[]) {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || b.end - a.end);
  let group: Block[] = [];
  let groupEnd = -1;
  const flush = () => {
    const cols: number[] = [];
    for (const b of group) {
      let c = cols.findIndex((end) => end <= b.start);
      if (c === -1) { c = cols.length; cols.push(b.end); } else cols[c] = b.end;
      b.col = c;
    }
    for (const b of group) b.cols = cols.length;
    group = [];
  };
  for (const b of sorted) {
    if (b.start >= groupEnd) { flush(); groupEnd = b.end; }
    group.push(b);
    groupEnd = Math.max(groupEnd, b.end);
  }
  flush();
  return sorted;
}

/**
 * Hourly grid. With `lanes`, one day is split into a column per person
 * (shared events for both span the two columns); otherwise each day is a column.
 */
export function TimeGrid({ days, events, busy = [], lanes, hourHeight = 44, fromHour = 7, toHour = 22, onAdd, compact }: {
  days: string[]; events: any[]; busy?: any[]; lanes?: boolean; hourHeight?: number; fromHour?: number; toHour?: number;
  onAdd?: (date: string, time: string) => void; compact?: boolean;
}) {
  const me = useMe();
  const open = useOpen();
  const today = todayLocal(me.household.timezone);
  const scroller = useRef<HTMLDivElement>(null);
  const laneNames = lanes ? [me.user.display_name, me.partner?.display_name ?? 'Partner'] : [];

  const { timed, allDay, start, end } = useMemo(() => {
    const timed = new Map<string, Block[]>();
    const allDay = new Map<string, any[]>();
    let start = fromHour * 60;
    let end = toHour * 60;
    for (const d of days) { timed.set(d, []); allDay.set(d, []); }
    for (const e of events) {
      for (const d of days) {
        if (d < e.start_date || d > (e.end_date ?? e.start_date)) continue;
        if (e.all_day || !e.start_time || e.time_unspecified) { allDay.get(d)!.push(e); continue; }
        const s = d === e.start_date ? toMin(e.start_time) : 0;
        const en = d === (e.end_date ?? e.start_date) && e.end_time ? Math.max(toMin(e.end_time), s + 20) : d === e.start_date && !e.end_time ? s + 60 : 24 * 60;
        const lane = lanes ? laneFor(e, me) : 0;
        timed.get(d)!.push({ key: `${e.id}${d}`, id: e.id, title: e.availability_only ? 'Busy' : e.title, start: s, end: en, kind: e.availability_only ? 'busy' : e.space, lane: Math.max(lane, 0), span: lanes ? lane === -1 : true, event: e });
        start = Math.min(start, Math.floor(s / 60) * 60);
        end = Math.max(end, Math.ceil(en / 60) * 60);
      }
    }
    for (const b of busy) {
      for (const d of days) {
        if (d < b.start_date || d > (b.end_date ?? b.start_date)) continue;
        if (b.all_day || !b.start_time) { allDay.get(d)!.push({ ...b, id: undefined, title: 'Busy', busy: true }); continue; }
        const s = d === b.start_date ? toMin(b.start_time) : 0;
        const en = d === (b.end_date ?? b.start_date) && b.end_time ? Math.max(toMin(b.end_time), s + 20) : s + 60;
        timed.get(d)!.push({ key: `busy${d}${s}`, title: 'Busy', start: s, end: en, kind: 'busy', lane: 1, span: !lanes });
      }
    }
    return { timed, allDay, start: Math.max(0, start), end: Math.min(24 * 60, end) };
  }, [days, events, busy, lanes, me, fromHour, toHour]);

  const pxPerMin = hourHeight / 60;
  const hours = Array.from({ length: (end - start) / 60 }, (_, i) => start / 60 + i);
  const nowMin = (() => { const t = new Intl.DateTimeFormat('en-CA', { timeZone: me.household.timezone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).format(new Date()); return toMin(t); })();

  useEffect(() => {
    if (scroller.current && days.includes(today)) scroller.current.scrollTop = Math.max(0, (nowMin - start - 90) * pxPerMin);
  }, [days, today, nowMin, start, pxPerMin]);

  const cols = lanes ? 2 : 1;
  return (
    <div className={`timegrid ${compact ? 'compact' : ''}`} style={{ ['--days' as any]: days.length, ['--cols' as any]: cols }}>
      {(days.length > 1 || lanes) && (
        <div className="tg-head">
          <span />
          {days.map((d) => lanes
            ? laneNames.map((n, i) => <span key={d + i} className={`tg-lane-name lane-${i}`}>{n}</span>)
            : <span key={d} className={`tg-day ${d === today ? 'today' : ''}`}>{day(d, { weekday: 'short' })} <b>{Number(d.slice(8))}</b></span>)}
        </div>
      )}
      {[...allDay.values()].some((x) => x.length) && (
        <div className="tg-allday">
          <span className="tg-label">all-day</span>
          {days.map((d) => (
            <div key={d} className="tg-allday-cell" style={lanes ? { gridColumn: `span ${cols}` } : undefined}>
              {allDay.get(d)!.map((e, i) => (
                <button key={(e.id ?? 'b') + i} className={`tg-chip ${e.busy || e.availability_only ? 'busy' : `ev-${e.space}`}`} disabled={!e.id} onClick={() => e.id && open('event', e.id)}>
                  {e.busy ? 'Busy' : e.title}{e.years ? ` · ${e.years}` : ''}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="tg-scroll" ref={scroller}>
        <div className="tg-body" style={{ height: (end - start) * pxPerMin }}>
          <div className="tg-hours">
            {hours.map((h) => <span key={h} style={{ top: (h * 60 - start) * pxPerMin }}>{h === 0 ? '' : time12(`${h}:00`).replace(':00', '')}</span>)}
          </div>
          {days.map((d) => (
            <div key={d} className={`tg-col ${d === today ? 'today' : ''}`} style={lanes ? { gridColumn: `span ${cols}` } : undefined}
              onDoubleClick={(e) => { if (!onAdd) return; const y = e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top; const m = Math.round((y / pxPerMin + start) / 30) * 30; onAdd(d, `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`); }}>
              {hours.map((h) => <div key={h} className="tg-line" style={{ top: (h * 60 - start) * pxPerMin }} />)}
              {lanes && <div className="tg-lane-divider" />}
              {layout(timed.get(d)!).map((b) => {
                const laneW = b.span ? 100 : 100 / cols;
                const left = b.span ? 0 : b.lane * laneW;
                const w = laneW / (b.cols ?? 1);
                return (
                  <button key={b.key} className={`tg-ev ${b.kind === 'busy' ? 'busy' : `ev-${b.kind}`} ${b.span && lanes ? 'both' : ''}`}
                    style={{ top: (b.start - start) * pxPerMin, height: Math.max(18, (b.end - b.start) * pxPerMin - 2), left: `calc(${left + w * (b.col ?? 0)}% + 2px)`, width: `calc(${w}% - 4px)` }}
                    disabled={!b.id} onClick={() => b.id && open('event', b.id)} title={b.title}>
                    <span className="tg-ev-title">{b.title}</span>
                    {!compact && b.end - b.start >= 45 && <span className="tg-ev-time">{time12(`${Math.floor(b.start / 60)}:${String(b.start % 60).padStart(2, '0')}`)}</span>}
                  </button>
                );
              })}
              {d === today && nowMin >= start && nowMin <= end && <div className="tg-now" style={{ top: (nowMin - start) * pxPerMin }} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
