/** The three lists. `module` is the internal name the API uses. */
export const LISTS = [
  { module: 'grocery', slug: 'groceries', label: 'Groceries', short: 'Groceries', color: 'var(--l-grocery)', emoji: '🥕' },
  { module: 'home', slug: 'home-gadgets', label: 'Home & Gadgets', short: 'Home', color: 'var(--l-home)', emoji: '🛋️' },
  { module: 'idea', slug: 'shopping', label: 'Shopping & Other', short: 'Shopping', color: 'var(--l-idea)', emoji: '🛍️' },
] as const;

export type ListModule = (typeof LISTS)[number]['module'];

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
export const REF_RE = /@\[([^\]\n]{1,200})\]\((item|task|event|topic):([0-9a-f-]{36})\)/g;
