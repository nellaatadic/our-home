import pg from 'pg';

/**
 * Minimal database surface used by the whole server. Implemented by a pg Pool
 * locally / in tests, and by Netlify Database's pool in production.
 */
export interface Queryable {
  query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

interface PoolLike extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
  end?(): Promise<void>;
}

// DATE columns come back as 'YYYY-MM-DD' strings (no timezone shifting);
// NUMERIC as JS numbers; BIGINT (cents) as numbers (household amounts are small).
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(1700, (v: string) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v: string) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1083, (v: string) => v.slice(0, 5)); // time → 'HH:MM'

let pool: PoolLike | null = null;

async function createPool(): Promise<PoolLike> {
  const explicit = process.env.DATABASE_URL;
  if (explicit) {
    return new pg.Pool({ connectionString: explicit, max: Number(process.env.DATABASE_POOL_MAX ?? 5) }) as unknown as PoolLike;
  }
  // On Netlify, NETLIFY_DB_URL is injected; @netlify/database picks the right driver.
  const { getDatabase } = await import('@netlify/database');
  return getDatabase().pool as unknown as PoolLike;
}

export async function getPool(): Promise<PoolLike> {
  if (!pool) pool = await createPool();
  return pool;
}

/** For tests: replace the pool. */
export function setPool(p: PoolLike | null) {
  pool = p;
}

export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const p = await getPool();
  const res = await p.query<T>(text, params);
  return res.rows;
}

export async function q1<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

/** Run fn inside a transaction. Nested calls reuse the outer client. */
export async function tx<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const p = await getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool?.end) await pool.end();
  pool = null;
}
