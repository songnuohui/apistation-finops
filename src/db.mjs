import pg from 'pg';

const { Pool } = pg;

function createPool(connectionString, applicationName, max, statementTimeoutMs) {
  if (!connectionString) return null;
  return new Pool({
    connectionString,
    max,
    min: 0,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: statementTimeoutMs,
    application_name: applicationName,
  });
}

export function createSourcePool(config) {
  return createPool(
    config.sourceDatabaseUrl,
    'apistation-finops-source-reader',
    config.sourceDatabasePoolMax ?? 3,
    config.sourceStatementTimeoutMs ?? 10_000,
  );
}

export function createFinopsPool(config) {
  return createPool(
    config.finopsDatabaseUrl,
    'apistation-finops',
    config.finopsDatabasePoolMax ?? 8,
    config.finopsStatementTimeoutMs ?? 30_000,
  );
}

export async function assertDistinctDatabases(sourcePool, finopsPool) {
  const [source, finops] = await Promise.all([
    sourcePool.query('SELECT current_database() AS database_name,current_user AS role_name'),
    finopsPool.query('SELECT current_database() AS database_name,current_user AS role_name'),
  ]);
  const sourceInfo = source.rows[0];
  const finopsInfo = finops.rows[0];
  if (sourceInfo.database_name === finopsInfo.database_name) {
    throw new Error(`FinOps database isolation check failed: source and target both use "${sourceInfo.database_name}"`);
  }
  return { source: sourceInfo, finops: finopsInfo };
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
