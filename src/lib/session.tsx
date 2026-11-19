import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export interface Member { id: string; display_name: string; role: 'primary' | 'partner' }
export interface Session {
  user: { id: string; email: string; display_name: string };
  role: 'primary' | 'partner';
  household: { id: string; name: string; timezone: string; currency: string; auto_move_to_stock: boolean };
  partner: Member | null;
  members: Member[];
}

interface Ctx {
  session: Session | null;
  loading: boolean;
  config: { google_configured: boolean; ai_configured: boolean };
  setSession: (s: Session | null) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<Ctx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState({ google_configured: false, ai_configured: false });
  const refresh = useCallback(async () => {
    try {
      const me = await api.get('/auth/me');
      setSession(me.user ? me : null);
    } catch {
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    refresh();
    api.get('/config').then(setConfig).catch(() => {});
    const onUnauth = () => setSession(null);
    window.addEventListener('ourhome:unauthenticated', onUnauth);
    return () => window.removeEventListener('ourhome:unauthenticated', onUnauth);
  }, [refresh]);
  const logout = async () => {
    await api.post('/auth/logout');
    setSession(null);
  };
  return <SessionContext.Provider value={{ session, loading, config, setSession, refresh, logout }}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const c = useContext(SessionContext);
  if (!c) throw new Error('useSession outside provider');
  return c;
}

/** The signed-in session (only use inside authenticated routes). */
export function useMe(): Session {
  const { session } = useSession();
  if (!session) throw new Error('not signed in');
  return session;
}

export function nameOf(s: Session, id: string | null | undefined) {
  if (!id) return '';
  return s.members.find((m) => m.id === id)?.display_name ?? 'Former member';
}
