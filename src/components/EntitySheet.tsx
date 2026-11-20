import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Linked } from './Linked';
import { Archive, ArchiveRestore, CalendarPlus, ChevronRight, ClipboardList, ExternalLink, ImagePlus, Pencil, Share2, Star, Trash2, Undo2 } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { day, eventTime, money, qty, relative } from '../lib/format';
import { prepareUpload } from '../lib/image';
import { Thread } from './Thread';
import { ShareDialog } from './ShareDialog';
import { EventForm, InventoryForm, ItemForm, TaskForm, DECISIONS, STAGES, TASK_STATUS } from './forms';
import { ExportDialog } from './ExportDialog';
import { Confirm, ErrorNote, Loading, PriorityDot, Segmented, Sheet, SpaceTag, useAction, useToast } from './ui';
import type { OpenType } from './Layout';
import { ItemSheet } from './ItemSheet';
import { EventSheet } from './EventSheet';

const REACTIONS = [['love', '❤️', 'Love it'], ['yes', '👍', 'In favour'], ['unsure', '🤔', 'Unsure'], ['no', '👎', 'Not keen']] as const;

export function Reactions({ type, entity, onChange }: { type: string; entity: any; onChange: () => void }) {
  const me = useMe();
  const { run } = useAction();
  const mine = entity.reactions?.find((r: any) => r.user_id === me.user.id)?.reaction ?? null;
  return (
    <div className="reactions" role="group" aria-label="Your reaction">
      {REACTIONS.map(([key, emoji, label]) => {
        const who = entity.reactions?.filter((r: any) => r.reaction === key).map((r: any) => r.name) ?? [];
        return (
          <button key={key} className={`reaction ${mine === key ? 'on' : ''}`} title={`${label}${who.length ? ` — ${who.join(', ')}` : ''}`} aria-pressed={mine === key}
            onClick={() => run(async () => { await api.post(`/entities/${type}/${entity.id}/reaction`, { reaction: mine === key ? null : key }); onChange(); emitChange(); })}>
            {emoji}{who.length > 0 && <span>{who.length}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function CommonActions({ type, entity, onDone, reload, extra }: { type: OpenType; entity: any; onDone: () => void; reload: () => void; extra?: ReactNode }) {
  const me = useMe();
  const { run } = useAction();
  const [share, setShare] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const shareable = type === 'item' || type === 'task' || type === 'event';
  const isPersonal = entity.space === 'me';
  return (
    <div className="actions-row">
      {extra}
      {shareable && isPersonal && !entity.shared_copy_id && !entity.archived_at && (
        <button className="btn small" onClick={() => setShare(true)}><Share2 size={14} /> Share with US</button>
      )}
      {shareable && isPersonal && entity.shared_copy_id && (
        <button className="btn small ghost" onClick={() => run(async () => { await api.post('/share/remove', { type, id: entity.id }); reload(); emitChange(); }, 'Removed from US (archived there)')}>Remove from US</button>
      )}
      <button className="btn small ghost" aria-pressed={entity.favorite} onClick={() => run(async () => { await api.post(`/entities/${type}/${entity.id}/favorite`, { favorite: !entity.favorite }); reload(); })}>
        <Star size={14} fill={entity.favorite ? 'currentColor' : 'none'} /> {entity.favorite ? 'Favourite' : 'Favourite'}
      </button>
      {!entity.archived_at ? (
        <button className="btn small ghost" onClick={() => run(async () => { await api.post(`/entities/${type}/${entity.id}/archive`); emitChange(); onDone(); }, 'Archived — find it in Archive')}><Archive size={14} /> Archive</button>
      ) : <>
        <button className="btn small ghost" onClick={() => run(async () => { await api.post(`/entities/${type}/${entity.id}/unarchive`); reload(); emitChange(); }, 'Restored')}><ArchiveRestore size={14} /> Restore</button>
        <button className="btn small danger-ghost" onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> Delete permanently</button>
      </>}
      {share && <ShareDialog type={type as 'item'} ids={[entity.id]} onClose={() => { setShare(false); reload(); }} />}
      {confirmDelete && (
        <Confirm title="Delete permanently?" danger confirmLabel="Delete forever" onClose={() => setConfirmDelete(false)}
          body={<p>“{entity.title ?? entity.name}” and its discussion will be deleted and cannot be recovered.{entity.space === 'us' && <> This is shared information — {me.partner?.display_name ?? 'your partner'} will lose it too.</>}</p>}
          onConfirm={() => run(async () => { await api.del(`/entities/${type}/${entity.id}${entity.space === 'us' ? '?confirm=permanent' : ''}`); emitChange(); onDone(); }, 'Deleted')} />
      )}
    </div>
  );
}

function Provenance({ e }: { e: any }) {
  const me = useMe();
  if (!e.origin_owner_name && !e.shared_copy_id && !e.imported_by_name) return null;
  return (
    <div className="provenance">
      {e.space === 'us' && e.origin_owner_name && (
        <span>Shared from {e.origin_owner_id === me.user.id ? 'your private space' : `${e.origin_owner_name}’s private space`}{e.shared_at ? ` · ${relative(e.shared_at)}` : ''}{e.modified_since_shared ? ' · edited since' : ''}</span>
      )}
      {e.space === 'me' && e.shared_copy_id && <span>A copy is shared with US{e.original_changed_since_shared ? ' · you changed this private version since sharing (the US copy was not updated)' : ''}</span>}
    </div>
  );
}

function Tabs({ tab, setTab, unread, total, hideDiscussion }: { tab: string; setTab: (t: any) => void; unread: number; total: number; hideDiscussion?: boolean }) {
  return (
    <Segmented label="Sections" value={tab} onChange={setTab} options={[
      { value: 'details', label: 'Details' },
      ...(hideDiscussion ? [] : [{ value: 'discussion', label: <>Discussion{total ? ` (${total})` : ''}{unread ? <b className="badge inline">{unread}</b> : null}</> }]),
      { value: 'history', label: 'History' },
    ]} />
  );
}

export function History({ type, id }: { type: string; id: string }) {
  const { data } = useApi<{ activity: any[] }>(`/entities/${type}/${id}/activity`);
  if (!data) return <Loading />;
  if (!data.activity.length) return <p className="muted">No history yet.</p>;
  return (
    <ul className="history">
      {data.activity.map((a, i) => <li key={i}><b>{a.actor_name ?? 'System'}</b> {a.summary || a.action} <span className="muted">· {relative(a.created_at)}</span></li>)}
    </ul>
  );
}

export function Images({ entityType, entity, reload }: { entityType: string; entity: any; reload: () => void }) {
  const { run, busy } = useAction();
  const imgs = (entity.images ?? entity.attachments ?? []).filter((a: any) => !a.content_type || a.content_type.startsWith('image/'));
  const files = (entity.attachments ?? []).filter((a: any) => a.content_type && !a.content_type.startsWith('image/'));
  const upload = (list: FileList | null) => list && run(async () => {
    for (const f of Array.from(list).slice(0, 6)) {
      const fd = new FormData();
      fd.set('entity_type', entityType);
      fd.set('entity_id', entity.id);
      fd.set('file', await prepareUpload(f));
      await api.post('/attachments', fd);
    }
    reload();
    emitChange();
  });
  return (
    <div className="images">
      {imgs.map((im: any) => <a key={im.id} href={im.url ?? `/api/attachments/${im.id}`} target="_blank" rel="noreferrer"><img src={im.url ?? `/api/attachments/${im.id}`} alt={im.filename} loading="lazy" /></a>)}
      {files.map((f: any) => <a key={f.id} className="chip" href={`/api/attachments/${f.id}`} target="_blank" rel="noreferrer">{f.filename}</a>)}
      <label className={`image-add ${busy ? 'busy' : ''}`}>
        <ImagePlus size={18} /><span>Add photo</span>
        <input type="file" accept="image/*,application/pdf" capture="environment" multiple hidden onChange={(e) => upload(e.target.files)} />
      </label>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  if (children === null || children === undefined || children === '' || children === false) return null;
  return <div className="kv"><span>{label}</span><div>{children}</div></div>;
}

function TaskDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const { data, error, reload } = useApi<{ task: any }>(`/tasks/${id}`);
  const [tab, setTab] = useState<'details' | 'discussion' | 'history'>('details');
  const [editing, setEditing] = useState(false);
  const { run } = useAction();
  const toast = useToast();
  if (error) return <Sheet title="Not available" onClose={onClose}><ErrorNote error={error} /></Sheet>;
  if (!data) return <Sheet title="Loading…" onClose={onClose}><Loading /></Sheet>;
  const t = data.task;
  const after = () => { reload(); emitChange(); };
  const who = t.assignee === 'both' ? 'BOTH' : t.assignee === 'user' ? (t.assigned_user_id === me.user.id ? `ME (${me.user.display_name})` : `YOU (${t.assigned_user_name})`) : 'Nobody';
  return (
    <Sheet wide onClose={onClose} title={<span className="row gap-s"><SpaceTag space={t.space} /> {t.title}</span>}>
      <Provenance e={t} />
      <Tabs tab={tab} setTab={setTab} unread={t.thread.unread} total={t.thread.total} />
      {tab === 'details' && (editing ? <TaskForm task={t} space={t.space} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); after(); }} /> : (
        <div className="stack">
          <div className="detail-head">
            <span className={`status st-${t.status}`}>{TASK_STATUS.find(([v]) => v === t.status)?.[1]}</span>
            <span className="row gap-s"><PriorityDot p={t.priority} /> {t.priority}</span>
            {t.kind === 'maintenance' && <span className="pill">Maintenance</span>}
          </div>
          <div className="segmented-wrap">
            <Segmented label="Status" value={t.status} onChange={(s) => run(async () => { await api.patch(`/tasks/${t.id}`, { status: s }); after(); })}
              options={TASK_STATUS.filter(([v]) => v !== 'archived').map(([v, l]) => ({ value: v, label: l }))} />
          </div>
          <div className="kvs">
            <Row label="Assigned to">{who}</Row>
            <Row label="Due">{t.due_date ? `${day(t.due_date)}${t.due_time ? ` at ${t.due_time}` : ''}` : 'No date'}</Row>
            <Row label="Reminder">{t.reminder_at && new Date(t.reminder_at).toLocaleString()}</Row>
            <Row label="Repeats">{t.recurrence_unit && `Every ${t.recurrence_interval} ${t.recurrence_unit}${t.recurrence_interval > 1 ? 's' : ''}`}</Row>
            <Row label="Completed">{t.completed_at && `${t.completed_by_name} · ${relative(t.completed_at)}`}</Row>
            <Row label="Calendar event">{t.related_event && <Link to={`?open=event:${t.related_event.id}`}>{t.related_event.title} · {day(t.related_event.start_date)}</Link>}</Row>
            <Row label="Related item">{t.related_item && <Link to={`?open=item:${t.related_item.id}`}>{t.related_item.title}</Link>}</Row>
          </div>
          {t.description && <p className="prose pre">{t.description}</p>}
          {t.completions.length > 0 && (
            <div><h3>Completion history</h3><ul className="history">{t.completions.map((c: any) => <li key={c.id}>{c.completed_by_name} · {new Date(c.completed_at).toLocaleDateString()}{c.due_date ? ` (due ${day(c.due_date)})` : ''}</li>)}</ul></div>
          )}
          <div className="row gap-s wrap">
            <button className="btn small" onClick={() => setEditing(true)}><Pencil size={14} /> Edit</button>
            {!t.related_event_id && (
              <button className="btn small" disabled={!t.due_date} title={!t.due_date ? 'Set a due date first' : undefined}
                onClick={() => run(async () => { const r = await api.post(`/tasks/${t.id}/to-event`, {}); after(); toast('Added to the calendar'); return r; })}>
                <CalendarPlus size={14} /> Add to calendar
              </button>
            )}
          </div>
          <CommonActions type="task" entity={t} onDone={onClose} reload={reload} />
        </div>
      ))}
      {tab === 'discussion' && <><Linked type="task" id={t.id} compact /><Thread type="task" id={t.id} space={t.space} /></>}
      {tab === 'history' && <History type="task" id={t.id} />}
    </Sheet>
  );
}

// ------------------------------------------------------------------ event

// -------------------------------------------------------------- inventory
function InventoryDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const { data, error, reload } = useApi<{ item: any }>(`/inventory/${id}`);
  const [tab, setTab] = useState<'details' | 'discussion' | 'history'>('details');
  const [editing, setEditing] = useState(false);
  if (error) return <Sheet title="Not available" onClose={onClose}><ErrorNote error={error} /></Sheet>;
  if (!data) return <Sheet title="Loading…" onClose={onClose}><Loading /></Sheet>;
  const it = data.item;
  return (
    <Sheet wide onClose={onClose} title={<span className="row gap-s"><SpaceTag space={it.space} /> {it.name}</span>}>
      <Tabs tab={tab} setTab={setTab} unread={it.thread.unread} total={it.thread.total} />
      {tab === 'details' && (editing ? <InventoryForm item={it} space={it.space} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); emitChange(); }} /> : (
        <div className="stack">
          <Images entityType="inventory" entity={it} reload={reload} />
          <div className="kvs">
            <Row label="Room">{it.room}</Row>
            <Row label="Type">{it.category}</Row>
            <Row label="Brand / model">{[it.brand, it.model].filter(Boolean).join(' · ')}</Row>
            <Row label="Dimensions">{it.dimensions}</Row>
            <Row label="Purchased">{it.purchase_date && day(it.purchase_date)}</Row>
            <Row label="Price">{money(it.price_cents, it.currency ?? me.household.currency)}</Row>
            <Row label="Warranty">{it.warranty_until && `until ${day(it.warranty_until)}`}{it.warranty_notes ? ` · ${it.warranty_notes}` : ''}</Row>
            <Row label="Manual">{it.manual_url && <a href={it.manual_url} target="_blank" rel="noreferrer noopener">Open <ExternalLink size={12} /></a>}</Row>
          </div>
          {it.notes && <p className="prose pre">{it.notes}</p>}
          <div className="row gap-s"><button className="btn small" onClick={() => setEditing(true)}><Pencil size={14} /> Edit</button></div>
          <CommonActions type="inventory" entity={it} onDone={onClose} reload={reload} />
        </div>
      ))}
      {tab === 'discussion' && <Thread type="inventory" id={it.id} space={it.space} />}
      {tab === 'history' && <History type="inventory" id={it.id} />}
    </Sheet>
  );
}

export function EntitySheet({ type, id, onClose, chat }: { type: OpenType; id: string; onClose: () => void; chat?: boolean }) {
  if (type === 'item') return <ItemSheet id={id} onClose={onClose} startInChat={chat} />;
  if (type === 'task') return <TaskDetail id={id} onClose={onClose} />;
  if (type === 'event') return <EventSheet id={id} onClose={onClose} startInChat={chat} />;
  if (type === 'inventory') return <InventoryDetail id={id} onClose={onClose} />;
  return <Sheet title="Expense" onClose={onClose}><p className="muted">Open expenses from the Expenses tab.</p></Sheet>;
}
