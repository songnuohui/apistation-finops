import { loadConfig } from '../src/config.mjs';
import { createPool } from '../src/db.mjs';
import { SyncService } from '../src/services/sync-service.mjs';

const config=loadConfig();
if(!config.databaseUrl) throw new Error('DATABASE_URL is required');
const pool=createPool(config);
try {
  const sync=new SyncService(pool,config);
  await sync.validateSourceSchema();
  console.log(await sync.runOnce());
} finally { await pool.end(); }
