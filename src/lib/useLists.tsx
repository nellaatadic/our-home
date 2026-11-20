import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useApi } from './api';
import { builtinDefs, customDef, type ListDef } from './lists';

interface Nav { builtin: Record<string, string>; builtin_style?: Record<string, { emoji: string | null; color: string | null }>; custom: { id: string; name: string; emoji: string | null; color: string | null; private: boolean; need: number }[] }
interface Ctx { lists: ListDef[]; ready: boolean; reload: () => void }

const ListsContext = createContext<Ctx>({ lists: builtinDefs(), ready: false, reload: () => {} });

/** All lists (built-in and the household's own) for the sidebar, dashboard, item sheet and @ references. */
export function ListsProvider({ children }: { children: ReactNode }) {
  const { data, reload } = useApi<Nav>('/lists/nav');
  const value = useMemo<Ctx>(() => ({
    lists: [...builtinDefs(data?.builtin, data?.builtin_style), ...(data?.custom ?? []).map((l, i) => customDef(l, i))],
    ready: Boolean(data),
    reload,
  }), [data, reload]);
  return <ListsContext.Provider value={value}>{children}</ListsContext.Provider>;
}

export function useLists() {
  return useContext(ListsContext);
}

/** Find a list by slug (built-in) or id (custom or built-in). */
export function findList(lists: ListDef[], slugOrId: string | null | undefined) {
  if (!slugOrId) return null;
  return lists.find((l) => l.slug === slugOrId || l.id === slugOrId) ?? null;
}
