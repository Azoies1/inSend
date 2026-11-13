import pg from 'pg';

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 3000 });
}

export async function pingDb(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1');
}
