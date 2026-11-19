import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, emitChange } from '../lib/api';
import { day } from '../lib/format';
import { Field, Loading, Sheet, useAction, useToast } from './ui';

/** Copy a shared event into one of MY Google Calendars: review → choose → preview → confirm. */
export function ExportDialog({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [f, setF] = useState<any>(null);
  const [step, setStep] = useState<'edit' | 'preview'>('edit');
  const [dupWarning, setDupWarning] = useState(false);
  const { busy, run } = useAction();
  const toast = useToast();
  useEffect(() => {
    api.get(`/events/${eventId}/export`).then((d) => {
      setData(d);
      setF({ ...d.proposal, calendar_id: d.destinations.find((x: any) => x.can_write)?.id ?? '' });
      setDupWarning(d.previous_exports.length > 0);
    }).catch((e) => { toast(e.message, 'error'); onClose(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);
  if (!data || !f) return <Sheet title="Add to my Google Calendar" onClose={onClose}><Loading /></Sheet>;
  const set = (k: string, v: unknown) => setF((x: any) => ({ ...x, [k]: v }));
  const writable = data.destinations.filter((d: any) => d.can_write);
  const needsPermission = data.destinations.filter((d: any) => !d.can_write);
  const dest = data.destinations.find((d: any) => d.id === f.calendar_id);

  const confirm = () => run(async () => {
    try {
      const r = await api.post(`/events/${eventId}/export`, { ...f, confirm: true, allow_duplicate: data.previous_exports.length > 0 });
      toast(`Added to “${r.calendar}”`);
      emitChange();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) { setDupWarning(true); setStep('preview'); }
      throw e;
    }
  });

  if (!data.destinations.length) {
    return (
      <Sheet title="Add to my Google Calendar" onClose={onClose}>
        <p>Connect your own Google account first. Only calendars you connected are offered — never your partner’s.</p>
        <Link className="btn primary" to="/calendar/connections">Connect Google Calendar</Link>
      </Sheet>
    );
  }

  return (
    <Sheet title="Add to my Google Calendar" onClose={onClose} footer={step === 'edit' ? <>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!f.calendar_id || !f.title.trim() || !f.date} onClick={() => setStep('preview')}>Preview</button>
    </> : <>
      <button className="btn ghost" onClick={() => setStep('edit')}>Back</button>
      <button className="btn primary" disabled={busy} onClick={confirm}>{dupWarning ? 'Create another copy' : 'Confirm and add'}</button>
    </>}>
      {step === 'edit' ? (
        <div className="form">
          <p className="muted small">This creates a new, separate event in your Google Calendar. It is a one-way copy: the original event (and anyone else’s calendar) is not changed.</p>
          {writable.length === 0 && <p className="note warn">Your connected Google accounts are read-only. Open Calendar connections and choose “Allow adding events”.</p>}
          <Field label="Destination calendar">
            <select value={f.calendar_id} onChange={(e) => set('calendar_id', e.target.value)}>
              {writable.map((d: any) => <option key={d.id} value={d.id}>{d.summary} — {d.google_email}</option>)}
            </select>
          </Field>
          {needsPermission.length > 0 && writable.length > 0 && <p className="muted small">Some accounts need extra permission before events can be added.</p>}
          <Field label="Title"><input value={f.title} onChange={(e) => set('title', e.target.value)} /></Field>
          <div className="grid-2">
            <Field label="Date"><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></Field>
            <label className="check"><input type="checkbox" checked={f.all_day} onChange={(e) => set('all_day', e.target.checked)} /> All day</label>
            {!f.all_day && <>
              <Field label="Start"><input type="time" value={f.start_time ?? ''} onChange={(e) => set('start_time', e.target.value)} /></Field>
              <Field label="End" hint={data.proposal.end_time_assumed ? 'No end time was set — one hour is proposed' : undefined}><input type="time" value={f.end_time ?? ''} onChange={(e) => set('end_time', e.target.value)} /></Field>
            </>}
          </div>
          <Field label="Location"><input value={f.location ?? ''} onChange={(e) => set('location', e.target.value)} /></Field>
          <Field label="Description"><textarea rows={3} value={f.description ?? ''} onChange={(e) => set('description', e.target.value)} /></Field>
        </div>
      ) : (
        <div className="stack">
          {dupWarning && (
            <div className="note warn">
              You already added this event to Google {data.previous_exports.map((p: any) => new Date(p.exported_at).toLocaleDateString()).join(', ')}.
              Continuing creates another copy — only do this if you deleted the previous one.
            </div>
          )}
          <div className="preview-card">
            <b>{f.title}</b>
            <span>{day(f.date, { weekday: 'long', day: 'numeric', month: 'long' })} · {f.all_day || !f.start_time ? 'All day' : `${f.start_time}–${f.end_time || '?'}`}</span>
            {f.location && <span>{f.location}</span>}
            <span className="muted">→ {dest?.summary} ({dest?.google_email})</span>
          </div>
        </div>
      )}
    </Sheet>
  );
}
