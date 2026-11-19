import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Archive, ArchiveRestore, CalendarPlus, ExternalLink, ImagePlus, Pencil, Share2, Star, Trash2, Undo2 } from 'lucide-react';
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

function CommonActions({ type, entity, onDone, reload, extra }: { type: OpenType; entity: any; onDone: () => void; reload: () => void; extra?: ReactNode }) {
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

function History({ type, id }: { type: string; id: string }) {
  const { data } = useApi<{ activity: any[] }>(`/entities/${type}/${id}/activity`);
  if (!data) return <Loading />;
  if (!data.activity.length) return <p className="muted">No history yet.</p>;
  return (
    <ul className="history">
      {data.activity.map((a, i) => <li key={i}><b>{a.actor_name ?? 'System'}</b> {a.summary || a.action} <span className="muted">· {relative(a.created_at)}</span></li>)}
    </ul>
  );
}

function Images({ entityType, entity, reload }: { entityType: string; entity: any; reload: () => void }) {
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

// ------------------------------------------------------------------- item
function ItemDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const { data, error, reload } = useApi<{ item: any; alternatives: any[] }>(`/items/${id}`);
  const [tab, setTab] = useState<'details' | 'discussion' | 'history'>('details');
  const [editing, setEditing] = useState(false);
  const [buying, setBuying] = useState<number | null>(null);
  const [compare, setCompare] = useState(false);
  const { run } = useAction();
  if (error) return <Sheet title="Not available" onClose={onClose}><ErrorNote error={error} /></Sheet>;
  if (!data) return <Sheet title="Loading…" onClose={onClose}><Loading /></Sheet>;
  const it = data.item;
  const label = it.module === 'grocery' ? (it.grocery_state === 'need' ? 'NEED' : 'STOCK') : it.module === 'home' ? 'Home improvement' : it.idea_type || null;
  const after = () => { reload(); emitChange(); };
  return (
    <Sheet wide onClose={onClose} title={<span className="row gap-s"><SpaceTag space={it.space} /> {it.title}</span>}>
      <Provenance e={it} />
      <Tabs tab={tab} setTab={setTab} unread={it.thread.unread} total={it.thread.total} />
      {tab === 'details' && (editing ? (
        <ItemForm item={it} module={it.module} space={it.space} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); after(); }} />
      ) : (
        <div className="stack">
          <div className="detail-head">
            {label && <span className="pill">{label}</span>}
            <span className="row gap-s"><PriorityDot p={it.priority} /> {it.priority}</span>
            {it.category && <span className="cat" style={{ ['--c' as any]: it.category.color }}>{it.category.name}</span>}
            {it.decision_status && <span className={`status st-${it.decision_status}`}>{DECISIONS.find(([v]) => v === it.decision_status)?.[1]}</span>}
            {it.purchase_stage && <span className="pill">{STAGES.find(([v]) => v === it.purchase_stage)?.[1]}</span>}
          </div>
          {it.module !== 'grocery' && it.space === 'us' && <Reactions type="item" entity={it} onChange={reload} />}
          <Images entityType="item" entity={{ ...it, attachments: it.attachments }} reload={reload} />
          {it.link_image_url && !it.images.length && <img className="link-thumb" src={it.link_image_url} alt="" referrerPolicy="no-referrer" />}
          <div className="kvs">
            <Row label="Quantity">{qty(it.quantity, it.unit)}</Row>
            <Row label="Price">{money(it.price_cents, it.currency ?? me.household.currency)}</Row>
            <Row label="Link">{it.link_url && <a href={it.link_url} target="_blank" rel="noreferrer noopener">{it.link_title || new URL(it.link_url).hostname} <ExternalLink size={12} /></a>}</Row>
            <Row label="Room">{it.room}</Row>
            <Row label="Dimensions">{it.dimensions}</Row>
            <Row label="Colour / material">{it.color_material}</Row>
            <Row label="Store">{it.store}</Row>
            <Row label="For">{it.intended_for_user_id ? me.members.find((m) => m.id === it.intended_for_user_id)?.display_name : it.intended_for_name}</Row>
            <Row label="Assigned to">{it.assigned_to && me.members.find((m) => m.id === it.assigned_to)?.display_name}</Row>
            <Row label="Target date">{it.target_date && day(it.target_date)}</Row>
            <Row label="Purchased">{it.purchased_on && day(it.purchased_on)}</Row>
            <Row label="Expires">{it.expires_on && day(it.expires_on)}</Row>
            <Row label="Stored in">{it.storage_location}</Row>
            <Row label="Tags">{it.tags.length > 0 && it.tags.map((t: string) => <span key={t} className="chip">{t}</span>)}</Row>
            <Row label="List">{it.list?.name}</Row>
            <Row label="Added">{`${it.created_by_name ?? ''} · ${relative(it.created_at)}`}</Row>
          </div>
          {it.notes && <p className="prose pre">{it.notes}</p>}

          {it.module === 'grocery' && it.grocery_state === 'need' && (
            buying === null ? <button className="btn primary" onClick={() => setBuying(it.quantity ?? 1)}>Mark purchased → STOCK</button> : (
              <div className="row gap-s inline-form">
                <label>Quantity bought <input type="number" min={0} step="any" className="qty-input" value={buying} onChange={(e) => setBuying(Number(e.target.value))} /></label>
                <button className="btn primary" onClick={() => run(async () => { await api.post(`/items/${it.id}/purchase`, { quantity: buying }); after(); setBuying(null); }, 'Moved to STOCK')}>Move to STOCK</button>
                <button className="btn ghost" onClick={() => setBuying(null)}>Cancel</button>
              </div>
            )
          )}
          {it.module === 'grocery' && it.grocery_state === 'stock' && (
            <button className="btn" onClick={() => run(async () => { await api.post(`/items/${it.id}/need`, {}); after(); }, 'Back on the NEED list')}><Undo2 size={14} /> We ran out → NEED</button>
          )}

          {it.module !== 'grocery' && (
            <div className="compare">
              <div className="row between"><h3>Alternatives</h3><button className="btn small ghost" onClick={() => setCompare(true)}>Compare with…</button></div>
              {data.alternatives.length > 0 ? (
                <div className="compare-grid">
                  {[it, ...data.alternatives].map((x: any) => (
                    <div key={x.id} className={`compare-card ${x.purchase_stage === 'preferred' ? 'preferred' : ''}`}>
                      {x.images?.[0] ? <img src={x.images[0].url} alt="" /> : x.link_image_url ? <img src={x.link_image_url} alt="" referrerPolicy="no-referrer" /> : <div className="img-ph" />}
                      <b>{x.title}</b>
                      <span>{money(x.price_cents, x.currency ?? me.household.currency)}</span>
                      {x.dimensions && <span className="muted small">{x.dimensions}</span>}
                      {x.link_url && <a href={x.link_url} target="_blank" rel="noreferrer noopener" className="small">Link</a>}
                      {x.notes && <span className="small muted clamp">{x.notes}</span>}
                      <span className="small muted">{x.thread?.total ?? 0} comments · {x.reactions?.map((r: any) => REACTIONS.find(([k]) => k === r.reaction)?.[1]).join(' ')}</span>
                      {x.purchase_stage === 'preferred' ? <span className="pill">Preferred</span> : <button className="btn small ghost" onClick={() => run(async () => { await api.post(`/items/${x.id}/prefer`); after(); })}>Prefer this</button>}
                    </div>
                  ))}
                </div>
              ) : <p className="muted small">Add other options to compare them side by side.</p>}
            </div>
          )}
          <div className="row gap-s"><button className="btn small" onClick={() => setEditing(true)}><Pencil size={14} /> Edit</button></div>
          <CommonActions type="item" entity={it} onDone={onClose} reload={reload} />
          {compare && <CompareChooser item={it} onClose={() => setCompare(false)} onChosen={after} />}
        </div>
      ))}
      {tab === 'discussion' && <Thread type="item" id={it.id} space={it.space} />}
      {tab === 'history' && <History type="item" id={it.id} />}
    </Sheet>
  );
}

