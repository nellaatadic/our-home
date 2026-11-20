/** The three lists. `module` is the internal name the API uses. */
export const LISTS = [
  { module: 'grocery', slug: 'groceries', label: 'Groceries', short: 'Groceries', color: 'var(--l-grocery)', emoji: '🥕' },
  { module: 'home', slug: 'home-gadgets', label: 'Home & Gadgets', short: 'Home', color: 'var(--l-home)', emoji: '🛋️' },
  { module: 'idea', slug: 'shopping', label: 'Shopping & Other', short: 'Shopping', color: 'var(--l-idea)', emoji: '🛍️' },
] as const;

export type ListModule = (typeof LISTS)[number]['module'];

/**
 * A list as the sidebar, dashboard and list page see it: one of the three
 * built-in lists, or one the household made (module 'custom', keyed by id).
 */
export interface ListDef {
  key: string; module: 'grocery' | 'home' | 'idea' | 'custom'; id: string | null; slug: string;
  label: string; short: string; color: string; emoji: string; builtin: boolean; private: boolean; need?: number;
}

/** Soft colours offered for a new list (Paper theme). */
export const LIST_COLORS = ['#6f8a5e', '#c08a3e', '#b4687a', '#5f7f99', '#8a6fa8', '#b5562f', '#7d7466', '#4f8a83'];
export const LIST_EMOJI = ['📝', '📚', '🎁', '🎉', '✈️', '🌱', '🍷', '🧸', '🎬', '🏡', '🧺', '💡', '🛠️', '🎨', '🐾', '❤️'];

export function builtinDefs(ids: Record<string, string> = {}): ListDef[] {
  return LISTS.map((l) => ({ ...l, key: l.module, id: ids[l.module] ?? null, builtin: true, private: false }));
}

export function customDef(l: { id: string; name: string; emoji: string | null; color: string | null; private: boolean; need?: number }, i = 0): ListDef {
  return {
    key: l.id, module: 'custom', id: l.id, slug: l.id, label: l.name, short: l.name, color: l.color ?? LIST_COLORS[(i + 3) % LIST_COLORS.length],
    emoji: l.emoji ?? '📝', builtin: false, private: l.private, need: l.need,
  };
}

/** API paths for a list's items and sections. */
export function listApi(l: ListDef) {
  const custom = l.module === 'custom';
  return {
    items: (qs = '') => `/modules/${l.module}/items?${custom ? `list=${l.id}&` : ''}${qs}`,
    add: `/modules/${l.module}/items`,
    addBody: custom ? { list_id: l.id } : {},
    sections: custom ? `/lists/${l.id}/sections` : `/modules/${l.module}/categories`,
  };
}

export const listByModule = (m: string) => LISTS.find((l) => l.module === m) ?? LISTS[0];
export const listBySlug = (s: string | undefined) => LISTS.find((l) => l.slug === s) ?? null;

export const REPEAT_LABEL: Record<string, string> = { day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' };
export const EARLY_OPTIONS = [
  { value: '', label: 'None' },
  { value: '0', label: 'At time of event' },
  { value: '15', label: '15 minutes before' },
  { value: '60', label: '1 hour before' },
  { value: '1440', label: '1 day before' },
  { value: '10080', label: '1 week before' },
];

export const IMPORTANT_CATEGORIES = ['Birthday', 'Anniversary', 'Social', 'Holiday', 'Important'];

/** Card references in messages look like @[Title](item:uuid). */
export const REF_RE = /@\[([^\]\n]{1,200})\]\((item|task|event|topic|pin|list):([0-9a-f-]{36})\)/g;
