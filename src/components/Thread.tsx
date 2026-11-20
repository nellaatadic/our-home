import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { CornerUpLeft, Hash, MessagesSquare, Paperclip, Pencil, Send, Trash2, X } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { relative } from '../lib/format';
import { prepareUpload } from '../lib/image';
import { REF_RE } from '../lib/lists';
import { Loading, useAction } from './ui';
import { cardPath, useOpen } from './Layout';

interface Msg {
  id: string; author_id: string; author_name: string; body: string; reply_to_id: string | null; created_at: string;
  edited_at: string | null; deleted_at: string | null; mention_ids: string[]; mirrored_from_id?: string | null; attachments: { id: string; filename: string; content_type: string; url: string }[];
}
interface Suggestion { kind: 'person' | 'card'; label: string; sub?: string; insert: string }

const URL_RE = /(https?:\/\/[^\s<>()]+[^\s<>().,!?;:'"])/g;

/** A clickable card reference inside a message. */
export function RefChip({ type, id, title }: { type: string; id: string; title: string }) {
  const open = useOpen();
  const nav = useNavigate();
  return (
    <button type="button" className={`ref-chip ref-${type}`} onClick={() => { const p = cardPath(type, id); if (p) nav(p); else open(type as any, id); }} title={`Open “${title}”`}>
      <Hash size={11} aria-hidden />{title}
    </button>
  );
}

/** Message text → mentions, card references and links. */
export function MessageBody({ body, names }: { body: string; names: string[] }) {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  const pushText = (text: string) => {
    for (const piece of text.split(URL_RE)) {
      if (!piece) continue;
      if (/^https?:\/\//.test(piece)) {
        out.push(<a key={k++} href={piece} target="_blank" rel="noreferrer noopener">{piece.replace(/^https?:\/\/(www\.)?/, '').slice(0, 48)}</a>);
        continue;
      }
      for (const p of piece.split(/(@[\p{L}\p{N}_.-]+)/u)) {
        const isMention = p.startsWith('@') && (['@me', '@you'].includes(p.toLowerCase()) || names.some((n) => p.slice(1).toLowerCase() === n.split(' ')[0].toLowerCase()));
        out.push(isMention ? <span key={k++} className="mention">{p}</span> : <Fragment key={k++}>{p}</Fragment>);
      }
    }
  };
  for (const m of body.matchAll(REF_RE)) {
    pushText(body.slice(last, m.index));
    out.push(<RefChip key={k++} title={m[1]} type={m[2]} id={m[3]} />);
    last = (m.index ?? 0) + m[0].length;
  }
  pushText(body.slice(last));
  return <>{out}</>;
}

/** Plain-text preview of a message (card references shown as #Title). */
export function previewText(body: string) {
  return body.replace(REF_RE, (_, t) => `#${t}`);
}

/**
 * One conversation. Type @ to mention your partner or reference any shared
 * card (item, event, to-do, topic). Enter sends; Shift+Enter adds a line.
 */
export function Thread({ type, id, space, compact, autoFocus, placeholder }: {
  type: string; id: string; space: 'me' | 'us'; compact?: boolean; autoFocus?: boolean; placeholder?: string;
}) {
  const me = useMe();
  const { data, loading, reload } = useApi<{ messages: Msg[]; last_read_at: string | null }>(`/threads/${type}/${id}`);
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [pending, setPending] = useState<{ id: string; filename: string }[]>([]);
  const [showAll, setShowAll] = useState(!compact);
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [sugIndex, setSugIndex] = useState(0);
  const { busy, run } = useAction();
  const listRef = useRef<HTMLOListElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const names = useMemo(() => me.members.map((m) => m.display_name), [me]);
  const byId = useMemo(() => new Map((data?.messages ?? []).map((m) => [m.id, m])), [data]);

  useEffect(() => {
    if (data?.messages.length) {
      api.post(`/threads/${type}/${id}/read`).then(emitChange).catch(() => {});
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [data?.messages.length, type, id]);
  const ready = Boolean(data);
  useEffect(() => { if (autoFocus && ready) inputRef.current?.focus(); }, [autoFocus, ready]);

  // ---- @ autocomplete: people and cards
  const atQuery = (text: string, caret: number) => {
    const m = /(^|\s)@([^\s@\[\]]{0,30})$/.exec(text.slice(0, caret));
    return m ? m[2] : null;
  };
  const refreshSuggestions = async (text: string, caret: number) => {
    const term = atQuery(text, caret);
    if (term === null) { setSugs([]); return; }
    const people: Suggestion[] = (space === 'us' ? me.members.filter((m) => m.id !== me.user.id) : [])
      .filter((m) => m.display_name.toLowerCase().startsWith(term.toLowerCase()))
      .map((m) => ({ kind: 'person', label: m.display_name, sub: 'Mention', insert: `@${m.display_name.split(' ')[0]} ` }));
    let cards: Suggestion[] = [];
    try {
      const r = await api.get<{ references: any[] }>(`/chat/references?scope=${space === 'us' ? 'us' : 'all'}${term ? `&q=${encodeURIComponent(term)}` : ''}`);
      cards = r.references
        .filter((x) => !(x.type === type && x.id === id))
        .map((x) => ({ kind: 'card', label: x.title, sub: x.subtitle, insert: `@[${x.title.replace(/[\[\]]/g, '')}](${x.type}:${x.id}) ` }));
    } catch { /* suggestions are optional */ }
    if (atQuery(inputRef.current?.value ?? '', inputRef.current?.selectionStart ?? 0) === term) {
      setSugs([...people, ...cards].slice(0, 9));
      setSugIndex(0);
    }
  };
  const choose = (s: Suggestion) => {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? body.length;
    const before = body.slice(0, caret).replace(/@([^\s@\[\]]{0,30})$/, '');
    const next = before + s.insert + body.slice(caret);
    setBody(next);
    setSugs([]);
    requestAnimationFrame(() => { el?.focus(); const pos = (before + s.insert).length; el?.setSelectionRange(pos, pos); });
  };

  const send = () => run(async () => {
    if (!body.trim() && !pending.length) return;
    await api.post(`/threads/${type}/${id}/messages`, { body: body.trim(), reply_to_id: replyTo?.id ?? null, attachment_ids: pending.map((p) => p.id) });
    setBody('');
    setReplyTo(null);
    setPending([]);
    setSugs([]);
    await reload();
    emitChange();
  });

  const attach = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files).slice(0, 5)) {
      await run(async () => {
        const fd = new FormData();
        fd.set('entity_type', 'message');
        fd.set('space', space);
        fd.set('file', await prepareUpload(f));
        const r = await api.post('/attachments', fd);
        setPending((p) => [...p, { id: r.attachment.id, filename: r.attachment.filename }]);
      });
    }
  };

  if (loading && !data) return <Loading />;
  const all = data?.messages ?? [];
  const msgs = showAll ? all : all.slice(-3);
  const lastRead = data?.last_read_at ? new Date(data.last_read_at).getTime() : 0;
  const partnerFirst = me.partner?.display_name.split(' ')[0];

  return (
    <div className={`thread ${compact ? 'compact' : ''}`}>
      {space === 'me' && !compact && <p className="note subtle">Private: only you can see this conversation.</p>}
      {!all.length && <p className="muted small">No messages yet.</p>}
      {!showAll && all.length > msgs.length && <button className="link-btn" onClick={() => setShowAll(true)}>Show {all.length - msgs.length} earlier</button>}
      <ol className="messages" ref={listRef}>
        {msgs.map((m) => {
          const mine = m.author_id === me.user.id;
          const parent = m.reply_to_id ? byId.get(m.reply_to_id) : null;
          const unread = !mine && new Date(m.created_at).getTime() > lastRead;
          return (
            <li key={m.id} className={`msg ${mine ? 'mine' : ''} ${unread ? 'unread' : ''}`}>
              <div className="msg-meta"><b>{mine ? 'You' : m.author_name ?? 'Former member'}</b> <span className="muted">{relative(m.created_at)}{m.edited_at && !m.deleted_at ? ' · edited' : ''}</span>
                {m.mirrored_from_id && <span className="from-main" title="Copied from Our chat, where it was written"><MessagesSquare size={11} /> Our chat</span>}</div>
              {parent && <div className="msg-quote">↪ {parent.deleted_at ? 'Deleted message' : `${parent.author_name}: ${previewText(parent.body).slice(0, 80)}`}</div>}
              {m.deleted_at ? <div className="msg-body muted"><i>Message deleted</i></div> : editing === m.id ? (
                <div className="msg-edit">
                  <textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={2} aria-label="Edit message" />
                  <div className="row gap-s">
                    <button className="btn small primary" disabled={busy || !editBody.trim()} onClick={() => run(async () => { await api.patch(`/messages/${m.id}`, { body: editBody }); setEditing(null); await reload(); })}>Save</button>
                    <button className="btn small ghost" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="msg-body"><MessageBody body={m.body} names={names} /></div>
              )}
              {!m.deleted_at && m.attachments.length > 0 && (
                <div className="msg-atts">
                  {m.attachments.map((a) => a.content_type.startsWith('image/')
                    ? <a key={a.id} href={a.url} target="_blank" rel="noreferrer"><img src={a.url} alt={a.filename} loading="lazy" /></a>
                    : <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className="chip">{a.filename}</a>)}
                </div>
              )}
              {!m.deleted_at && (
                <div className="msg-actions">
                  <button className="link-btn" onClick={() => { setReplyTo(m); inputRef.current?.focus(); }} aria-label="Reply"><CornerUpLeft size={13} /> Reply</button>
                  {mine && !m.mirrored_from_id && <button className="link-btn" onClick={() => { setEditing(m.id); setEditBody(m.body); }} aria-label="Edit"><Pencil size={13} /></button>}
                  {mine && !m.mirrored_from_id && <button className="link-btn" onClick={() => run(async () => { await api.del(`/messages/${m.id}`); await reload(); })} aria-label="Delete"><Trash2 size={13} /></button>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="composer">
        {replyTo && <div className="replying">Replying to {replyTo.author_name}: “{previewText(replyTo.body).slice(0, 60)}” <button className="icon-btn small" onClick={() => setReplyTo(null)} aria-label="Cancel reply"><X size={14} /></button></div>}
        {pending.length > 0 && <div className="row gap-s wrap">{pending.map((p) => <span className="chip" key={p.id}>{p.filename} <button className="link-btn" aria-label={`Remove ${p.filename}`} onClick={() => setPending((x) => x.filter((y) => y.id !== p.id))}><X size={12} /></button></span>)}</div>}
        {sugs.length > 0 && (
          <ul className="suggest" role="listbox" aria-label="Mention or reference">
            {sugs.map((s, i) => (
              <li key={s.insert} role="option" aria-selected={i === sugIndex}>
                <button type="button" className={i === sugIndex ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); choose(s); }}>
                  {s.kind === 'card' ? <Hash size={13} /> : <span className="at">@</span>}
                  <span className="grow clamp1">{s.label}</span>
                  {s.sub && <span className="muted tiny">{s.sub}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="composer-row">
          <label className="icon-btn" aria-label="Attach photo or file" title="Attach photo or file">
            <Paperclip size={18} />
            <input type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => attach(e.target.files)} />
          </label>
          <textarea
            ref={inputRef}
            value={body}
            rows={1}
            placeholder={placeholder ?? (space === 'us' ? `Message${partnerFirst ? ` ${partnerFirst}` : ''}… type @ to mention or link a card` : 'Private note… type @ to link a card')}
            aria-label="Message"
            onChange={(e) => { setBody(e.target.value); refreshSuggestions(e.target.value, e.target.selectionStart); }}
            onKeyDown={(e) => {
              if (sugs.length) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSugIndex((i) => (i + 1) % sugs.length); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSugIndex((i) => (i - 1 + sugs.length) % sugs.length); return; }
                if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(sugs[sugIndex]); return; }
                if (e.key === 'Escape') { setSugs([]); return; }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            }}
            onBlur={() => setTimeout(() => setSugs([]), 150)}
          />
          <button className="btn primary icon-only" disabled={busy || (!body.trim() && !pending.length)} onClick={send} aria-label="Send"><Send size={16} /></button>
        </div>
      </div>
    </div>
  );
}
