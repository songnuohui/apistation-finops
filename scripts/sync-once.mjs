import { loadConfig } from '../src/config.mjs';
import { assertDistinctDatabases, createFinopsPool, createSourcePool } from '../src/db.mjs';
import { SyncService } from '../src/services/sync-service.mjs';

const config=loadConfig();
if(config.demoMode) throw new Error('SOURCE_DATABASE_URL and FINOPS_DATABASE_URL are required');
const sourcePool=createSourcePool(config);
const finopsPool=createFinopsPool(config);
try {
  await assertDistinctDatabases(sourcePool,finopsPool);
  const sync=new SyncService(sourcePool,finopsPool,config);
  await sync.validateSourceSchema();
  console.log(await sync.runOnce());
} finally { await Promise.all([sourcePool.end(),finopsPool.end()]); }
