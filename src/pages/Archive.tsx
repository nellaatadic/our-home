import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RotateCcw, Trash2 } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { relative } from '../lib/format';
import { useOpen } from '../components/Layout';
import { useLists } from '../lib/useLists';
import { Confirm, Empty, Loading, SpaceTag, useAction } from '../components/ui';

const LABEL: Record<string, string> = { item: 'item', task: 'to-do', event: 'event', plan: 'plan', list: 'list', pin: 'pin', topic: 'topic', inventory: 'inventory', expense: 'expense' };

export function ArchivePage() {
  const { data } = useApi<{ archived: any[] }>('/archive');
  const open = useOpen();
  const nav = useNavigate();
  const { reload: reloadLists } = useLists();
  const { run } = useAction();
  const [deleting, setDeleting] = useState<any>(null);
  if (!data) return <div className="page"><Loading /></div>;

  const restore = (a: any) => run(async () => {
    if (a.type === 'list') { await api.patch(`/lists/${a.id}`, { archived: false }); reloadLists(); }
    else if (a.type === 'topic') await api.patch(`/topics/${a.id}`, { archived: false });
    else await api.post(`/entities/${a.type === 'plan' ? 'event' : a.type}/${a.id}/unarchive`);
    emitChange();
  }, `Restored “${a.title}”`);
  const view = (a: any) => {
    if (a.type === 'plan') return nav(`/plan/${a.id}`);
    if (['item', 'task', 'event', 'inventory'].includes(a.type)) open(a.type, a.id);
  };

  return (
    <div className="page narrow">
      <h1>Archive</h1>
      <p className="muted">Archived things are kept here and can be restored. Plans and lists come back together with everything that was in them.</p>
      {data.archived.length ? (
        <ul className="rows">{data.archived.map((a) => (
          <li key={`${a.type}-${a.id}`} className="row gap-s">
            <button className="row-btn grow" onClick={() => view(a)}>
              <span className="pill tiny">{LABEL[a.type] ?? a.type}</span><span className="grow clamp1">{a.title}</span><span className="muted small">{relative(a.archived_at)}</span><SpaceTag space={a.space} />
            </button>
            {a.type !== 'expense' && <button className="icon-btn small" onClick={() => restore(a)} aria-label={`Restore ${a.title}`} title="Restore"><RotateCcw size={15} /></button>}
            {a.type === 'list' && <button className="icon-btn small" onClick={() => setDeleting(a)} aria-label={`Delete ${a.title} for good`} title="Delete for good"><Trash2 size={15} /></button>}
          </li>
        ))}</ul>
      ) : <Empty title="The archive is empty" />}
      {deleting && (
        <Confirm title={`Delete “${deleting.title}” for good?`} danger confirmLabel="Delete for good" onClose={() => setDeleting(null)}
          body={<>The list and everything in it (items, their chats and photos) are deleted{deleting.space === 'us' ? ' for both of you' : ''}. This can’t be undone.</>}
          onConfirm={() => run(async () => { await api.del(`/lists/${deleting.id}?confirm=permanent`); setDeleting(null); emitChange(); }, 'Deleted')} />
      )}
    </div>
  );
}
