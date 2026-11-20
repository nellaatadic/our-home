import { q, q1, type Queryable } from '../db.js';
import { HttpError, notFound } from './http.js';

export interface Person {
  id: string;
  display_name: string;
  email: string;
  role: 'primary' | 'partner';
}

export interface Auth {
  user: { id: string; email: string; display_name: string };
  sessionId: string;
  household: { id: string; name: string; timezone: string; currency: string; auto_move_to_stock: boolean };
  role: 'primary' | 'partner';
  personalWorkspaceId: string;
  sharedWorkspaceId: string;
  partner: Person | null;
  members: Person[];
}

export type AppEnv = { Variables: { auth: Auth | null; requestId: string } };

/** Workspaces this user may read or write: their own personal space and the household's US space. */
export function accessibleWorkspaceIds(auth: Auth): string[] {
  return [auth.personalWorkspaceId, auth.sharedWorkspaceId];
}

export function canAccessWorkspace(auth: Auth, workspaceId: string): boolean {
  return workspaceId === auth.personalWorkspaceId || workspaceId === auth.sharedWorkspaceId;
}

export function assertWorkspace(auth: Auth, workspaceId: string) {
  // 404 rather than 403 so private records are indistinguishable from missing ones.
  if (!canAccessWorkspace(auth, workspaceId)) throw notFound();
}

export function workspaceFor(auth: Auth, space: 'me' | 'us'): string {
  return space === 'us' ? auth.sharedWorkspaceId : auth.personalWorkspaceId;
}

export function spaceOf(auth: Auth, workspaceId: string): 'me' | 'us' {
  return workspaceId === auth.sharedWorkspaceId ? 'us' : 'me';
}

export const ENTITY_TABLES = {
  item: 'items',
  task: 'tasks',
  event: 'events',
  inventory: 'inventory_items',
  expense: 'expenses',
  receipt: 'receipts',
  topic: 'topics',
  pin: 'pins',
  list: 'lists',
} as const;
export type EntityType = keyof typeof ENTITY_TABLES;
export const THREAD_ENTITY_TYPES = ['item', 'task', 'event', 'inventory', 'expense', 'topic', 'pin', 'list'] as const;
export type ThreadEntityType = (typeof THREAD_ENTITY_TYPES)[number];

export function isEntityType(t: string): t is EntityType {
  return Object.prototype.hasOwnProperty.call(ENTITY_TABLES, t);
}

/**
 * Load an entity row only if the current user may access it. The workspace
 * filter is part of the SQL itself, so an unauthorized id behaves as missing.
 */
export async function loadEntity<T = any>(auth: Auth, type: EntityType, id: string, db?: Queryable): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
  const table = ENTITY_TABLES[type];
  const sql = `SELECT * FROM ${table} WHERE id = $1 AND workspace_id = ANY($2::uuid[])`;
  const row = db ? (await db.query<T>(sql, [id, accessibleWorkspaceIds(auth)])).rows[0] : await q1<T>(sql, [id, accessibleWorkspaceIds(auth)]);
  if (!row) throw notFound();
  return row;
}

/** Users (ids) who can see a workspace — used to scope notifications and mentions. */
export async function workspaceAudience(workspaceId: string): Promise<string[]> {
  const ws = await q1<{ kind: string; owner_user_id: string | null; household_id: string }>(
    'SELECT kind, owner_user_id, household_id FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  if (!ws) return [];
  if (ws.kind === 'personal') return [ws.owner_user_id!];
  const rows = await q<{ user_id: string }>('SELECT user_id FROM household_members WHERE household_id = $1', [ws.household_id]);
  return rows.map((r) => r.user_id);
}

export function assertMember(auth: Auth, userId: string | null | undefined) {
  if (!userId) return;
  if (!auth.members.some((m) => m.id === userId)) throw new HttpError(400, 'bad_request', 'That person is not in your household');
}
