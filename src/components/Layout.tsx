import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { BarChart3, Bell, CalendarDays, Home, Menu, MessagesSquare, Search, Settings, X } from 'lucide-react';
import { api, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { LISTS } from '../lib/lists';
import { EntitySheet } from './EntitySheet';

export type OpenType = 'item' | 'task' | 'event' | 'inventory' | 'expense';

/** Open any record in the global detail sheet, from anywhere. `chat` opens its conversation. */
export function useOpen() {
  const [params, setParams] = useSearchParams();
  return (type: OpenType, id: string, opts?: { chat?: boolean }) => {
    const next = new URLSearchParams(params);
    next.set('open', `${type}:${id}${opts?.chat ? ':chat' : ''}`);
    setParams(next);
  };
}

function ListIcon({ color, emoji }: { color: string; emoji: string }) {
  return <span className="list-icon nav" style={{ background: color }} aria-hidden>{emoji}</span>;
}

export function Layout({ children }: { children: ReactNode }) {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const loc = useLocation();
  const { data: notif, reload } = useApi<{ unread: number }>('/notifications?unread=true', [loc.pathname]);
  const { data: chat, reload: reloadChat } = useApi<{ unread: number }>('/chat/unread', [loc.pathname]);
  const [q, setQ] = useState('');
  const [more, setMore] = useState(false);
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') { reload(); reloadChat(); }
    }, 30_000);
    return () => clearInterval(t);
  }, [reload, reloadChat]);
  useEffect(() => setMore(false), [loc.pathname]);

  const open = params.get('open');
  const [openType, openId, openMode] = open ? (open.split(':') as [OpenType, string, string?]) : [null, null, null];
  const close = () => {
    const next = new URLSearchParams(params);
    next.delete('open');
    setParams(next);
  };

  type NavItem = { to: string; label: string; short?: string; icon: ReactNode; end: boolean; badge?: number };
  const main: NavItem[] = [
    { to: '/', label: 'Home', icon: <Home size={19} />, end: true },
    ...LISTS.map((l) => ({ to: `/lists/${l.slug}`, label: l.label, short: l.short, icon: <ListIcon color={l.color} emoji={l.emoji} />, end: false })),
    { to: '/chat', label: 'Chat', icon: <MessagesSquare size={19} />, badge: chat?.unread, end: false },
    { to: '/calendar', label: 'Calendar', icon: <CalendarDays size={19} />, end: false },
    { to: '/data', label: 'Data', icon: <BarChart3 size={19} />, end: false },
  ];
  const isActive = (to: string, end?: boolean) => (end ? loc.pathname === to : loc.pathname.startsWith(to));
  const tabs = [main[0], main[1], main[4], main[5]];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark" aria-hidden>⌂</span> OUR HOME</div>
        <form className="search-box" onSubmit={(e) => { e.preventDefault(); if (q.trim().length >= 2) nav(`/search?q=${encodeURIComponent(q.trim())}`); }}>
          <Search size={15} aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search everything" />
        </form>
        <nav className="side-nav">
          {main.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} className={`side-link ${isActive(l.to, l.end) ? 'active' : ''}`}>
              {l.icon}<span>{l.label}</span>{l.badge ? <b className="badge">{l.badge}</b> : null}
            </NavLink>
          ))}
        </nav>
        <nav className="side-nav foot">
          <NavLink to="/notifications" className={`side-link ${isActive('/notifications') ? 'active' : ''}`}>
            <Bell size={18} /><span>Notifications</span>{notif?.unread ? <b className="badge">{notif.unread}</b> : null}
          </NavLink>
          <NavLink to="/settings" className={`side-link ${isActive('/settings') ? 'active' : ''}`}><Settings size={18} /><span>Settings</span></NavLink>
          <div className="side-foot muted">{me.members.map((m) => m.display_name).join(' & ')}</div>
        </nav>
      </aside>

      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden>⌂</span> OUR HOME</div>
        <div className="topbar-actions">
          <NavLink to="/search" className="icon-btn" aria-label="Search"><Search size={20} /></NavLink>
          <NavLink to="/notifications" className="icon-btn" aria-label="Notifications"><Bell size={20} />{notif?.unread ? <b className="badge dot">{notif.unread}</b> : null}</NavLink>
          <NavLink to="/settings" className="icon-btn" aria-label="Settings"><Settings size={20} /></NavLink>
        </div>
      </header>

      <main className="main" id="main">{children}</main>

      <nav className="tabbar" aria-label="Main">
        {tabs.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} className={`tab ${isActive(l.to, l.end) ? 'active' : ''}`}>
            {l.icon}<span>{l.short ?? l.label}</span>{l.badge ? <b className="badge dot">{l.badge}</b> : null}
          </NavLink>
        ))}
        <button className={`tab ${more ? 'active' : ''}`} onClick={() => setMore((x) => !x)} aria-expanded={more}>
          {more ? <X size={19} /> : <Menu size={19} />}<span>More</span>
        </button>
      </nav>
      {more && (
        <div className="more-menu" role="menu">
          {[main[2], main[3], main[6]].map((l) => (
            <NavLink key={l.to} to={l.to} className="side-link" role="menuitem">{l.icon}<span>{l.label}</span></NavLink>
          ))}
        </div>
      )}

      {openType && openId && <EntitySheet type={openType} id={openId} chat={openMode === 'chat'} onClose={() => { close(); reload(); reloadChat(); api.get('/notifications?unread=true').catch(() => {}); }} />}
    </div>
  );
}
