import { useLocation, useNavigate } from 'react-router-dom';
import { AtSign, Bell, CalendarDays, CheckSquare, MessageCircle, Share2, Sparkles } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { relative } from '../lib/format';
import { Empty, Loading, useAction } from '../components/ui';

const ICON: Record<string, React.ReactNode> = {
  mention: <AtSign size={16} />, reply: <MessageCircle size={16} />, shared: <Share2 size={16} />, assigned: <CheckSquare size={16} />,
  reminder: <Bell size={16} />, calendar: <CalendarDays size={16} />, decision: <Sparkles size={16} />,
};
export const NOTIF_ICON = ICON;

/**
 * Open what a notification is about without leaving the page where possible:
 * items, to-dos and events open as a pop-up on top of the current screen.
 */
export function useNotificationGo(onDone?: () => void) {
  const nav = useNavigate();
  const loc = useLocation();
  const { run } = useAction();
  return (n: any) => run(async () => {
    await api.post('/notifications/read', { ids: [n.id] });
    emitChange();
    onDone?.();
    const chat = n.type === 'mention' || n.type === 'reply';
    if (!n.entity_type || !n.entity_id) return;
    if (n.entity_type === 'topic') return nav(`/chat?topic=${n.entity_id}`);
    if (n.entity_type === 'list') return nav(`/?chat=${n.entity_id}`);
    if (n.entity_type === 'pin') return nav(`/board?pin=${n.entity_id}`);
    if (n.entity_type === 'expense') return nav('/data');
    const base = loc.pathname === '/notifications' ? '/' : loc.pathname;
    const params = new URLSearchParams(loc.pathname === '/notifications' ? '' : loc.search);
    params.set('open', `${n.entity_type}:${n.entity_id}${chat ? ':chat' : ''}`);
    nav(`${base}?${params}`);
  });
}

export function NotificationsPage() {
  const { data } = useApi<{ notifications: any[]; unread: number }>('/notifications');
  const { run } = useAction();
  const go = useNotificationGo();
  if (!data) return <div className="page"><Loading /></div>;
  return (
    <div className="page narrow">
      <header className="page-head">
        <h1>Activity</h1>
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
