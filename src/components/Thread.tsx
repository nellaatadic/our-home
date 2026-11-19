import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerUpLeft, Paperclip, Pencil, Send, Trash2, X } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { relative } from '../lib/format';
import { prepareUpload } from '../lib/image';
import { Loading, useAction } from './ui';

interface Msg {
  id: string; author_id: string; author_name: string; body: string; reply_to_id: string | null; created_at: string;
  edited_at: string | null; deleted_at: string | null; mention_ids: string[]; attachments: { id: string; filename: string; content_type: string; url: string }[];
}

function renderBody(body: string, names: string[]) {
  const parts = body.split(/(@[\p{L}\p{N}_.-]+)/u);
  return parts.map((p, i) => {
    if (p.startsWith('@') && (['@me', '@you'].includes(p.toLowerCase()) || names.some((n) => p.slice(1).toLowerCase() === n.split(' ')[0].toLowerCase()))) {
      return <span key={i} className="mention">{p}</span>;
    }
    return <span key={i}>{p}</span>;
  });
}

/** One conversation per record. */
export function Thread({ type, id, space }: { type: string; id: string; space: 'me' | 'us' }) {
  const me = useMe();
  const { data, loading, reload } = useApi<{ messages: Msg[]; last_read_at: string | null }>(`/threads/${type}/${id}`);
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [pending, setPending] = useState<{ id: string; filename: string }[]>([]);
  const { busy, run } = useAction();
  const endRef = useRef<HTMLDivElement>(null);
  const names = useMemo(() => me.members.map((m) => m.display_name), [me]);
  const byId = useMemo(() => new Map((data?.messages ?? []).map((m) => [m.id, m])), [data]);

  useEffect(() => {
    if (data?.messages.length) {
      api.post(`/threads/${type}/${id}/read`).then(emitChange).catch(() => {});
      endRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [data?.messages.length, type, id]);

  const send = () => run(async () => {
    await api.post(`/threads/${type}/${id}/messages`, { body, reply_to_id: replyTo?.id ?? null, attachment_ids: pending.map((p) => p.id) });
    setBody('');
    setReplyTo(null);
    setPending([]);
    await reload();
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

  const mentionable = space === 'us' ? me.members.filter((m) => m.id !== me.user.id) : [];
  if (loading && !data) return <Loading />;
  const msgs = data?.messages ?? [];
  const lastRead = data?.last_read_at ? new Date(data.last_read_at).getTime() : 0;

  return (
    <div className="thread">
      {space === 'me' && <p className="note subtle">This conversation is private — only you can see it.</p>}
      {!msgs.length && <p className="muted small">No messages yet. Start the conversation about this item.</p>}
      <ol className="messages">
        {msgs.map((m) => {
          const mine = m.author_id === me.user.id;
          const parent = m.reply_to_id ? byId.get(m.reply_to_id) : null;
          const unread = !mine && new Date(m.created_at).getTime() > lastRead;
          return (
            <li key={m.id} className={`msg ${mine ? 'mine' : ''} ${unread ? 'unread' : ''}`}>
              <div className="msg-meta"><b>{m.author_name ?? 'Former member'}</b> <span className="muted">{relative(m.created_at)}{m.edited_at && !m.deleted_at ? ' · edited' : ''}</span></div>
              {parent && <div className="msg-quote">↪ {parent.deleted_at ? 'Deleted message' : `${parent.author_name}: ${parent.body.slice(0, 80)}`}</div>}
              {m.deleted_at ? <div className="msg-body muted"><i>Message deleted</i></div> : editing === m.id ? (
                <div className="msg-edit">
                  <textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={2} aria-label="Edit message" />
                  <div className="row gap-s">
                    <button className="btn small primary" disabled={busy || !editBody.trim()} onClick={() => run(async () => { await api.patch(`/messages/${m.id}`, { body: editBody }); setEditing(null); await reload(); })}>Save</button>
                    <button className="btn small ghost" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="msg-body">{renderBody(m.body, names)}</div>
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
                  <button className="link-btn" onClick={() => setReplyTo(m)} aria-label="Reply"><CornerUpLeft size={14} /> Reply</button>
                  {mine && <button className="link-btn" onClick={() => { setEditing(m.id); setEditBody(m.body); }} aria-label="Edit"><Pencil size={14} /> Edit</button>}
                  {mine && <button className="link-btn" onClick={() => run(async () => { await api.del(`/messages/${m.id}`); await reload(); })} aria-label="Delete"><Trash2 size={14} /> Delete</button>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div ref={endRef} />
      <div className="composer">
        {replyTo && <div className="replying">Replying to {replyTo.author_name}: “{replyTo.body.slice(0, 60)}” <button className="icon-btn small" onClick={() => setReplyTo(null)} aria-label="Cancel reply"><X size={14} /></button></div>}
        {pending.length > 0 && <div className="row gap-s wrap">{pending.map((p) => <span className="chip" key={p.id}>{p.filename}</span>)}</div>}
        {mentionable.length > 0 && (
          <div className="row gap-s">
            {mentionable.map((m) => <button key={m.id} type="button" className="chip button" onClick={() => setBody((b) => `${b}${b && !b.endsWith(' ') ? ' ' : ''}@${m.display_name.split(' ')[0]} `)}>@{m.display_name.split(' ')[0]}</button>)}
          </div>
        )}
        <div className="composer-row">
          <label className="icon-btn" aria-label="Attach file">
            <Paperclip size={18} />
            <input type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => attach(e.target.files)} />
          </label>
          <textarea
            value={body} onChange={(e) => setBody(e.target.value)} rows={1} placeholder={space === 'us' ? `Message… use @${me.partner?.display_name.split(' ')[0] ?? 'name'} to mention` : 'Private note…'}
            aria-label="Message"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (body.trim() || pending.length)) send(); }}
          />
          <button className="btn primary" disabled={busy || (!body.trim() && !pending.length)} onClick={send} aria-label="Send"><Send size={16} /></button>
        </div>
      </div>
    </div>
  );
}
