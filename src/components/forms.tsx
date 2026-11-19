import { useEffect, useState } from 'react';
import { api, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { money, parseMoney } from '../lib/format';
import { Field, useAction } from './ui';

export const DECISIONS = [
  ['idea', 'Idea'], ['considering', 'Considering'], ['discussing', 'Discussing'], ['approved', 'Approved'], ['purchased', 'Purchased / booked'], ['rejected', 'Rejected'],
] as const;
export const STAGES = [['', '—'], ['suggested', 'Suggested'], ['preferred', 'Preferred option'], ['agreed', 'Agreed purchase'], ['purchased', 'Purchased']] as const;
export const TASK_STATUS = [['todo', 'To do'], ['planned', 'Planned'], ['in_progress', 'In progress'], ['waiting', 'Waiting'], ['completed', 'Completed'], ['archived', 'Archived']] as const;
export const ROOMS = ['Kitchen', 'Living room', 'Bedroom', 'Bathroom', 'Office', 'Hallway', 'Storage', 'Outdoor', 'Other'];

function PeopleSelect({ value, onChange, label, allowNone = true, space }: { value: string | null; onChange: (v: string | null) => void; label: string; allowNone?: boolean; space: 'me' | 'us' }) {
  const me = useMe();
  const people = space === 'me' ? me.members.filter((m) => m.id === me.user.id) : me.members;
  return (
    <Field label={label}>
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        {allowNone && <option value="">Nobody</option>}
        {people.map((m) => <option key={m.id} value={m.id}>{m.id === me.user.id ? `${m.display_name} (me)` : m.display_name}</option>)}
      </select>
    </Field>
  );
}

function MoneyInput({ cents, onChange, label, currency }: { cents: number | null; onChange: (c: number | null) => void; label: string; currency: string }) {
  const [text, setText] = useState(cents != null ? (cents / 100).toFixed(2) : '');
  useEffect(() => { setText(cents != null ? (cents / 100).toFixed(2) : ''); }, [cents]);
  return (
    <Field label={`${label} (${currency})`}>
      <input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(parseMoney(text))} placeholder="0.00" />
    </Field>
  );
}

