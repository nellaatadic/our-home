import { useApi } from '../lib/api';
import { relative } from '../lib/format';
import { useOpen } from '../components/Layout';
import { Empty, Loading, SpaceTag } from '../components/ui';

export function ArchivePage() {
  const { data } = useApi<{ archived: any[] }>('/archive');
  const open = useOpen();
  if (!data) return <div className="page"><Loading /></div>;
  return (
    <div className="page narrow">
      <h1>Archive</h1>
      <p className="muted">Archived things are kept here and can be restored. Open one to restore it or delete it permanently.</p>
      {data.archived.length ? (
        <ul className="rows">{data.archived.map((a) => (
          <li key={`${a.type}-${a.id}`}><button className="row-btn" onClick={() => a.type !== 'expense' && open(a.type, a.id)}>
            <span className="pill tiny">{a.type}</span><span className="grow">{a.title}</span><span className="muted small">{relative(a.archived_at)}</span><SpaceTag space={a.space} />
          </button></li>
        ))}</ul>
      ) : <Empty title="The archive is empty" />}
    </div>
  );
}
