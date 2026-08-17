import { loadConfig } from '../src/config.mjs';
import { createFinopsPool, inTransaction } from '../src/db.mjs';

const config = loadConfig();
if (config.demoMode || !config.finopsDatabaseUrl) {
  throw new Error('FINOPS_DATABASE_URL is required');
}

function databaseName(connectionString) {
  const pathname = new URL(connectionString).pathname.replace(/^\/+/, '');
  return decodeURIComponent(pathname);
}

const configuredFinopsDatabase = databaseName(config.finopsDatabaseUrl);
const configuredSourceDatabase = databaseName(config.sourceDatabaseUrl);
if (!configuredFinopsDatabase || configuredFinopsDatabase === configuredSourceDatabase) {
  throw new Error('refusing cleanup because the FinOps and Sub2API database names are not distinct');
}

const pool = createFinopsPool(config);
const schema = `"${config.finopsSchema}"`;
const cleanupTargets = [
  'revenue_recognition',
  'usage_cost_reprice_queue',
  'fact_usage_cost_snapshots',
  'fact_usage_daily',
  'fact_usage_events',
  'credit_lots',
  'wallet_reconciliation_snapshots',
];

async function counts(client) {
  const countsByTable = {};
  for (const table of cleanupTargets) {
    const result = await client.query(`SELECT COUNT(*)::bigint AS count FROM ${schema}."${table}"`);
    countsByTable[table] = Number(result.rows[0].count);
  }
  return countsByTable;
}

try {
  const identity = await pool.query(`
    SELECT current_database() AS database_name,current_user AS role_name,
           current_setting('transaction_read_only') AS transaction_read_only`);
  const current = identity.rows[0];
  if (current.database_name !== configuredFinopsDatabase || current.database_name === configuredSourceDatabase) {
    throw new Error(`refusing cleanup on unexpected database "${current.database_name}"`);
  }
  if (current.transaction_read_only === 'on') {
    throw new Error('FinOps database connection is read-only');
  }

  const result = await inTransaction(pool, async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`${config.finopsSchema}:clear-synced-usage`],
    );
    const before = await counts(client);
    const tables = cleanupTargets.map((table) => `${schema}."${table}"`).join(',');
    await client.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY`);
    const reconciliations = await client.query(`
      DELETE FROM ${schema}.reconciliation_runs
      WHERE reconciliation_type IN (
        'usage','usage_cny','credit_usage_cny','wallet_balance_cny','credit_reconciliation'
      )`);
    const cursors = await client.query(`
      DELETE FROM ${schema}.sync_cursors
      WHERE source_name IN ('usage_logs','credit_reconciliation')`);
    const after = await counts(client);
    return {
      database: current.database_name,
      role: current.role_name,
      schema: config.finopsSchema,
      before,
      after,
      deletedReconciliationRows: reconciliations.rowCount,
      deletedCursorRows: cursors.rowCount,
    };
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