function CompareChooser({ item, onClose, onChosen }: { item: any; onClose: () => void; onChosen: () => void }) {
  const { data } = useApi<{ items: any[] }>(`/spaces/${item.space}/items?module=${item.module}`);
  const { run } = useAction();
  const options = (data?.items ?? []).filter((x) => x.id !== item.id && (!item.comparison_group_id || x.comparison_group_id !== item.comparison_group_id));
  return (
    <Sheet title={`Compare “${item.title}” with…`} onClose={onClose}>
      {!data ? <Loading /> : options.length ? (
        <ul className="pick-list">{options.map((o) => <li key={o.id}><button className="link-btn" onClick={() => run(async () => { await api.post(`/items/${item.id}/compare`, { other_id: o.id }); onChosen(); onClose(); })}>{o.title} <span className="muted">{o.room ?? ''}</span></button></li>)}</ul>
      ) : <p className="muted">Add another item in this list first.</p>}
    </Sheet>
  );
}

// ------------------------------------------------------------------- task
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
      {tab === 'discussion' && <Thread type="task" id={t.id} space={t.space} />}
      {tab === 'history' && <History type="task" id={t.id} />}
    </Sheet>
  );
}

// ------------------------------------------------------------------ event
function EventDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const me = useMe();
  const { data, error, reload } = useApi<{ event: any }>(`/events/${id}`);
  const [tab, setTab] = useState<'details' | 'discussion' | 'history'>('details');
  const [editing, setEditing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [followUp, setFollowUp] = useState('');
  const { run } = useAction();
  if (error) return <Sheet title="Not available" onClose={onClose}><ErrorNote error={error} /></Sheet>;
  if (!data) return <Sheet title="Loading…" onClose={onClose}><Loading /></Sheet>;
  const e = data.event;
  const after = () => { reload(); emitChange(); };
  return (
    <Sheet wide onClose={onClose} title={<span className="row gap-s"><SpaceTag space={e.space} /> {e.title}</span>}>
      <Provenance e={e} />
      <Tabs tab={tab} setTab={setTab} unread={e.thread.unread} total={e.thread.total} />
      {tab === 'details' && (editing ? <EventForm event={e} space={e.space} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); after(); }} /> : (
        <div className="stack">
          <div className="kvs">
            <Row label="When">{`${day(e.start_date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${e.end_date && e.end_date !== e.start_date ? ` → ${day(e.end_date)}` : ''} · ${eventTime(e)}`}</Row>
            <Row label="Where">{e.location}</Row>
            <Row label="With">{e.participants?.length ? e.participants.join(', ') : ''}</Row>
            <Row label="About">{e.for_user_name}</Row>
            <Row label="Category">{e.category}</Row>
            <Row label="Source">{e.source_type === 'google'
              ? `${e.imported_by_name}’s Google Calendar “${e.google_calendar_name}” · imported ${relative(e.imported_at)}${e.locally_modified ? ' · edited in OUR HOME' : ''}`
              : e.source_type === 'text' ? 'Created from text' : e.source_type === 'task' ? 'Created from a task' : `Added by ${e.created_by_name ?? ''}`}</Row>
            <Row label="In my Google">{e.my_exports?.length > 0 && e.my_exports.map((x: any, i: number) => <div key={i}>{x.calendar_name ?? x.google_calendar_id} · {relative(x.exported_at)} {x.html_link && <a href={x.html_link} target="_blank" rel="noreferrer">open</a>}</div>)}</Row>
          </div>
          {e.availability_only && <p className="note subtle">Availability only — the details of this private event were not shared.</p>}
          {e.description && <p className="prose pre">{e.description}</p>}
          {e.space === 'us' && <Reactions type="event" entity={e} onChange={reload} />}
          {e.follow_up_tasks?.length > 0 && (
            <div><h3>Follow-up tasks</h3><ul className="history">{e.follow_up_tasks.map((t: any) => <li key={t.id}><Link to={`?open=task:${t.id}`}>{t.title}</Link> <span className="muted">· {t.status}</span></li>)}</ul></div>
          )}
          <form className="row gap-s" onSubmit={(ev) => { ev.preventDefault(); run(async () => { await api.post(`/events/${e.id}/follow-up`, { title: followUp }); setFollowUp(''); after(); }, 'Follow-up task created'); }}>
            <input className="grow" value={followUp} onChange={(ev) => setFollowUp(ev.target.value)} placeholder="Add a follow-up task…" aria-label="Follow-up task" maxLength={200} />
            <button className="btn small" disabled={!followUp.trim()}>Add</button>
          </form>
          <div className="row gap-s wrap">
            <button className="btn small" onClick={() => setEditing(true)}><Pencil size={14} /> Edit</button>
            <button className="btn small" onClick={() => setExporting(true)}><CalendarPlus size={14} /> Add to my Google Calendar</button>
          </div>
          <CommonActions type="event" entity={e} onDone={onClose} reload={reload} />
          {exporting && <ExportDialog eventId={e.id} onClose={() => { setExporting(false); reload(); }} />}
          {e.source_type === 'google' && <p className="muted small">Deleting or editing this copy never changes the original Google Calendar event.</p>}
        </div>
      ))}
      {tab === 'discussion' && <Thread type="event" id={e.id} space={e.space} />}
      {tab === 'history' && <History type="event" id={e.id} />}
    </Sheet>
  );
}

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

export function EntitySheet({ type, id, onClose }: { type: OpenType; id: string; onClose: () => void }) {
  if (type === 'item') return <ItemDetail id={id} onClose={onClose} />;
  if (type === 'task') return <TaskDetail id={id} onClose={onClose} />;
  if (type === 'event') return <EventDetail id={id} onClose={onClose} />;
  if (type === 'inventory') return <InventoryDetail id={id} onClose={onClose} />;
  return <Sheet title="Expense" onClose={onClose}><p className="muted">Open expenses from the Expenses tab.</p></Sheet>;
}
