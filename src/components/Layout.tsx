import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Bell, CalendarDays, Home, Search, Settings, User, Users, Heart } from 'lucide-react';
import { api, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { EntitySheet } from './EntitySheet';

export type OpenType = 'item' | 'task' | 'event' | 'inventory' | 'expense';

/** Open any record in the global detail sheet, from anywhere. */
export function useOpen() {
  const [params, setParams] = useSearchParams();
  return (type: OpenType, id: string) => {
    const next = new URLSearchParams(params);
    next.set('open', `${type}:${id}`);
    setParams(next);
  };
}

export function Layout({ children }: { children: ReactNode }) {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const loc = useLocation();
  const { data: notif, reload } = useApi<{ unread: number }>('/notifications?unread=true', [loc.pathname]);
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, 60_000);
    return () => clearInterval(t);
  }, [reload]);

  const open = params.get('open');
  const [openType, openId] = open ? (open.split(':') as [OpenType, string]) : [null, null];
  const close = () => {
    const next = new URLSearchParams(params);
    next.delete('open');
    setParams(next);
  };
  const partnerName = me.partner?.display_name ?? 'YOU';

  const links = [
    { to: '/', label: 'Home', icon: <Home size={20} />, end: true },
    { to: '/me', label: 'ME', sub: me.user.display_name, icon: <User size={20} />, cls: 'nav-me' },
    { to: '/you', label: 'YOU', sub: partnerName, icon: <Heart size={20} />, cls: 'nav-you' },
    { to: '/us', label: 'US', sub: 'Shared', icon: <Users size={20} />, cls: 'nav-us' },
    { to: '/calendar', label: 'Calendar', icon: <CalendarDays size={20} /> },
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark" aria-hidden>⌂</span> OUR HOME</div>
        <form className="search-box" onSubmit={(e) => { e.preventDefault(); if (q.trim().length >= 2) nav(`/search?q=${encodeURIComponent(q.trim())}`); }}>
          <Search size={16} aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search everything" aria-label="Search" />
        </form>
        <nav className="side-nav">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => `side-link ${l.cls ?? ''} ${isActive || (l.to !== '/' && loc.pathname.startsWith(l.to)) ? 'active' : ''}`}>
              {l.icon}<span>{l.label}</span>{l.sub && <small>{l.sub}</small>}
            </NavLink>
          ))}
          <NavLink to="/notifications" className={({ isActive }) => `side-link ${isActive ? 'active' : ''}`}>
            <Bell size={20} /><span>Notifications</span>{notif?.unread ? <b className="badge">{notif.unread}</b> : null}
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `side-link ${isActive ? 'active' : ''}`}><Settings size={20} /><span>Settings</span></NavLink>
        </nav>
        <div className="side-foot muted">{me.household.name}</div>
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
        {links.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => `tab ${l.cls ?? ''} ${isActive || (l.to !== '/' && loc.pathname.startsWith(l.to)) ? 'active' : ''}`}>
            {l.icon}<span>{l.label === 'YOU' ? partnerName : l.label}</span>
          </NavLink>
        ))}
      </nav>

      {openType && openId && <EntitySheet type={openType} id={openId} onClose={() => { close(); reload(); api.get('/notifications?unread=true').catch(() => {}); }} />}
    </div>
  );
}
