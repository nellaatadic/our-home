import { useState } from 'react';
import { Lock, LockOpen } from 'lucide-react';
import { api, emitChange } from '../lib/api';
import { useMe } from '../lib/session';
import { LIST_COLORS, LIST_EMOJI } from '../lib/lists';
import { Field, Sheet, useAction } from './ui';

/** Make a new list (shared unless locked). With `eventId` the list belongs to a plan. */
export function NewListSheet({ onClose, onCreated, eventId, initial }: {
  onClose: () => void; onCreated: (list: any) => void; eventId?: string; initial?: { name?: string };
}) {
  const me = useMe();
  const [name, setName] = useState(initial?.name ?? '');
  const [emoji, setEmoji] = useState(LIST_EMOJI[0]);
  const [color, setColor] = useState(LIST_COLORS[3]);
  const [sections, setSections] = useState('');
  const [priv, setPriv] = useState(false);
  const { run, busy } = useAction();
  const create = () => name.trim() && run(async () => {
    const r = await api.post('/lists', {
      name: name.trim(), emoji, color, private: eventId ? undefined : priv, event_id: eventId,
      sections: sections.split(',').map((s) => s.trim()).filter(Boolean),
    });
    emitChange();
    onCreated(r.list);
  }, `Made “${name.trim()}”`);
  return (
    <Sheet title={eventId ? 'New list for this plan' : 'New list'} onClose={onClose} compact
      footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!name.trim() || busy} onClick={create}>Make list</button></>}>
      <div className="new-list-preview" style={{ ['--list' as any]: color }}>
        <span className="list-icon big" style={{ background: color }} aria-hidden>{emoji}</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={eventId ? 'Party shopping, Bring along…' : 'Books to read, Travel packing…'}
          aria-label="List name" maxLength={80} onKeyDown={(e) => e.key === 'Enter' && create()} />
      </div>
      <Field label="Icon">
        <div className="emoji-grid" role="radiogroup" aria-label="Icon">
          {LIST_EMOJI.map((e) => <button key={e} type="button" role="radio" aria-checked={emoji === e} className={emoji === e ? 'on' : ''} onClick={() => setEmoji(e)}>{e}</button>)}
        </div>
      </Field>
      <Field label="Colour">
        <div className="swatch-row" role="radiogroup" aria-label="Colour">
          {LIST_COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} className={color === c ? 'on' : ''} style={{ background: c }} onClick={() => setColor(c)} />)}
        </div>
      </Field>
      <Field label="Sections (optional)" hint="Separate with commas, like “Fiction, Non-fiction”. You can add more later.">
        <input value={sections} onChange={(e) => setSections(e.target.value)} placeholder="Before, On the day, After" />
      </Field>
      {!eventId && (
        <button type="button" className={`privacy-row ${priv ? 'on' : ''}`} onClick={() => setPriv((x) => !x)} aria-pressed={priv}>
          {priv ? <Lock size={16} /> : <LockOpen size={16} />}
          <span className="grow">{priv ? 'Private: only you can see this list and what is in it' : `Shared with ${me.partner?.display_name ?? 'your partner'}`}</span>
          <span className="muted small">{priv ? 'Tap to share' : 'Tap to lock'}</span>
        </button>
      )}
    </Sheet>
  );
}
