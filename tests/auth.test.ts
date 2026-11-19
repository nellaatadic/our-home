import { beforeAll, describe, expect, it } from 'vitest';
import { Client, household, resetDb } from './helpers.js';
import { listMigrations, migrate } from '../server/migrate.js';
import { q } from '../server/db.js';

beforeAll(resetDb);

describe('migrations', () => {
  it('applies all migrations and is idempotent', async () => {
    const files = await listMigrations();
    expect(files.length).toBeGreaterThan(0);
    await migrate(); // second run is a no-op
    const applied = await q('SELECT name FROM _local_migrations');
    expect(applied.length).toBe(files.length);
  });

  it('creates the core relational tables with constraints', async () => {
    const tables = (await q<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).map((t) => t.table_name);
    for (const t of ['users', 'households', 'household_members', 'workspaces', 'items', 'lists', 'categories', 'tags', 'events', 'tasks', 'threads', 'messages',
      'mentions', 'notifications', 'attachments', 'receipts', 'receipt_lines', 'expenses', 'inventory_items', 'activity', 'google_connections', 'google_calendars', 'event_exports']) {
      expect(tables).toContain(t);
    }
    // personal workspaces must have an owner, shared ones must not
    const [h] = await q<{ id: string }>(`INSERT INTO households (name) VALUES ('constraint test') RETURNING id`);
    await expect(q(`INSERT INTO workspaces (household_id, kind) VALUES ($1, 'personal')`, [h.id])).rejects.toThrow();
    await expect(q(`INSERT INTO workspaces (household_id, kind) VALUES ($1, 'shared')`, [h.id])).resolves.toBeDefined();
    await expect(q(`INSERT INTO workspaces (household_id, kind) VALUES ($1, 'shared')`, [h.id])).rejects.toThrow(); // one US per household
  });
});

describe('authentication & household membership', () => {
  it('registers the primary user with a household, personal and shared space', async () => {
    const { me } = await household({ partner: false });
    const info = await me.ok('GET', '/auth/me');
    expect(info.role).toBe('primary');
    expect(info.household.timezone).toBe('Europe/Budapest');
    expect(info.partner).toBeNull();
    const lists = await me.ok('GET', '/spaces/us/lists?module=grocery');
    expect(lists.lists).toHaveLength(1);
  });

  it('invites the partner, who gets their own login and private space', async () => {
    const { me, you } = await household();
    const a = await me.ok('GET', '/auth/me');
    const b = await you.ok('GET', '/auth/me');
    expect(b.role).toBe('partner');
    expect(b.household.id).toBe(a.household.id);
    expect(a.partner.display_name).toBe('Zsolt');
  });

  it('rejects wrong passwords, short passwords, reused or invalid invites, and a third member', async () => {
    const { me } = await household();
    const anon = new Client();
    expect((await anon.post('/auth/login', { email: 'nobody@example.test', password: 'x' })).status).toBe(401);
    expect((await anon.post('/auth/register', { email: 'short@example.test', password: 'short', display_name: 'S' })).status).toBe(400);
    expect((await anon.post('/auth/register', { email: 'bad@example.test', password: 'long enough password', display_name: 'B', invite_token: 'nope' })).status).toBe(400);
    expect((await me.post('/household/invitations', {})).status).toBe(400); // household full
  });

  it('logs in and out with an HttpOnly session cookie', async () => {
    const { me } = await household({ partner: false });
    const email = (await me.ok('GET', '/auth/me')).user.email;
    const c = new Client();
    const r = await c.req('POST', '/auth/login', { email, password: 'correct horse battery' });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    await c.ok('POST', '/auth/logout');
    expect((await c.get('/spaces/me/lists')).status).toBe(401);
  });

  it('requires the CSRF header and same-origin for mutations', async () => {
    const { me } = await household({ partner: false });
    const noHeader = await me.req('POST', '/spaces/me/items', { module: 'grocery', title: 'x' }, { 'x-ourhome': '' });
    expect(noHeader.status).toBe(403);
    const cross = await me.req('POST', '/spaces/me/items', { module: 'grocery', title: 'x' }, { origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
  });

  it('rate-limits repeated failed logins', async () => {
    const c = new Client();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await c.post('/auth/login', { email: 'victim@example.test', password: 'guess' + i })).status;
    expect(last).toBe(429);
  });

  it('first-user-only signup mode closes open registration once someone exists', async () => {
    process.env.SIGNUP_MODE = 'first-user-only';
    try {
      const r = await new Client().post('/auth/register', { email: 'stranger@example.test', password: 'long enough password', display_name: 'S' });
      expect(r.status).toBe(403);
    } finally {
      process.env.SIGNUP_MODE = 'open';
    }
  });
});
