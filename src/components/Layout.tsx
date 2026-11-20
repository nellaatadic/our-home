import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useSearchParams } from 'react-router-dom';
import { Bell, ChartLine, House, LayoutGrid, MessageCircle, Search, Settings } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { relative } from '../lib/format';
import { EntitySheet } from './EntitySheet';
import { useNotificationGo } from '../pages/Notifications';
import { useNick } from '../lib/nick';

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
  const shown = useRef<string[]>([]);
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') { reload(); reloadChat(); }
    }, 30_000);
    return () => clearInterval(t);
  }, [reload, reloadChat]);
  useEffect(() => { if (bell) { markShownRead(shown); setBell(false); } }, [loc.pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  useTypingMode();

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
          <button className={`top-btn ${bell ? 'on' : ''}`} onClick={() => { if (bell) { markShownRead(shown); setBell(false); setTimeout(reload, 300); } else setBell(true); }} aria-label={`Notifications${notif?.unread ? ` (${notif.unread} new)` : ''}`} aria-expanded={bell}>
            <Bell size={20} />{notif?.unread ? <b className="badge dot">{notif.unread}</b> : null}
          </button>
          {bell && <NotificationPopover shown={shown} onClose={() => { setBell(false); setTimeout(reload, 300); }} />}
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

/**
 * On a phone the keyboard takes half the screen: while typing, the top and
 * bottom bars step aside and the chat fits the space that is left.
 */
function useTypingMode() {
  useEffect(() => {
    const isField = (t: EventTarget | null) => t instanceof HTMLElement && t.matches('textarea, input:not([type=checkbox]):not([type=radio]):not([type=file]), [contenteditable]');
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const on = (e: FocusEvent) => { if (coarse && isField(e.target)) document.body.classList.add('typing'); };
    const off = () => setTimeout(() => { if (!isField(document.activeElement)) document.body.classList.remove('typing'); }, 60);
    const vv = window.visualViewport;
    const fit = () => {
      document.documentElement.style.setProperty('--vvh', `${Math.round(vv ? vv.height : window.innerHeight)}px`);
      document.documentElement.style.setProperty('--vvt', `${Math.round(vv ? vv.offsetTop : 0)}px`);
    };
    fit();
    document.addEventListener('focusin', on);
    document.addEventListener('focusout', off);
    vv?.addEventListener('resize', fit);
    vv?.addEventListener('scroll', fit);
    window.addEventListener('resize', fit);
    return () => {
      document.removeEventListener('focusin', on); document.removeEventListener('focusout', off);
      vv?.removeEventListener('resize', fit); vv?.removeEventListener('scroll', fit); window.removeEventListener('resize', fit);
      document.body.classList.remove('typing');
    };
  }, []);
}

/**
 * What is new, in a small pop-up under the bell. Opening and closing it
 * clears them; the full activity is one tap away when there is something.
 */
export function markShownRead(shown: { current: string[] }) {
  if (shown.current.length) api.post('/notifications/read', { ids: shown.current }).then(emitChange).catch(() => {});
  shown.current = [];
}

function NotificationPopover({ onClose, shown }: { onClose: () => void; shown: { current: string[] } }) {
  const { data } = useApi<{ notifications: any[]; unread: number }>('/notifications?unread=true');
  const { swap } = useNick();
  const close = () => { markShownRead(shown); onClose(); };
  const go = useNotificationGo(close);
  const ref = useRef<HTMLDivElement>(null);
  const items = (data?.notifications ?? []).slice(0, 8);
  shown.current = items.map((n) => n.id);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.top-btn')) closeRef.current(); };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, []);
  return (
    <div className="notif-pop" ref={ref} role="dialog" aria-label="Notifications">
      {!data ? <p className="muted small pad">Loading…</p> : !items.length ? <p className="muted small pad">You’re all caught up.</p> : (
        <ul>
          {items.map((n) => (
            <li key={n.id}>
              <button onClick={() => go(n)}>
                <span className="grow clamp2">{swap(n.title)}</span>
                <span className="muted tiny nowrap">{relative(n.created_at)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 && <Link to="/notifications" className="notif-all" onClick={close}>View full activity</Link>}
    </div>
  );
}
