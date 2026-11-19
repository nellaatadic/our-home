import { useNavigate } from 'react-router-dom';
import { AtSign, Bell, CalendarDays, CheckSquare, MessageCircle, Share2, Sparkles } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { relative } from '../lib/format';
import { Empty, Loading, useAction } from '../components/ui';

const ICON: Record<string, React.ReactNode> = {
  mention: <AtSign size={16} />, reply: <MessageCircle size={16} />, shared: <Share2 size={16} />, assigned: <CheckSquare size={16} />,
  reminder: <Bell size={16} />, calendar: <CalendarDays size={16} />, decision: <Sparkles size={16} />,
};
const PATH: Record<string, string> = { item: '/', task: '/', event: '/calendar', inventory: '/', expense: '/data' };

export function NotificationsPage() {
  const { data, reload } = useApi<{ notifications: any[]; unread: number }>('/notifications');
  const nav = useNavigate();
  const { run } = useAction();
  const go = (n: any) => run(async () => {
    await api.post('/notifications/read', { ids: [n.id] });
    emitChange();
    if (n.entity_type === 'topic') nav(`/chat?topic=${n.entity_id}`);
    else if (n.entity_type && n.entity_id && (n.type === 'mention' || n.type === 'reply')) nav(`/chat?open=${n.entity_type}:${n.entity_id}:chat`);
    else if (n.entity_type && n.entity_id) nav(`${PATH[n.entity_type] ?? '/'}?open=${n.entity_type}:${n.entity_id}`);
    else reload();
  });
  if (!data) return <div className="page"><Loading /></div>;
  return (
    <div className="page narrow">
      <header className="page-head">
        <h1>Notifications</h1>
        {data.unread > 0 && <button className="btn small ghost" onClick={() => run(async () => { await api.post('/notifications/read', { all: true }); emitChange(); })}>Mark all read</button>}
      </header>
      {data.notifications.length ? (
        <ul className="notif-list">
          {data.notifications.map((n) => (
            <li key={n.id} className={n.read_at ? '' : 'unread'}>
              <button className="row-btn" onClick={() => go(n)}>
                <span className="notif-icon">{ICON[n.type]}</span>
                <span className="grow"><span>{n.title}</span>{n.body && <span className="muted small block">“{n.body}”</span>}</span>
                <span className="muted small">{relative(n.created_at)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <Empty title="No notifications">Mentions, replies, shared items and reminders show up here.</Empty>}
      <p className="muted small">Choose which notifications you receive in Settings.</p>
    </div>
  );
}
