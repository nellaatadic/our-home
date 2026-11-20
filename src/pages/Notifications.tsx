import { useLocation, useNavigate } from 'react-router-dom';
import { Check } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { relative } from '../lib/format';
import { useNick } from '../lib/nick';
import { Empty, Loading, useAction } from '../components/ui';

/** Where a line in the activity leads: the card on Home (and the # item in it), or the thing's own pop-up. */
export function notificationTarget(n: any, here: { pathname: string; search: string }): string | null {
  if (!n.entity_type || !n.entity_id) return null;
  const chat = n.type === 'mention' || n.type === 'reply';
  if (n.entity_type === 'topic') return `/chat?topic=${n.entity_id}`;
  if (n.entity_type === 'list') return `/?chat=${n.entity_id}`;
  if (n.entity_type === 'pin') return `/board?pin=${n.entity_id}`;
  if (n.entity_type === 'expense') return '/data';
  if (n.entity_type === 'item' && !chat) {
    if (n.list_event_id) return `/calendar?open=event:${n.list_event_id}`;
    // Groceries have no # items of their own: go to the card.
    if (n.list_key) return `/?focus=${n.list_key}${n.list_key === 'grocery' ? '' : `&item=${n.entity_id}`}`;
  }
  if (n.entity_type === 'task' && !chat) return `/?focus=todos&item=${n.entity_id}`;
  const base = here.pathname === '/notifications' ? '/' : here.pathname;
  const params = new URLSearchParams(here.pathname === '/notifications' ? '' : here.search);
  params.set('open', `${n.entity_type}:${n.entity_id}${chat ? ':chat' : ''}`);
  return `${base}?${params}`;
}

/** Open what a notification is about, marking it read. */
export function useNotificationGo(onDone?: () => void) {
  const nav = useNavigate();
  const loc = useLocation();
  const { run } = useAction();
  return (n: any) => run(async () => {
    await api.post('/notifications/read', { ids: [n.id] });
    emitChange();
    onDone?.();
    const to = notificationTarget(n, loc);
    if (to) nav(to);
  });
}

/**
 * Activity: one line per thing that happened, newest first. Tap the words to
 * go where it happened; “OK” just notes it.
 */
export function NotificationsPage() {
  const { data, reload } = useApi<{ notifications: any[]; unread: number }>('/notifications');
  const { run } = useAction();
  const { swap } = useNick();
  const go = useNotificationGo();
  if (!data) return <div className="page"><Loading /></div>;
  const ok = (n: any) => run(async () => { await api.post('/notifications/read', { ids: [n.id] }); await reload(); emitChange(); });
  return (
    <div className="page narrow activity-page">
      <header className="page-head compact">
        <h1>Activity</h1>
        {data.unread > 0 && <button className="link-btn" onClick={() => run(async () => { await api.post('/notifications/read', { all: true }); await reload(); emitChange(); })}>All OK</button>}
      </header>
      {data.notifications.length ? (
        <ul className="activity-list">
          {data.notifications.map((n) => (
            <li key={n.id} className={n.read_at ? 'seen' : 'new'}>
              <button className="activity-text" onClick={() => go(n)}>
                {swap(n.title)}
                {n.body && n.type !== 'activity' && <span className="activity-quote"> “{swap(n.body)}”</span>}
              </button>
              <span className="activity-time">{relative(n.created_at)}</span>
              {!n.read_at
                ? <button className="activity-ok" onClick={() => ok(n)} aria-label="OK, noted">OK</button>
                : <span className="activity-ok done" aria-label="Seen"><Check size={13} /></span>}
            </li>
          ))}
        </ul>
      ) : <Empty title="Nothing yet">What happens in your lists, chats and calendar shows up here.</Empty>}
    </div>
  );
}
