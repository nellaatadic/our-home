import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useApi } from './api';
import { useMe } from './session';

export interface NickRule { id: string; target_id: string; name: string; rule: 'weekly' | 'yearly' | 'once'; weekday: number | null; month_day: string | null; on_date: string | null }

interface Ctx { rules: NickRule[]; reload: () => void; name: (userId: string | null | undefined, fallback?: string | null) => string; swap: (text: string) => string }

const NickContext = createContext<Ctx>({ rules: [], reload: () => {}, name: (_id, f) => f ?? '', swap: (t) => t });

/** Does a rule apply today (on this device's calendar)? A one-off date wins over a yearly one, which wins over a weekday. */
function todays(rules: NickRule[], userId: string, now = new Date()) {
  const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const mine = rules.filter((r) => r.target_id === userId);
  return mine.find((r) => r.rule === 'once' && r.on_date === ymd)
    ?? mine.find((r) => r.rule === 'yearly' && r.month_day === ymd.slice(5))
    ?? mine.find((r) => r.rule === 'weekly' && r.weekday === now.getDay())
    ?? null;
}

export function describeRule(r: Pick<NickRule, 'rule' | 'weekday' | 'month_day' | 'on_date'>) {
  if (r.rule === 'weekly') return `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][r.weekday ?? 0]}`;
  if (r.rule === 'yearly') {
    const [m, d] = (r.month_day ?? '01-01').split('-').map(Number);
    return `Every year on ${new Date(2000, m - 1, d).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}`;
  }
  return `On ${new Date(`${r.on_date}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}`;
}

/**
 * Names you gave someone for certain days ("Big Friday" every Friday). Only
 * you see them; everywhere a name shows up, today's nickname is used instead.
 */
export function NickProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  const { data, reload } = useApi<{ nicknames: NickRule[] }>('/nicknames');
  const value = useMemo<Ctx>(() => {
    const rules = data?.nicknames ?? [];
    const today = new Map(me.members.map((m) => [m.id, todays(rules, m.id)?.name ?? null]));
    const name = (id: string | null | undefined, fallback?: string | null) => {
      const real = me.members.find((m) => m.id === id)?.display_name ?? fallback ?? '';
      return (id && today.get(id)) || real;
    };
    const swaps = me.members.filter((m) => today.get(m.id)).map((m) => ({ real: m.display_name, first: m.display_name.split(' ')[0], nick: today.get(m.id)! }));
    const swap = (text: string) => swaps.reduce((t, s) => t.split(s.real).join(s.nick).replace(new RegExp(`\\b${s.first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), s.nick), text);
    return { rules, reload, name, swap };
  }, [data, reload, me]);
  return <NickContext.Provider value={value}>{children}</NickContext.Provider>;
}

export const useNick = () => useContext(NickContext);
