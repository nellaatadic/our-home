import { useState } from 'react';
import { Archive, CalendarDays, CalendarPlus, Check, Clock, History as HistoryIcon, MapPin, MessageCircle, Pencil, Plus, Tag, User, Users } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { day, dueLabel, eventTime, todayLocal } from '../lib/format';
import { EventForm } from './forms';
import { ExportDialog } from './ExportDialog';
import { ItemRow } from './ItemRow';
import { Linked } from './Linked';
import { NewListSheet } from './ListSheets';
import { Thread } from './Thread';
import { CommonActions, History, Reactions } from './EntitySheet';
import { useOpen } from './Layout';
import { ErrorNote, Loading, Sheet, SpaceTag, useAction } from './ui';

/**
 * An event as a pop-up: details and people, a checklist of what has to
 * happen first, lists of its own (what to buy or bring), everything linked
 * to it, and its chat. Adding a checklist step or a list makes it a plan,
 * which asks to be archived once it is over.
 */
export function EventSheet({ id, onClose, startInChat }: { id: string; onClose: () => void; startInChat?: boolean }) {
  const me = useMe();
  const open = useOpen();
  const { data: ev, error, reload: reloadEvent } = useApi<{ event: any }>(`/events/${id}`);
  const { data, reload } = useApi<{ plan: any; checklist: any[]; lists: any[] }>(`/plans/${id}`);
  const { run, busy } = useAction();
  const [editing, setEditing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [history, setHistory] = useState(false);
  const [newList, setNewList] = useState(false);
  const [task, setTask] = useState('');
  const [taskDate, setTaskDate] = useState('');
  const [who, setWho] = useState('none');
  const [tags, setTags] = useState<string | null>(null);
  const today = todayLocal(me.household.timezone);
  const refresh = () => { reload(); reloadEvent(); emitChange(); };

  if (error) return <Sheet title="Not available" onClose={onClose}><ErrorNote error={error} /></Sheet>;
  if (!ev || !data) return <Sheet title="Loading…" onClose={onClose}><Loading /></Sheet>;
  const e = ev.event;
  const { plan, checklist, lists } = data;
  const archived = Boolean(e.archived_at);
  const priv = e.space === 'me';
  const done = checklist.filter((t) => t.status === 'completed').length;
  const readOnly = archived || e.availability_only;

  const addTask = () => task.trim() && run(async () => {
    const assign = who === 'both' ? { assignee: 'both' } : who === 'none' ? { assignee: 'none' } : { assignee: 'user', assigned_user_id: who };
    await api.post(`/spaces/${e.space}/tasks`, { title: task.trim(), related_event_id: e.id, due_date: taskDate || null, ...assign });
    setTask(''); setTaskDate('');
    refresh();
  });
  const toggleTask = (t: any) => run(async () => { await api.patch(`/tasks/${t.id}`, { status: t.status === 'completed' ? 'todo' : 'completed' }); refresh(); });
  const toggleItem = (i: any) => run(async () => { await api.post(`/items/${i.id}/${i.grocery_state === 'stock' ? 'need' : 'purchase'}`, {}); refresh(); });

  return (
    <Sheet onClose={onClose} title={<span className="row gap-s"><SpaceTag space={e.space} /> <span className="clamp1">{e.title}</span></span>}>
      <div className="event-pop">
        {editing ? (
          <EventForm event={e} space={e.space} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }} />
        ) : (
          <section className="ep-details">
            <p><CalendarDays size={15} /> {day(e.start_date, { weekday: 'long', month: 'long', day: 'numeric' })}{e.end_date && e.end_date !== e.start_date ? ` – ${day(e.end_date, { month: 'short', day: 'numeric' })}` : ''}</p>
            <p><Clock size={15} /> {eventTime(e)}</p>
            {e.location && <p><MapPin size={15} /> {e.location}</p>}
            <p className="ep-people"><Users size={15} /> {e.participants?.length ? e.participants.map((p: string) => <span key={p} className="person-chip">{p}</span>) : <span className="muted">No one added</span>}</p>
            {e.for_user_name && <p><User size={15} /> About {e.for_user_id === me.user.id ? 'you' : e.for_user_name}</p>}
            {e.description && <p className="prose pre">{e.description}</p>}
            <div className="ep-tags">
              {(e.tags ?? []).map((t: string) => <span key={t} className="tag-chip">#{t}</span>)}
              {tags === null ? (
                !readOnly && <button className="link-btn tiny" onClick={() => setTags((e.tags ?? []).join(', '))}><Tag size={12} /> {e.tags?.length ? 'Tags' : 'Add tags'}</button>
              ) : (
                <form className="row gap-s" onSubmit={(x) => { x.preventDefault(); run(async () => { await api.patch(`/events/${e.id}`, { tags: tags.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean) }); setTags(null); refresh(); }); }}>
                  <input autoFocus className="tag-input" value={tags} onChange={(x) => setTags(x.target.value)} placeholder="marco, birthday" aria-label="Tags, comma separated" />
                  <button className="btn small">Save</button>
                </form>
              )}
            </div>
            {!readOnly && <button className="btn small" onClick={() => setEditing(true)}><Pencil size={14} /> Edit details and people</button>}
            {e.availability_only && <p className="note subtle">Availability only: the details of this private event were not shared.</p>}
            {e.source_type === 'google' && <p className="muted tiny">Changes here never change the original Google Calendar event.</p>}
          </section>
        )}

        {plan.ask_to_archive && (
          <div className="over-prompt">
            <span className="grow"><b>This is over.</b> Archive it? Its checklist, lists and chat stay together.</span>
            <button className="btn small primary" onClick={() => run(async () => { await api.post(`/entities/event/${e.id}/archive`); emitChange(); onClose(); }, `Archived “${e.title}”`)}><Archive size={14} /> Archive</button>
            <button className="link-btn" onClick={() => run(async () => { await api.post(`/plans/${e.id}/keep`); refresh(); })}>Not yet</button>
          </div>
        )}

        {!e.availability_only && <>
          <section className="ep-block">
            <h3><Check size={14} /> Checklist {checklist.length > 0 && <span className={`progress-pill ${done === checklist.length ? 'done' : ''}`}>{done}/{checklist.length}</span>}</h3>
            {checklist.length > 0 && (
              <ul className="todo-list">
                {checklist.map((t) => (
                  <li key={t.id} className={t.status === 'completed' ? 'done' : ''}>
                    <button className={`circle ${t.status === 'completed' ? 'on' : ''}`} onClick={() => toggleTask(t)} aria-label={t.status === 'completed' ? `Not done: ${t.title}` : `Done: ${t.title}`}><Check size={12} /></button>
                    <button className="item-main" onClick={() => open('task', t.id)}>
                      <span className="item-title">{t.title}</span>
                      <span className="item-meta">
                        {t.due_date && t.status !== 'completed' && <span className={t.due_date < today ? 'overdue' : t.due_date === today ? 'today' : ''}>{dueLabel(t.due_date, t.due_time, today)}</span>}
                        {t.assignee === 'both' ? <span>Both</span> : t.assigned_user_name ? <span>{t.assigned_user_id === me.user.id ? 'You' : t.assigned_user_name}</span> : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!readOnly && (
              <form className="card-x-add wrap" onSubmit={(x) => { x.preventDefault(); addTask(); }}>
                <Plus size={16} className="muted" aria-hidden />
                <input value={task} onChange={(x) => setTask(x.target.value)} placeholder="Make a reservation, buy a gift…" aria-label="New checklist step" />
                <input type="date" value={taskDate} onChange={(x) => setTaskDate(x.target.value)} aria-label="Do by" title="Do by" />
                <select value={who} onChange={(x) => setWho(x.target.value)} aria-label="Who">
                  <option value="none">Anyone</option>
                  <option value={me.user.id}>Me</option>
                  {!priv && me.partner && <option value={me.partner.id}>{me.partner.display_name}</option>}
                  {!priv && me.partner && <option value="both">Both</option>}
                </select>
                <button className="btn small primary" disabled={!task.trim() || busy}>Add</button>
              </form>
            )}
          </section>

          {lists.map((l) => <EventList key={l.id} list={l} readOnly={readOnly} onToggle={toggleItem} onAdded={refresh} />)}
          {!readOnly && <button className="add-card slim" onClick={() => setNewList(true)}><Plus size={15} /> Add a list (shopping, what to bring, guests…)</button>}

          <Linked type="event" id={e.id} />

          <section className="ep-block ep-chat">
            <h3><MessageCircle size={14} /> Chat</h3>
            <Thread type="event" id={e.id} space={e.space} compact={!startInChat} autoFocus={startInChat} />
          </section>
          {e.space === 'us' && <Reactions type="event" entity={e} onChange={reloadEvent} />}
        </>}

        <div className="ep-foot">
          <button className="btn small ghost" onClick={() => setExporting(true)}><CalendarPlus size={14} /> Add to my Google Calendar</button>
          <button className="btn small ghost" onClick={() => setHistory((x) => !x)}><HistoryIcon size={14} /> History</button>
        </div>
        {history && <History type="event" id={e.id} />}
        <CommonActions type="event" entity={e} onDone={onClose} reload={refresh} />
      </div>
      {exporting && <ExportDialog eventId={e.id} onClose={() => { setExporting(false); reloadEvent(); }} />}
      {newList && <NewListSheet eventId={e.id} onClose={() => setNewList(false)} onCreated={() => { setNewList(false); refresh(); }} />}
    </Sheet>
  );
}

function EventList({ list, readOnly, onToggle, onAdded }: { list: any; readOnly: boolean; onToggle: (i: any) => void; onAdded: () => void }) {
  const [title, setTitle] = useState('');
  const { run, busy } = useAction();
  const open = list.items.filter((i: any) => i.grocery_state === 'need');
  const got = list.items.filter((i: any) => i.grocery_state === 'stock');
  const add = () => title.trim() && run(async () => {
    await api.post('/modules/custom/items', { list_id: list.id, title: title.trim() });
    setTitle('');
    onAdded();
  });
  return (
    <section className="ep-block card-x flat" style={{ ['--list' as any]: list.color ?? 'var(--accent)' }}>
      <span className="bar" aria-hidden />
      <h3><span className="dot small" aria-hidden>{list.emoji ?? ''}</span> {list.name} {list.items.length > 0 && <span className="progress-pill">{got.length}/{list.items.length}</span>}</h3>
      <ul className="items compact">{[...open, ...got].map((i: any) => <ItemRow key={i.id} item={i} compact onCheck={() => onToggle(i)} />)}</ul>
      {!readOnly && (
        <form className="card-x-add" onSubmit={(x) => { x.preventDefault(); add(); }}>
          <Plus size={16} className="muted" aria-hidden />
          <input value={title} onChange={(x) => setTitle(x.target.value)} placeholder={`Add to ${list.name}…`} aria-label={`New item in ${list.name}`} />
          <button className="btn small primary" disabled={!title.trim() || busy}>Add</button>
        </form>
      )}
    </section>
  );
}
