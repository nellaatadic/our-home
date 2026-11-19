import { useEffect, useState } from 'react';
import { api, emitChange } from '../lib/api';
import { Field, Loading, Segmented, Sheet, useAction, useToast } from './ui';

interface Entry { id: string; title: string; quantity: number | null; notes: string; module: string | null; grocery_state: string | null; duplicate: { id: string; title: string; reason: 'already_shared' | 'similar_exists' } | null; selected: boolean }

/**
 * Share personal records with US. Shows a preview with per-item selection,
 * duplicate warnings and quick edits. Copy is the default; move is explicit.
 */
export function ShareDialog({ type, ids, listId, onClose }: { type: 'item' | 'task' | 'event'; ids?: string[]; listId?: string; onClose: () => void }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [lists, setLists] = useState<{ id: string; name: string; is_default: boolean }[]>([]);
  const [targetList, setTargetList] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, { title?: string; quantity?: number | null }>>({});
  const [mode, setMode] = useState<'copy' | 'move'>('copy');
  const [allowDup, setAllowDup] = useState(false);
  const { busy, run } = useAction();
  const toast = useToast();

  useEffect(() => {
    api.post('/share/preview', { type, ids, list_id: listId }).then((r) => {
      setEntries(r.entries);
      setLists(r.target_lists);
      setTargetList(r.target_lists.find((l: any) => l.is_default)?.id ?? r.target_lists[0]?.id ?? '');
      setSelected(new Set(r.entries.filter((e: Entry) => e.selected).map((e: Entry) => e.id)));
    }).catch((e) => { toast(e.message, 'error'); onClose(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const all = entries?.filter((e) => e.duplicate?.reason !== 'already_shared') ?? [];
  const submit = () => run(async () => {
    const r = await api.post('/share', { type, ids: [...selected], mode, target_list_id: targetList || undefined, edits, allow_duplicates: allowDup });
    emitChange();
    const skipped = r.skipped.length ? ` (${r.skipped.length} skipped as duplicates)` : '';
    toast(`${r.created.length} ${mode === 'move' ? 'moved' : 'shared'} with US${skipped}`);
    onClose();
  });
  const hasSimilar = entries?.some((e) => selected.has(e.id) && e.duplicate?.reason === 'similar_exists');

  return (
    <Sheet title="Share with US" onClose={onClose} wide footer={<>
      <span className="muted small grow">{selected.size} of {entries?.length ?? 0} selected</span>
      <button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy || !selected.size} onClick={submit}>{mode === 'move' ? `Move ${selected.size} to US` : `Share ${selected.size} with US`}</button>
    </>}>
      {!entries ? <Loading /> : (
        <div className="stack">
          <Segmented label="Copy or move" value={mode} onChange={setMode} options={[{ value: 'copy', label: 'Copy (keep mine private)' }, { value: 'move', label: 'Move to US' }]} />
          <p className="muted small">
            {mode === 'copy'
              ? 'A copy appears in US. Your private original stays in ME and later changes to it will not overwrite the shared copy.'
              : 'The item leaves your private space and becomes shared — including its notes, images and private discussion.'}
          </p>
          {lists.length > 1 && (
            <Field label="Add to list in US">
              <select value={targetList} onChange={(e) => setTargetList(e.target.value)}>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
            </Field>
          )}
          <div className="row gap-s">
            <button className="btn small ghost" onClick={() => setSelected(new Set(all.map((e) => e.id)))}>Select all</button>
            <button className="btn small ghost" onClick={() => setSelected(new Set())}>Select none</button>
          </div>
          <ul className="share-list">
            {entries.map((e) => {
              const already = e.duplicate?.reason === 'already_shared';
              return (
                <li key={e.id} className={already ? 'disabled' : ''}>
                  <input type="checkbox" checked={selected.has(e.id)} disabled={already} onChange={() => toggle(e.id)} aria-label={`Include ${e.title}`} />
                  <div className="grow">
                    {selected.has(e.id) ? (
                      <div className="row gap-s">
                        <input className="grow" value={edits[e.id]?.title ?? e.title} onChange={(ev) => setEdits((x) => ({ ...x, [e.id]: { ...x[e.id], title: ev.target.value } }))} aria-label="Title" />
                        {type === 'item' && (
                          <input type="number" min={0} step="any" className="qty-input" value={edits[e.id]?.quantity ?? e.quantity ?? ''} placeholder="Qty"
                            onChange={(ev) => setEdits((x) => ({ ...x, [e.id]: { ...x[e.id], quantity: ev.target.value === '' ? null : Number(ev.target.value) } }))} aria-label="Quantity" />
                        )}
                      </div>
                    ) : <span>{e.title}</span>}
                    {e.duplicate && <div className={`small ${already ? 'muted' : 'warn'}`}>{already ? 'Already shared with US' : `Similar item already in US: “${e.duplicate.title}”`}</div>}
                  </div>
                </li>
              );
            })}
          </ul>
          {hasSimilar && (
            <label className="check"><input type="checkbox" checked={allowDup} onChange={(e) => setAllowDup(e.target.checked)} /> Add items even when a similar one already exists in US</label>
          )}
        </div>
      )}
    </Sheet>
  );
}
