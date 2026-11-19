import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getPool } from './db.js';

/**
 * Local / test migration runner. On Netlify, migrations in
 * netlify/database/migrations are applied automatically during deploy, so this
 * runner is only used for local Postgres and the test suite. It applies the
 * same files in the same (lexicographic) order and refuses to run if an applied
 * migration was edited afterwards.
 */
export const MIGRATIONS_DIR = path.resolve(process.cwd(), 'netlify/database/migrations');

export async function listMigrations(dir = MIGRATIONS_DIR) {
  const entries = (await readdir(dir)).sort();
  const out: { name: string; sql: string; checksum: string }[] = [];
  for (const e of entries) {
    const full = path.join(dir, e);
    const s = await stat(full);
    let file: string | null = null;
    if (s.isDirectory()) file = path.join(full, 'migration.sql');
    else if (e.endsWith('.sql')) file = full;
    if (!file) continue;
    const sql = await readFile(file, 'utf8');
    out.push({ name: e.replace(/\.sql$/, ''), sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return out;
}

export async function migrate(dir = MIGRATIONS_DIR, log: (m: string) => void = () => {}) {
  const pool = await getPool();
  await pool.query(`CREATE TABLE IF NOT EXISTS _local_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Map(
    (await pool.query<{ name: string; checksum: string }>('SELECT name, checksum FROM _local_migrations')).rows.map((r) => [r.name, r.checksum]),
  );
  const migrations = await listMigrations(dir);
  for (const m of migrations) {
    const prev = applied.get(m.name);
    if (prev) {
      if (prev !== m.checksum) throw new Error(`Migration ${m.name} was modified after it was applied. Create a new migration instead.`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query('INSERT INTO _local_migrations (name, checksum) VALUES ($1, $2)', [m.name, m.checksum]);
      await client.query('COMMIT');
      log(`applied ${m.name}`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${m.name} failed: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }
  return migrations.length;
}
