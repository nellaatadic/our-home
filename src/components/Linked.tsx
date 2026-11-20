import { useNavigate } from 'react-router-dom';
import { CalendarDays, CheckSquare, ClipboardList, Hash, ListChecks, MessagesSquare, ShoppingBasket, StickyNote, Tag } from 'lucide-react';
import { useApi } from '../lib/api';
import { cardPath, useOpen } from './Layout';

export interface LinkedCard {
  type: 'item' | 'task' | 'event' | 'topic' | 'pin' | 'list'; id: string; title: string; sub: string | null; space: 'me' | 'us';
  archived: boolean; done?: boolean; is_plan?: boolean;
}
interface Links { mentions: LinkedCard[]; mentioned_in: LinkedCard[]; tagged: LinkedCard[]; tags: string[]; in_main_chat: number }

const ICON: Record<string, typeof Hash> = { item: ShoppingBasket, task: CheckSquare, event: CalendarDays, topic: Hash, pin: StickyNote, list: ListChecks };

export function CardChip({ c }: { c: LinkedCard }) {
  const open = useOpen();
  const nav = useNavigate();
  const Icon = c.type === 'event' && c.is_plan ? ClipboardList : ICON[c.type] ?? Hash;
  return (
    <button type="button" className={`card-chip ${c.done ? 'done' : ''} ${c.archived ? 'archived' : ''}`}
      onClick={() => { const p = cardPath(c.type, c.id, { is_plan: c.is_plan }); if (p) nav(p); else open(c.type as any, c.id); }}
      title={`${c.sub ?? c.type}${c.archived ? ' · archived' : ''}`}>
      <Icon size={13} aria-hidden /><span className="clamp1">{c.title}</span>{c.sub && <small>{c.sub}</small>}
    </button>
  );
}

/**
 * Everything connected to a card, collected above its conversation: what was
 * @-linked in it, where else it was mentioned, and what shares its tags.
 */
export function Linked({ type, id, compact }: { type: string; id: string; compact?: boolean }) {
  const nav = useNavigate();
  const { data } = useApi<Links>(`/links/${type}/${id}`);
  if (!data) return null;
  const uniq = (xs: LinkedCard[]) => { const seen = new Set<string>(); return xs.filter((x) => { const k = `${x.type}:${x.id}`; if (seen.has(k)) return false; seen.add(k); return true; }); };
  const mentions = uniq(data.mentions);
  const mentionedIn = uniq(data.mentioned_in);
  const tagged = uniq(data.tagged);
  if (!mentions.length && !mentionedIn.length && !tagged.length && !data.in_main_chat && !data.tags.length) return null;
  return (
    <section className={`linked ${compact ? 'compact' : ''}`} aria-label="Linked">
      {mentions.length > 0 && <div className="linked-row"><span className="linked-label">Linked here</span><div className="chips">{mentions.map((c) => <CardChip key={c.type + c.id} c={c} />)}</div></div>}
      {(mentionedIn.length > 0 || data.in_main_chat > 0) && (
        <div className="linked-row"><span className="linked-label">Mentioned in</span>
          <div className="chips">
            {data.in_main_chat > 0 && <button type="button" className="card-chip" onClick={() => nav('/chat')}><MessagesSquare size={13} aria-hidden /><span>Our chat</span><small>{data.in_main_chat}×</small></button>}
            {mentionedIn.map((c) => <CardChip key={c.type + c.id} c={c} />)}
          </div>
        </div>
      )}
      {(tagged.length > 0 || data.tags.length > 0) && (
        <div className="linked-row"><span className="linked-label"><Tag size={11} aria-hidden /> {data.tags.map((t) => `#${t}`).join(' ')}</span>
          <div className="chips">{tagged.length ? tagged.map((c) => <CardChip key={c.type + c.id} c={c} />) : <span className="muted tiny">Nothing else has this tag yet.</span>}</div>
        </div>
      )}
    </section>
  );
}
