import pg from 'pg';

const { Pool } = pg;

export function createPool(config) {
  if (!config.databaseUrl) return null;
  return new Pool({
    connectionString: config.databaseUrl,
    max: 5,
    min: 0,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: 'apistation-finops',
  });
}

export async function inTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
