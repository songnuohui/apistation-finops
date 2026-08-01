import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { assertDistinctDatabases, createFinopsPool, createSourcePool, inTransaction } from '../src/db.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig();
if (config.demoMode) throw new Error('SOURCE_DATABASE_URL and FINOPS_DATABASE_URL are required for migrations');
const sourcePool = createSourcePool(config);
const pool = createFinopsPool(config);

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

try {
  await assertDistinctDatabases(sourcePool, pool);
  const schema = await pool.query(
    'SELECT 1 FROM pg_namespace WHERE nspname = $1',
    [config.finopsSchema],
  );
  if (!schema.rowCount) {
    throw new Error(`FinOps schema "${config.finopsSchema}" does not exist; create it with an administrator-owned deployment grant before running migrations`);
  }
  const files = (await fs.readdir(path.join(root, 'migrations'))).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    const version = path.basename(file, '.sql');
    const raw = await fs.readFile(path.join(root, 'migrations', file), 'utf8');
    const sql = raw
      .replaceAll('{{FINOPS_SCHEMA}}', `"${config.finopsSchema}"`)
      .replaceAll('{{FINOPS_TIMEZONE}}', sqlLiteral(config.timezone));
    await inTransaction(pool, async (client) => {
      await client.query(`CREATE TABLE IF NOT EXISTS "${config.finopsSchema}".schema_migrations (version VARCHAR(64) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
      const existing = await client.query(`SELECT 1 FROM "${config.finopsSchema}".schema_migrations WHERE version = $1`, [version]);
      if (existing.rowCount) return;
      if (version === '002_cny_accounting') {
        const legacy = await client.query(
          `SELECT 1 FROM "${config.finopsSchema}".schema_migrations WHERE version='002_dual_ledger'`,
        );
        if (legacy.rowCount) {
          throw new Error('legacy migration 002_dual_ledger is already applied; stop and manually inspect or rebuild the FinOps schema before using 002_cny_accounting. Automatic USD Credit to CNY relabeling is prohibited.');
        }
        const populated = await client.query(`
          SELECT
            EXISTS(SELECT 1 FROM "${config.finopsSchema}".fact_usage_events) AS usage_events,
            EXISTS(SELECT 1 FROM "${config.finopsSchema}".fact_usage_daily) AS usage_daily,
            EXISTS(SELECT 1 FROM "${config.finopsSchema}".cash_transactions) AS cash_transactions`);
        if (Object.values(populated.rows[0]).some(Boolean)) {
          throw new Error('existing FinOps ledger rows were found before 002_cny_accounting; stop and rebuild or perform a reviewed controlled backfill. This migration never infers CNY values from historical fields.');
        }
      }
      await client.query(sql);
      await client.query(`INSERT INTO "${config.finopsSchema}".schema_migrations(version) VALUES ($1)`, [version]);
      console.log(`applied ${file}`);
    });
  }
} finally {
  await Promise.all([sourcePool.end(), pool.end()]);
}
