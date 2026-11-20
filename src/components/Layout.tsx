import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useSearchParams } from 'react-router-dom';
import { Bell, ChartLine, House, LayoutGrid, MessageCircle, Search, Settings } from 'lucide-react';
import { api, useApi } from '../lib/api';
import { relative } from '../lib/format';
import { EntitySheet } from './EntitySheet';
import { NOTIF_ICON, useNotificationGo } from '../pages/Notifications';

export type OpenType = 'item' | 'task' | 'event' | 'inventory' | 'expense';

/** Where a card reference leads: some cards open as a pop-up, others are places. */
export function cardPath(type: string, id: string, _extra?: { is_plan?: boolean }): string | null {
  if (type === 'topic') return `/chat?topic=${id}`;
  if (type === 'pin') return `/board?pin=${id}`;
  if (type === 'list') return `/lists/${id}`;
  return null;
}

/** Open any record as a pop-up on top of the current screen. `chat` opens its conversation. */
export function useOpen() {
  const [params, setParams] = useSearchParams();
  return (type: OpenType, id: string, opts?: { chat?: boolean }) => {
    const next = new URLSearchParams(params);
    next.set('open', `${type}:${id}${opts?.chat ? ':chat' : ''}`);
    setParams(next);
  };
}

/**
 * Phone-first shell: one column (centred on bigger screens), a bell and
 * search at the top, and five symbols at the bottom.
 */
export function Layout({ children }: { children: ReactNode }) {
  const [params, setParams] = useSearchParams();
  const loc = useLocation();
  const { data: notif, reload } = useApi<{ unread: number }>('/notifications?unread=true', [loc.pathname]);
  const { data: chat, reload: reloadChat } = useApi<{ unread: number }>('/chat/unread', [loc.pathname]);
  const [bell, setBell] = useState(false);
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') { reload(); reloadChat(); }
    }, 30_000);
    return () => clearInterval(t);
  }, [reload, reloadChat]);
  useEffect(() => setBell(false), [loc.pathname]);

  const open = params.get('open');
  const [openType, openId, openMode] = open ? (open.split(':') as [OpenType, string, string?]) : [null, null, null];
  const close = () => {
    const next = new URLSearchParams(params);
    next.delete('open');
    setParams(next);
  };

  const tabs = [
    { to: '/', label: 'Home', icon: <House size={26} strokeWidth={2.2} />, end: true },
    { to: '/board', label: 'Board', icon: <LayoutGrid size={26} strokeWidth={2.2} />, end: false },
    { to: '/chat', label: 'Chat', icon: <MessageCircle size={26} strokeWidth={2.2} />, end: false, badge: chat?.unread },
    { to: '/data', label: 'Data', icon: <ChartLine size={26} strokeWidth={2.2} />, end: false },
    { to: '/settings', label: 'Settings', icon: <Settings size={26} strokeWidth={2.2} />, end: false },
  ];
  // Lists and the calendar are opened from Home, so Home stays lit there.
  const homeish = loc.pathname === '/' || loc.pathname.startsWith('/lists') || loc.pathname.startsWith('/calendar') || loc.pathname.startsWith('/plan');

  return (
    <div className="app">
      <div className="top-actions">
        <Link to="/search" className="top-btn" aria-label="Search"><Search size={20} /></Link>
        <div className="menu-wrap">
          <button className={`top-btn ${bell ? 'on' : ''}`} onClick={() => setBell((x) => !x)} aria-label={`Notifications${notif?.unread ? ` (${notif.unread} new)` : ''}`} aria-expanded={bell}>
            <Bell size={20} />{notif?.unread ? <b className="badge dot">{notif.unread}</b> : null}
          </button>
          {bell && <NotificationPopover onClose={() => { setBell(false); reload(); }} />}
        </div>
      </div>

      <main className="app-main" id="main">{children}</main>

      <nav className="tabbar" aria-label="Main">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} aria-label={t.label} title={t.label}
            className={({ isActive }) => `tab ${isActive || (t.to === '/' && homeish) ? 'active' : ''}`}>
            {t.icon}{t.badge ? <b className="badge dot">{t.badge}</b> : null}
          </NavLink>
        ))}
      </nav>

      {openType && openId && <EntitySheet type={openType} id={openId} chat={openMode === 'chat'} onClose={() => { close(); reload(); reloadChat(); api.get('/notifications?unread=true').catch(() => {}); }} />}
    </div>
  );
}

/** The latest notifications in a small pop-up under the bell, with a way to the full activity. */
function NotificationPopover({ onClose }: { onClose: () => void }) {
  const { data } = useApi<{ notifications: any[]; unread: number }>('/notifications');
  const go = useNotificationGo(onClose);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.top-btn')) onClose(); };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const items = (data?.notifications ?? []).slice(0, 8);
  return (
    <div className="notif-pop" ref={ref} role="dialog" aria-label="Notifications">
      <header><b>Notifications</b>{data && data.unread > 0 && <span className="muted tiny">{data.unread} new</span>}</header>
      {!data ? <p className="muted small pad">Loading…</p> : !items.length ? <p className="muted small pad">Nothing new. Mentions, replies and reminders show up here.</p> : (
        <ul>
          {items.map((n) => (
            <li key={n.id} className={n.read_at ? '' : 'unread'}>
              <button onClick={() => go(n)}>
                <span className="notif-icon">{NOTIF_ICON[n.type]}</span>
                <span className="grow"><span className="clamp1 block">{n.title}</span>{n.body && <span className="muted tiny clamp1 block">“{n.body}”</span>}</span>
                <span className="muted tiny">{relative(n.created_at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Link to="/notifications" className="notif-all" onClick={onClose}>View full activity</Link>
    </div>
  );
}
