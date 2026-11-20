import { q } from '../db.js';
import { accessibleWorkspaceIds, spaceOf, type Auth } from './access.js';
import { LIST_NAMES } from './defaults.js';

/**
 * Card references inside messages look like @[Title](type:uuid). The title is
 * only a label: every reference is resolved again on the server, and only
 * records the viewer may open are returned.
 */
export const REF_TYPES = ['item', 'task', 'event', 'topic', 'pin', 'list'] as const;
export type RefType = (typeof REF_TYPES)[number];
export const REF_RE = /@\[([^\]\n]{1,200})\]\((item|task|event|topic|pin|list):([0-9a-f-]{36})\)/g;

export interface Ref { type: RefType; id: string }
export interface Card {
  type: RefType; id: string; title: string; sub: string | null; space: 'me' | 'us'; archived: boolean;
  done?: boolean; module?: string | null; list_id?: string | null; is_plan?: boolean; date?: string | null; kind?: string | null;
}

export function parseRefs(body: string): Ref[] {
  const out = new Map<string, Ref>();
  for (const m of body.matchAll(REF_RE)) out.set(`${m[2]}:${m[3]}`, { type: m[2] as RefType, id: m[3] });
  return [...out.values()];
}

/** Resolve references to cards the viewer can see, in the order given. Unknown or private-to-partner ones are dropped. */
export async function resolveCards(a: Auth, refs: Ref[]): Promise<Card[]> {
  if (!refs.length) return [];
  const wss = accessibleWorkspaceIds(a);
  const ids = (t: RefType) => refs.filter((r) => r.type === t).map((r) => r.id);
  const [items, tasks, events, topics, pins, lists] = await Promise.all([
    ids('item').length ? q<any>(
      `SELECT i.id, i.title, i.module, i.list_id, i.workspace_id, i.archived_at, i.grocery_state, l.name AS list_name
         FROM items i JOIN lists l ON l.id = i.list_id WHERE i.id = ANY($1::uuid[]) AND i.workspace_id = ANY($2::uuid[])`, [ids('item'), wss]) : [],
    ids('task').length ? q<any>('SELECT id, title, status, due_date, workspace_id, archived_at FROM tasks WHERE id = ANY($1::uuid[]) AND workspace_id = ANY($2::uuid[])', [ids('task'), wss]) : [],
    ids('event').length ? q<any>(`SELECT id, title, start_date::text AS start_date, is_plan, workspace_id, archived_at FROM events WHERE id = ANY($1::uuid[]) AND workspace_id = ANY($2::uuid[])`, [ids('event'), wss]) : [],
    ids('topic').length ? q<any>('SELECT id, title, workspace_id, archived_at FROM topics WHERE id = ANY($1::uuid[]) AND workspace_id = ANY($2::uuid[]) AND NOT is_general', [ids('topic'), wss]) : [],
    ids('pin').length ? q<any>('SELECT id, title, kind, workspace_id, archived_at FROM pins WHERE id = ANY($1::uuid[]) AND workspace_id = ANY($2::uuid[])', [ids('pin'), wss]) : [],
    ids('list').length ? q<any>('SELECT id, name, module, event_id, is_default, workspace_id, archived_at FROM lists WHERE id = ANY($1::uuid[]) AND workspace_id = ANY($2::uuid[])', [ids('list'), wss]) : [],
  ]);
  const found = new Map<string, Card>();
  const base = (type: RefType, r: any) => ({ type, id: r.id, space: spaceOf(a, r.workspace_id), archived: Boolean(r.archived_at) });
  for (const r of items) {
    found.set(`item:${r.id}`, {
      ...base('item', r), title: r.title, module: r.module, list_id: r.list_id, done: r.grocery_state === 'stock',
      sub: r.module === 'custom' ? r.list_name : LIST_NAMES[r.module as keyof typeof LIST_NAMES] ?? null,
    });
  }
  for (const r of tasks) found.set(`task:${r.id}`, { ...base('task', r), title: r.title, sub: 'To-do', done: r.status === 'completed', date: r.due_date });
  for (const r of events) found.set(`event:${r.id}`, { ...base('event', r), title: r.title, sub: r.is_plan ? 'Plan' : 'Event', is_plan: r.is_plan, date: r.start_date });
  for (const r of topics) found.set(`topic:${r.id}`, { ...base('topic', r), title: r.title, sub: 'Topic' });
  for (const r of pins) found.set(`pin:${r.id}`, { ...base('pin', r), title: r.title, sub: 'Board', kind: r.kind });
  for (const r of lists) {
    found.set(`list:${r.id}`, {
      ...base('list', r), title: r.module === 'custom' ? r.name : LIST_NAMES[r.module as keyof typeof LIST_NAMES], module: r.module, list_id: r.id,
      sub: r.event_id ? 'Plan list' : 'List',
    });
  }
  return refs.map((r) => found.get(`${r.type}:${r.id}`)).filter((x): x is Card => Boolean(x));
}
