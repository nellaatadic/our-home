import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarDays, ChevronDown, ChevronRight, CheckSquare, Hash, Lock, MessagesSquare, Plus, Search } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { relative } from '../lib/format';
import { listByModule } from '../lib/lists';
import { previewText, Thread } from '../components/Thread';
import { useOpen } from '../components/Layout';
import { Empty, Field, Loading, Sheet, useAction } from '../components/ui';

interface Card { entity_type: string; entity_id: string; title: string; module: string | null; space: 'me' | 'us'; total: number; unread: number; last_at: string; last_body: string; last_author: string | null }

function CardIcon({ c }: { c: Card }) {
  if (c.entity_type === 'item' && c.module) {
    const l = listByModule(c.module);
    return <span className="list-icon tiny" style={{ background: l.color }} aria-hidden>{l.emoji}</span>;
  }
  if (c.entity_type === 'event') return <CalendarDays size={15} className="muted" aria-hidden />;
  if (c.entity_type === 'task') return <CheckSquare size={15} className="muted" aria-hidden />;
  return <Hash size={15} className="muted" aria-hidden />;
}

/**
 * All conversations in one place: every item / event / to-do / topic that has
 * a chat is a small card (title only, expandable), and the big box on the
 * right is the ongoing chat between the two of you.
 */
export function ChatPage() {
  const me = useMe();
  const open = useOpen();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const { data, loading } = useApi<{ cards: Card[] }>(`/chat/cards${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
  const { data: general } = useApi<{ topic: any }>('/chat/general');
  const [expanded, setExpanded] = useState<string | null>(params.get('topic') ? `topic:${params.get('topic')}` : null);
  const [newTopic, setNewTopic] = useState(false);
  const [mobileTab, setMobileTab] = useState<'chat' | 'cards'>(params.get('topic') ? 'cards' : 'chat');

  useEffect(() => {
    const t = params.get('topic');
    if (t) { setExpanded(`topic:${t}`); setMobileTab('cards'); }
  }, [params]);

  const cards = data?.cards ?? [];
  const toggle = (key: string) => {
    setExpanded((x) => (x === key ? null : key));
    if (params.get('topic')) { const n = new URLSearchParams(params); n.delete('topic'); setParams(n, { replace: true }); }
  };

  return (
    <div className="page chat-page">
      <header className="page-head compact">
        <h1><MessagesSquare size={22} /> Chat</h1>
        <div className="seg-tabs mobile-only" role="tablist">
          <button role="tab" aria-selected={mobileTab === 'chat'} className={mobileTab === 'chat' ? 'on' : ''} onClick={() => setMobileTab('chat')}>Our chat</button>
          <button role="tab" aria-selected={mobileTab === 'cards'} className={mobileTab === 'cards' ? 'on' : ''} onClick={() => setMobileTab('cards')}>Topics {cards.reduce((s, c) => s + c.unread, 0) ? <b className="badge inline">{cards.reduce((s, c) => s + c.unread, 0)}</b> : null}</button>
        </div>
      </header>
      <div className={`chat-layout show-${mobileTab}`}>
        <aside className="chat-cards">
          <div className="row gap-s">
            <div className="search-field grow">
              <Search size={14} aria-hidden />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a conversation" aria-label="Find a conversation" />
            </div>
            <button className="btn small" onClick={() => setNewTopic(true)}><Plus size={14} /> Topic</button>
          </div>
          {loading && !data ? <Loading /> : !cards.length ? (
            <Empty title={q ? 'No conversation matches' : 'No conversations yet'}>Tap the comment icon next to any item, or start a topic.</Empty>
          ) : (
            <ul className="chat-card-list">
              {cards.map((c) => {
                const key = `${c.entity_type}:${c.entity_id}`;
                const isOpen = expanded === key;
                return (
                  <li key={key} className={`chat-card ${isOpen ? 'open' : ''} ${c.unread ? 'unread' : ''}`}>
                    <button className="chat-card-head" onClick={() => toggle(key)} aria-expanded={isOpen}>
                      <CardIcon c={c} />
                      <span className="grow clamp1 chat-card-title">{c.title}</span>
                      {c.space === 'me' && <Lock size={12} className="muted" aria-label="Private" />}
                      {c.unread > 0 && <b className="badge">{c.unread}</b>}
                      {isOpen ? <ChevronDown size={15} className="muted" /> : <ChevronRight size={15} className="muted" />}
                    </button>
                    {!isOpen && c.last_body && <p className="chat-card-last clamp1">{c.last_author ? `${c.last_author === me.user.display_name ? 'You' : c.last_author}: ` : ''}{previewText(c.last_body)} <span className="muted">· {relative(c.last_at)}</span></p>}
                    {isOpen && (
                      <div className="chat-card-body">
                        <Thread type={c.entity_type} id={c.entity_id} space={c.space} compact placeholder="Reply… (@ to link a card)" />
                        {c.entity_type !== 'topic' && <button className="link-btn" onClick={() => open(c.entity_type as any, c.entity_id)}>Open {c.entity_type === 'item' ? 'item' : c.entity_type === 'event' ? 'event' : 'to-do'}</button>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
        <section className="chat-main" aria-label="Our chat">
          <header className="chat-main-head">
            <b>{me.members.map((m) => m.display_name).join(' & ')}</b>
            <span className="muted small">Type @ to mention or link any card</span>
          </header>
          {general ? <Thread type="topic" id={general.topic.id} space="us" placeholder={`Message ${me.partner?.display_name ?? ''}… type @ to link a card`} /> : <Loading />}
        </section>
      </div>
      {newTopic && <NewTopicSheet onClose={() => setNewTopic(false)} onCreated={(id) => { setNewTopic(false); setExpanded(`topic:${id}`); setMobileTab('cards'); }} />}
    </div>
  );
}

function NewTopicSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const [priv, setPriv] = useState(false);
  const { run, busy } = useAction();
  const create = () => run(async () => {
    const r = await api.post('/chat/topics', { title: title.trim(), private: priv });
    emitChange();
    onCreated(r.topic.id);
  });
  return (
    <Sheet title="New topic" onClose={onClose} compact footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!title.trim() || busy} onClick={create}>Start</button></>}>
      <Field label="What is it about?"><input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Holiday plans, new car, wedding gift…" maxLength={120} onKeyDown={(e) => e.key === 'Enter' && title.trim() && create()} /></Field>
      <label className="check"><input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> Private: notes only you can see</label>
    </Sheet>
  );
}