// ------------------------------------------------------------------- items
export function ItemForm({ item, module, space, onSaved, onCancel }: { item?: any; module: 'grocery' | 'home' | 'idea'; space: 'me' | 'us'; onSaved: (item: any) => void; onCancel?: () => void }) {
  const me = useMe();
  const { data: cats } = useApi<{ categories: any[] }>(`/spaces/${space}/categories?module=${module}`);
  const { data: lists } = useApi<{ lists: any[] }>(`/spaces/${space}/lists?module=${module}`);
  const [f, setF] = useState<any>(() => ({
    title: '', notes: '', priority: 'normal', quantity: null, unit: '', category_id: null, grocery_state: 'need', decision_status: 'idea', purchase_stage: '',
    link_url: '', price_cents: null, room: '', dimensions: '', color_material: '', store: '', target_date: '', expires_on: '', storage_location: '',
    assigned_to: null, intended_for_user_id: null, intended_for_name: '', idea_type: '', tags: [], list_id: '', ...(item ?? {}),
    tagsText: (item?.tags ?? []).join(', '),
  }));
  const [preview, setPreview] = useState<any>(null);
  const { busy, run } = useAction();
  const set = (k: string, v: unknown) => setF((x: any) => ({ ...x, [k]: v }));
  const currency = f.currency ?? me.household.currency;

  const fetchPreview = () => run(async () => {
    if (!f.link_url) return;
    const p = await api.post('/link-preview', { url: f.link_url });
    setPreview(p);
    if (p.ok) {
      setF((x: any) => ({ ...x, title: x.title || p.title || '', link_title: p.title, link_image_url: p.image_url, price_cents: x.price_cents ?? p.price_cents, currency: x.currency ?? p.currency ?? undefined }));
    }
  });

  const save = () => run(async () => {
    const body: any = {
      title: f.title, notes: f.notes ?? '', priority: f.priority, category_id: f.category_id || null,
      quantity: f.quantity === '' || f.quantity == null ? null : Number(f.quantity), unit: f.unit || null,
      assigned_to: f.assigned_to || null, tags: String(f.tagsText ?? '').split(',').map((t: string) => t.trim()).filter(Boolean),
      link_url: f.link_url || null, link_title: f.link_title || null, link_image_url: f.link_image_url || null, price_cents: f.price_cents ?? null,
      currency: f.price_cents != null ? currency : null, store: f.store || null,
    };
    if (module === 'grocery') Object.assign(body, { expires_on: f.expires_on || null, storage_location: f.storage_location || null });
    if (module !== 'grocery') Object.assign(body, { decision_status: f.decision_status, purchase_stage: f.purchase_stage || null, target_date: f.target_date || null });
    if (module === 'home') Object.assign(body, { room: f.room || null, dimensions: f.dimensions || null, color_material: f.color_material || null });
    if (module === 'idea') Object.assign(body, { idea_type: f.idea_type || null, intended_for_user_id: f.intended_for_user_id || null, intended_for_name: f.intended_for_name || null });
    let saved;
    if (item) saved = (await api.patch(`/items/${item.id}`, { ...body, list_id: f.list_id || undefined })).item;
    else saved = (await api.post(`/spaces/${space}/items`, { ...body, module, grocery_state: module === 'grocery' ? f.grocery_state : undefined, list_id: f.list_id || undefined })).item;
    onSaved(saved);
  });

  const groups = new Map<string, any[]>();
  for (const c of cats?.categories ?? []) groups.set(c.group_name ?? '', [...(groups.get(c.group_name ?? '') ?? []), c]);

  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <Field label="Name"><input value={f.title} onChange={(e) => set('title', e.target.value)} required maxLength={200} autoFocus={!item} /></Field>
      <div className="grid-2">
        {module === 'grocery' && !item && (
          <Field label="List"><select value={f.grocery_state} onChange={(e) => set('grocery_state', e.target.value)}><option value="need">NEED</option><option value="stock">STOCK</option></select></Field>
        )}
        {(lists?.lists.length ?? 0) > 1 && (
          <Field label="List"><select value={f.list_id || lists!.lists.find((l: any) => l.is_default)?.id} onChange={(e) => set('list_id', e.target.value)}>{lists!.lists.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        )}
        <Field label="Category">
          <select value={f.category_id ?? ''} onChange={(e) => set('category_id', e.target.value || null)}>
            <option value="">—</option>
            {[...groups.entries()].map(([g, cs]) => g
              ? <optgroup key={g} label={g}>{cs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
              : cs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>))}
          </select>
        </Field>
        <Field label="Priority">
          <select value={f.priority} onChange={(e) => set('priority', e.target.value)}>
            <option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option>
          </select>
        </Field>
        {module === 'grocery' && <>
          <Field label="Quantity"><input type="number" min={0} step="any" value={f.quantity ?? ''} onChange={(e) => set('quantity', e.target.value)} /></Field>
          <Field label="Unit"><input value={f.unit ?? ''} onChange={(e) => set('unit', e.target.value)} placeholder="e.g. kg, pack" maxLength={20} /></Field>
        </>}
        {module !== 'grocery' && (
          <Field label="Status"><select value={f.decision_status ?? 'idea'} onChange={(e) => set('decision_status', e.target.value)}>{DECISIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        )}
        {module !== 'grocery' && (
          <Field label="Purchase stage"><select value={f.purchase_stage ?? ''} onChange={(e) => set('purchase_stage', e.target.value)}>{STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        )}
        {module === 'idea' && <Field label="Type"><input value={f.idea_type ?? ''} onChange={(e) => set('idea_type', e.target.value)} placeholder="Gift, restaurant, trip…" maxLength={60} /></Field>}
        {module === 'idea' && space === 'us' && (
          <PeopleSelect label="Intended for" value={f.intended_for_user_id} onChange={(v) => set('intended_for_user_id', v)} space={space} />
        )}
        {module === 'idea' && <Field label="…or someone else"><input value={f.intended_for_name ?? ''} onChange={(e) => set('intended_for_name', e.target.value)} placeholder="e.g. Mary" maxLength={60} /></Field>}
        {module === 'home' && <>
          <Field label="Room"><select value={f.room ?? ''} onChange={(e) => set('room', e.target.value)}><option value="">—</option>{ROOMS.map((r) => <option key={r}>{r}</option>)}</select></Field>
          <Field label="Dimensions"><input value={f.dimensions ?? ''} onChange={(e) => set('dimensions', e.target.value)} placeholder="W × D × H" maxLength={120} /></Field>
          <Field label="Colour / material"><input value={f.color_material ?? ''} onChange={(e) => set('color_material', e.target.value)} maxLength={120} /></Field>
        </>}
        {module !== 'grocery' && <Field label="Target date"><input type="date" value={f.target_date ?? ''} onChange={(e) => set('target_date', e.target.value)} /></Field>}
        {space === 'us' && <PeopleSelect label="Assigned to" value={f.assigned_to} onChange={(v) => set('assigned_to', v)} space={space} />}
        <MoneyInput label="Price" cents={f.price_cents} onChange={(c) => set('price_cents', c)} currency={currency} />
        <Field label="Store"><input value={f.store ?? ''} onChange={(e) => set('store', e.target.value)} maxLength={120} /></Field>
        {module === 'grocery' && (item?.grocery_state === 'stock' || f.grocery_state === 'stock') && <>
          <Field label="Expires"><input type="date" value={f.expires_on ?? ''} onChange={(e) => set('expires_on', e.target.value)} /></Field>
          <Field label="Stored in"><input value={f.storage_location ?? ''} onChange={(e) => set('storage_location', e.target.value)} placeholder="Fridge, pantry…" maxLength={80} /></Field>
        </>}
      </div>
      <Field label="Link" hint={preview && !preview.ok ? `${preview.reason}. The link is kept; add a reference photo instead.` : preview?.ok ? `Preview: ${preview.title ?? preview.site_name}${preview.price_cents ? ` · ${money(preview.price_cents, preview.currency ?? currency)}` : ''}` : undefined}>
        <div className="row gap-s">
          <input className="grow" type="url" value={f.link_url ?? ''} onChange={(e) => set('link_url', e.target.value)} placeholder="https://" />
          <button type="button" className="btn ghost" onClick={fetchPreview} disabled={!f.link_url || busy}>Fetch preview</button>
        </div>
      </Field>
      {f.link_image_url && <img className="link-thumb" src={f.link_image_url} alt="" referrerPolicy="no-referrer" />}
      <Field label="Notes"><textarea value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} rows={3} maxLength={5000} /></Field>
      <Field label="Tags" hint="Separate with commas"><input value={f.tagsText} onChange={(e) => set('tagsText', e.target.value)} /></Field>
      <div className="row gap-s end">
        {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>}
        <button className="btn primary" disabled={busy || !f.title.trim()}>{item ? 'Save changes' : 'Add'}</button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------- tasks
export function TaskForm({ task, space, onSaved, onCancel, kind }: { task?: any; space: 'me' | 'us'; onSaved: (t: any) => void; onCancel?: () => void; kind?: 'todo' | 'maintenance' }) {
  const me = useMe();
  const [f, setF] = useState<any>(() => ({
    title: '', description: '', due_date: '', due_time: '', priority: 'normal', assignee: 'none', assigned_user_id: null, status: 'todo',
    reminder_local: '', recurrence_unit: '', recurrence_interval: 1, kind: kind ?? 'todo', ...(task ?? {}),
  }));
  useEffect(() => {
    if (task?.reminder_at) {
      const d = new Date(task.reminder_at);
      const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      setF((x: any) => ({ ...x, reminder_local: local }));
    }
  }, [task?.reminder_at]);
  const { busy, run } = useAction();
  const set = (k: string, v: unknown) => setF((x: any) => ({ ...x, [k]: v }));
  const assignValue = f.assignee === 'both' ? 'both' : f.assignee === 'user' ? f.assigned_user_id : '';
  const save = () => run(async () => {
    const body = {
      title: f.title, description: f.description ?? '', due_date: f.due_date || null, due_time: f.due_time || null, priority: f.priority,
      assignee: f.assignee, assigned_user_id: f.assignee === 'user' ? f.assigned_user_id : null, status: f.status, kind: f.kind,
      reminder_at: f.reminder_local ? new Date(f.reminder_local).toISOString() : null,
      recurrence_unit: f.recurrence_unit || null, recurrence_interval: f.recurrence_unit ? Number(f.recurrence_interval) || 1 : null,
    };
    const saved = task ? (await api.patch(`/tasks/${task.id}`, body)).task : (await api.post(`/spaces/${space}/tasks`, body)).task;
    onSaved(saved);
  });
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <Field label="Task"><input value={f.title} onChange={(e) => set('title', e.target.value)} required maxLength={200} autoFocus={!task} /></Field>
      <div className="grid-2">
        <Field label="Due date" hint="Optional — not everything needs a date"><input type="date" value={f.due_date ?? ''} onChange={(e) => set('due_date', e.target.value)} /></Field>
        <Field label="Time"><input type="time" value={f.due_time ?? ''} onChange={(e) => set('due_time', e.target.value)} disabled={!f.due_date} /></Field>
        <Field label="Assigned to">
          <select value={assignValue ?? ''} onChange={(e) => {
            const v = e.target.value;
            if (!v) setF((x: any) => ({ ...x, assignee: 'none', assigned_user_id: null }));
            else if (v === 'both') setF((x: any) => ({ ...x, assignee: 'both', assigned_user_id: null }));
            else setF((x: any) => ({ ...x, assignee: 'user', assigned_user_id: v }));
          }}>
            <option value="">Nobody</option>
            <option value={me.user.id}>ME ({me.user.display_name})</option>
            {space === 'us' && me.partner && <option value={me.partner.id}>YOU ({me.partner.display_name})</option>}
            {space === 'us' && me.partner && <option value="both">BOTH</option>}
          </select>
        </Field>
        <Field label="Priority"><select value={f.priority} onChange={(e) => set('priority', e.target.value)}><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></Field>
        <Field label="Status"><select value={f.status} onChange={(e) => set('status', e.target.value)}>{TASK_STATUS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Remind me"><input type="datetime-local" value={f.reminder_local} onChange={(e) => set('reminder_local', e.target.value)} /></Field>
        <Field label="Repeats">
          <div className="row gap-s">
            <span className="muted small">every</span>
            <input type="number" min={1} max={365} className="qty-input" value={f.recurrence_interval ?? 1} onChange={(e) => set('recurrence_interval', e.target.value)} disabled={!f.recurrence_unit} aria-label="Interval" />
            <select value={f.recurrence_unit ?? ''} onChange={(e) => set('recurrence_unit', e.target.value)} aria-label="Repeat unit">
              <option value="">Doesn’t repeat</option><option value="day">day(s)</option><option value="week">week(s)</option><option value="month">month(s)</option><option value="year">year(s)</option>
            </select>
          </div>
        </Field>
        <Field label="Type"><select value={f.kind} onChange={(e) => set('kind', e.target.value)}><option value="todo">To-do</option><option value="maintenance">Home maintenance</option></select></Field>
      </div>
      <Field label="Details"><textarea value={f.description ?? ''} onChange={(e) => set('description', e.target.value)} rows={3} maxLength={5000} /></Field>
      <div className="row gap-s end">
        {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>}
        <button className="btn primary" disabled={busy || !f.title.trim()}>{task ? 'Save changes' : 'Add task'}</button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ events
export function EventForm({ event, initial, space: initialSpace, onSaved, onCancel, chooseSpace }: { event?: any; initial?: any; space: 'me' | 'us'; onSaved: (e: any) => void; onCancel?: () => void; chooseSpace?: boolean }) {
  const me = useMe();
  const [space, setSpace] = useState<'me' | 'us'>(initialSpace);
  const [f, setF] = useState<any>(() => ({
    title: '', date: '', end_date: '', start_time: '', end_time: '', all_day: false, location: '', description: '', notes: '', participantsText: '', category: '', for_user_id: null,
    ...(event ? { ...event, date: event.start_date, end_date: event.end_date !== event.start_date ? event.end_date : '' } : {}),
    ...(initial ?? {}),
  }));
  useEffect(() => { setF((x: any) => ({ ...x, participantsText: (x.participants ?? []).join(', ') })); }, []);
  const { busy, run } = useAction();
  const set = (k: string, v: unknown) => setF((x: any) => ({ ...x, [k]: v }));
  const save = () => run(async () => {
    const body = {
      title: f.title, date: f.date, end_date: f.end_date || null, all_day: Boolean(f.all_day), start_time: f.all_day ? null : f.start_time || null, end_time: f.all_day ? null : f.end_time || null,
      location: f.location ?? '', description: f.description ?? '', notes: f.notes ?? '', category: f.category || null, for_user_id: f.for_user_id || null,
      participants: String(f.participantsText ?? '').split(',').map((s: string) => s.trim()).filter(Boolean),
      yearly: Boolean(f.yearly),
      ...(event ? {} : { source_type: initial?.from_text ? 'text' : 'manual' }),
    };
    const saved = event ? (await api.patch(`/events/${event.id}`, body)).event : (await api.post(`/spaces/${space}/events`, body)).event;
    onSaved(saved);
  });
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); save(); }}>
      {event?.source_type === 'google' && <p className="note subtle">Imported from Google Calendar “{event.google_calendar_name}”. Changes here only affect OUR HOME — the original Google event is never modified.</p>}
      <Field label="Title"><input value={f.title} onChange={(e) => set('title', e.target.value)} required maxLength={300} /></Field>
      <div className="grid-2">
        <Field label="Date"><input type="date" value={f.date ?? ''} onChange={(e) => set('date', e.target.value)} required /></Field>
        <Field label="Ends (date)" hint="For multi-day events"><input type="date" value={f.end_date ?? ''} min={f.date} onChange={(e) => set('end_date', e.target.value)} /></Field>
        <label className="check"><input type="checkbox" checked={Boolean(f.all_day)} onChange={(e) => set('all_day', e.target.checked)} /> All day</label>
        <span />
        {!f.all_day && <>
          <Field label="Start time" hint={!f.start_time ? 'Leave empty if not known yet' : undefined}><input type="time" value={f.start_time ?? ''} onChange={(e) => set('start_time', e.target.value)} /></Field>
          <Field label="End time"><input type="time" value={f.end_time ?? ''} onChange={(e) => set('end_time', e.target.value)} disabled={!f.start_time} /></Field>
        </>}
        <Field label="Location"><input value={f.location ?? ''} onChange={(e) => set('location', e.target.value)} maxLength={500} /></Field>
        <Field label="Category" hint="Birthdays, anniversaries, social events and holidays show under Important dates">
          <input list="event-categories" value={f.category ?? ''} onChange={(e) => { const v = e.target.value; setF((x: any) => ({ ...x, category: v, yearly: ['birthday', 'anniversary'].includes(v.toLowerCase()) ? true : x.yearly })); }} maxLength={60} placeholder="Birthday, Social, Health…" />
          <datalist id="event-categories">{['Birthday', 'Anniversary', 'Social', 'Holiday', 'Important', 'Health', 'Work', 'Travel'].map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <label className="check"><input type="checkbox" checked={Boolean(f.yearly)} onChange={(e) => set('yearly', e.target.checked)} /> Repeats every year</label>
        <Field label="Participants" hint="Comma separated"><input value={f.participantsText ?? ''} onChange={(e) => set('participantsText', e.target.value)} /></Field>
        <Field label="Who is this about?">
          <select value={f.for_user_id ?? ''} onChange={(e) => set('for_user_id', e.target.value || null)}>
            <option value="">Household</option>
            {me.members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
          </select>
        </Field>
        {chooseSpace && !event && (
          <label className="check"><input type="checkbox" checked={space === 'me'} onChange={(e) => setSpace(e.target.checked ? 'me' : 'us')} /> Private: only I can see it</label>
        )}
      </div>
      <Field label="Description"><textarea value={f.description ?? ''} onChange={(e) => set('description', e.target.value)} rows={3} /></Field>
      <div className="row gap-s end">
        {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>}
        <button className="btn primary" disabled={busy || !f.title.trim() || !f.date}>{event ? 'Save changes' : space === 'us' ? 'Save (shared)' : 'Save (private)'}</button>
      </div>
    </form>
  );
}

// --------------------------------------------------------------- inventory
export function InventoryForm({ item, space, onSaved, onCancel }: { item?: any; space: 'me' | 'us'; onSaved: (i: any) => void; onCancel?: () => void }) {
  const me = useMe();
  const [f, setF] = useState<any>(() => ({ name: '', room: 'Living room', category: '', brand: '', model: '', dimensions: '', purchase_date: '', price_cents: null, warranty_until: '', warranty_notes: '', manual_url: '', notes: '', ...(item ?? {}) }));
  const { busy, run } = useAction();
  const set = (k: string, v: unknown) => setF((x: any) => ({ ...x, [k]: v }));
  const save = () => run(async () => {
    const body: any = {};
    for (const k of ['name', 'room', 'category', 'brand', 'model', 'dimensions', 'warranty_notes', 'notes']) body[k] = f[k] ?? (k === 'notes' ? '' : null);
    for (const k of ['purchase_date', 'warranty_until']) body[k] = f[k] || null;
    body.manual_url = f.manual_url || null;
    body.price_cents = f.price_cents ?? null;
    body.currency = f.price_cents != null ? me.household.currency : null;
    const saved = item ? (await api.patch(`/inventory/${item.id}`, body)).item : (await api.post(`/spaces/${space}/inventory`, body)).item;
    onSaved(saved);
  });
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <Field label="Name"><input value={f.name} onChange={(e) => set('name', e.target.value)} required maxLength={200} /></Field>
      <div className="grid-2">
        <Field label="Room"><select value={f.room} onChange={(e) => set('room', e.target.value)}>{ROOMS.map((r) => <option key={r}>{r}</option>)}</select></Field>
        <Field label="Type"><input value={f.category ?? ''} onChange={(e) => set('category', e.target.value)} placeholder="Furniture, appliance, tool…" /></Field>
        <Field label="Brand"><input value={f.brand ?? ''} onChange={(e) => set('brand', e.target.value)} /></Field>
        <Field label="Model"><input value={f.model ?? ''} onChange={(e) => set('model', e.target.value)} /></Field>
        <Field label="Dimensions"><input value={f.dimensions ?? ''} onChange={(e) => set('dimensions', e.target.value)} /></Field>
        <Field label="Purchased"><input type="date" value={f.purchase_date ?? ''} onChange={(e) => set('purchase_date', e.target.value)} /></Field>
        <MoneyInput label="Price" cents={f.price_cents} onChange={(c) => set('price_cents', c)} currency={me.household.currency} />
        <Field label="Warranty until"><input type="date" value={f.warranty_until ?? ''} onChange={(e) => set('warranty_until', e.target.value)} /></Field>
      </div>
      <Field label="Manual or product link"><input type="url" value={f.manual_url ?? ''} onChange={(e) => set('manual_url', e.target.value)} placeholder="https://" /></Field>
      <Field label="Warranty notes"><input value={f.warranty_notes ?? ''} onChange={(e) => set('warranty_notes', e.target.value)} /></Field>
      <Field label="Notes"><textarea value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} rows={2} /></Field>
      <div className="row gap-s end">
        {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>}
        <button className="btn primary" disabled={busy || !f.name.trim()}>{item ? 'Save changes' : 'Add to inventory'}</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- expenses
export function ExpenseForm({ space, onSaved, onCancel, expense }: { space: 'me' | 'us'; onSaved: () => void; onCancel?: () => void; expense?: any }) {
  const me = useMe();
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState<any>(() => ({ title: '', amount_cents: null, purchase_date: today, purchaser_id: me.user.id, category: '', notes: '', split_mode: space === 'us' ? 'equal' : 'individual', alloc: {} as Record<string, number | null>, ...(expense ?? {}) }));
  const { busy, run } = useAction();
  const set = (k: string, v: unknown) => setF((x: any) => ({ ...x, [k]: v }));
  const save = () => run(async () => {
    const body: any = { title: f.title, amount_cents: f.amount_cents, purchase_date: f.purchase_date, purchaser_id: f.purchaser_id, category: f.category || null, notes: f.notes ?? '', split_mode: f.split_mode };
    if (f.split_mode === 'custom') body.allocations = me.members.map((m) => ({ user_id: m.id, amount_cents: f.alloc[m.id] ?? 0 }));
    if (expense) await api.patch(`/expenses/${expense.id}`, body);
    else await api.post(`/spaces/${space}/expenses`, body);
    onSaved();
  });
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <Field label="What"><input value={f.title} onChange={(e) => set('title', e.target.value)} required maxLength={200} /></Field>
      <div className="grid-2">
        <MoneyInput label="Amount" cents={f.amount_cents} onChange={(c) => set('amount_cents', c)} currency={me.household.currency} />
        <Field label="Date"><input type="date" value={f.purchase_date} onChange={(e) => set('purchase_date', e.target.value)} required /></Field>
        <Field label="Paid by"><select value={f.purchaser_id ?? ''} onChange={(e) => set('purchaser_id', e.target.value)}>{(space === 'us' ? me.members : me.members.filter((m) => m.id === me.user.id)).map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></Field>
        <Field label="Category"><input value={f.category ?? ''} onChange={(e) => set('category', e.target.value)} placeholder="Groceries, Home, Utilities…" /></Field>
        {space === 'us' && (
          <Field label="Who is responsible">
            <select value={f.split_mode} onChange={(e) => set('split_mode', e.target.value)}>
              <option value="equal">Shared equally</option><option value="custom">Custom amounts</option><option value="individual">Not shared (just recorded)</option>
            </select>
          </Field>
        )}
      </div>
      {f.split_mode === 'custom' && (
        <div className="grid-2">
          {me.members.map((m) => <MoneyInput key={m.id} label={m.display_name} cents={f.alloc[m.id] ?? null} onChange={(c) => setF((x: any) => ({ ...x, alloc: { ...x.alloc, [m.id]: c } }))} currency={me.household.currency} />)}
        </div>
      )}
      <Field label="Notes"><textarea value={f.notes ?? ''} onChange={(e) => set('notes', e.target.value)} rows={2} /></Field>
      <div className="row gap-s end">
        {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>}
        <button className="btn primary" disabled={busy || !f.title.trim() || f.amount_cents == null}>Save expense</button>
      </div>
    </form>
  );
}
