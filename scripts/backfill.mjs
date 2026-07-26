import { loadConfig } from '../src/config.mjs';
import { createPool } from '../src/db.mjs';
import { SyncService } from '../src/services/sync-service.mjs';

function positiveInteger(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`invalid positive integer: ${value}`);
  return parsed;
}

const config = loadConfig();
if (!config.databaseUrl) throw new Error('DATABASE_URL is required for historical backfill');

const maxCycles = positiveInteger(process.env.BACKFILL_MAX_CYCLES, 100_000);
const pool = createPool(config);
const sync = new SyncService(pool, config);
let stopping = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    console.log(`${signal}: stopping after the current transaction; cursors are preserved`);
  });
}

try {
  await sync.validateSourceSchema();
  for (let cycle = 1; cycle <= maxCycles && !stopping; cycle += 1) {
    const result = await sync.runOnce();
    const rows = [
      result.usageRows, result.paymentRows, result.redeemRows, result.affiliateRows,
      result.auditRows, result.subscriptionRows,
    ].reduce((sum, value) => sum + Number(value || 0), 0);
    console.log(JSON.stringify({ cycle, rows, durationMs: result.durationMs }));
    if (rows === 0) {
      console.log('historical backfill is complete');
      break;
    }
    if (cycle === maxCycles) throw new Error(`BACKFILL_MAX_CYCLES reached: ${maxCycles}`);
  }
} finally {
  await pool.end();
}
