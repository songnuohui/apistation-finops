import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { createPool } from './db.mjs';
import { authorize } from './auth.mjs';
import { resolveRange, pagination, searchTerm } from './http/query.mjs';
import { normalizeAccountCostPeriod, normalizeCashTransaction, normalizeCostProfile } from './http/validation.mjs';
import { resolveStaticPath } from './http/static-path.mjs';
import { DemoRepository } from './repositories/demo-repository.mjs';
import { PostgresRepository } from './repositories/postgres-repository.mjs';
import { SyncService } from './services/sync-service.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const webRoot=path.join(root,'web');
const config=loadConfig();
const pool=createPool(config);
const repository=config.demoMode?new DemoRepository(config):new PostgresRepository(pool,config);
const syncService=config.demoMode?null:new SyncService(pool,config);

const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.ico':'image/x-icon'};
function setHeaders(res){
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}
function json(res,status,data){setHeaders(res);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(request){
  let size=0;const chunks=[];
  for await(const chunk of request){size+=chunk.length;if(size>1_048_576)throw Object.assign(new Error('request body too large'),{statusCode:413});chunks.push(chunk);}
  if(!chunks.length)return {};
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(new Error('invalid JSON body'),{statusCode:400});}
}
async function api(request,res,url){
  const auth=authorize(request,config);if(!auth.ok)return json(res,401,{error:'unauthorized'});
  const range=()=>resolveRange(url.searchParams,new Date(),config.timezone),page=()=>pagination(url.searchParams);
  if(request.method==='GET'&&url.pathname==='/api/bootstrap')return json(res,200,await repository.getBootstrap());
  if(request.method==='GET'&&url.pathname==='/api/summary')return json(res,200,await repository.getSummary(range()));
  if(request.method==='GET'&&url.pathname==='/api/trend')return json(res,200,await repository.getTrend(range()));
  if(request.method==='GET'&&url.pathname==='/api/usage/models')return json(res,200,await repository.getUsageBreakdown(range()));
  if(request.method==='GET'&&url.pathname==='/api/users')return json(res,200,await repository.listUsers({...range(),...page(),search:searchTerm(url.searchParams)}));
  if(request.method==='GET'&&url.pathname==='/api/accounts')return json(res,200,await repository.listAccounts({...range(),...page(),search:searchTerm(url.searchParams)}));
  if(request.method==='GET'&&url.pathname==='/api/suppliers')return json(res,200,await repository.getSupplierOverview({...range(),search:searchTerm(url.searchParams)}));
  if(request.method==='GET'&&url.pathname==='/api/funds')return json(res,200,await repository.listCashTransactions({...range(),...page(),search:searchTerm(url.searchParams)}));
  if(request.method==='GET'&&url.pathname==='/api/reconciliation')return json(res,200,await repository.getReconciliation(range()));
  if(request.method==='GET'&&url.pathname==='/api/cost-profiles')return json(res,200,await repository.listCostProfiles());
  if(request.method==='GET'&&url.pathname==='/api/sync-state')return json(res,200,await repository.getSyncState());
  if(request.method==='GET'&&url.pathname==='/api/sync-details')return json(res,200,await repository.getSyncDetails());
  if(request.method==='POST'&&url.pathname==='/api/cost-profiles'){
    return json(res,201,await repository.createCostProfile(normalizeCostProfile(await body(request)),auth.actor));
  }
  if(request.method==='POST'&&url.pathname==='/api/account-cost-periods'){
    return json(res,201,await repository.createAccountCostPeriod(normalizeAccountCostPeriod(await body(request)),auth.actor));
  }
  if(request.method==='POST'&&url.pathname==='/api/cash-transactions')return json(res,201,await repository.createCashTransaction(normalizeCashTransaction(await body(request)),auth.actor));
  return json(res,404,{error:'API endpoint not found'});
}

async function staticFile(res,url){
  const candidate=resolveStaticPath(webRoot,url.pathname);
  try{const content=await fs.readFile(candidate);setHeaders(res);const extension=path.extname(candidate).toLowerCase();const revalidate=['.html','.css','.js'].includes(extension);res.writeHead(200,{'Content-Type':types[extension]||'application/octet-stream','Cache-Control':revalidate?'no-cache':'public, max-age=86400'});res.end(content);}catch(error){if(error.code==='ENOENT')return json(res,404,{error:'not found'});throw error;}
}

async function readiness(){
  if(config.demoMode)return {status:'ready',mode:'demo'};
  await pool.query('SELECT 1');
  const migration=await pool.query(`SELECT 1 FROM "${config.finopsSchema}".schema_migrations WHERE version='002_cny_accounting'`);
  if(!migration.rowCount)throw new Error('required FinOps migration 002_cny_accounting is not applied');
  const sync=await repository.getSyncState();
  return {status:'ready',mode:'database',migration:'002_cny_accounting',syncStatus:sync.status,lastSuccessAt:sync.lastSuccessAt};
}

const server=http.createServer(async(request,res)=>{
  const started=Date.now();
  try{
    const url=new URL(request.url,`http://${request.headers.host||'localhost'}`);
    if(url.pathname==='/health')return json(res,200,{status:'ok',mode:config.demoMode?'demo':'database',uptimeSeconds:Math.round(process.uptime())});
    if(url.pathname==='/ready'){
      try{return json(res,200,await readiness());}
      catch(error){console.error('[ready]',error);return json(res,503,{status:'not_ready'});}
    }
    if(url.pathname.startsWith('/api/'))await api(request,res,url);else await staticFile(res,url);
  }catch(error){console.error('[request]',error);if(!res.headersSent)json(res,error.statusCode||500,{error:error.statusCode?error.message:'internal server error'});else res.end();}
  finally{if(config.nodeEnv==='development')console.info(`[http] ${request.method} ${request.url} ${res.statusCode} ${Date.now()-started}ms`);}
});

async function start(){
  if(syncService&&config.syncEnabled){await syncService.validateSourceSchema();syncService.start();}
  server.listen(config.port,config.host,()=>console.log(`ApiStation FinOps listening on http://${config.host}:${config.port} (${config.demoMode?'demo':'database'} mode)`));
}
async function shutdown(signal){console.log(`${signal}: shutting down`);syncService?.stop();server.close(async()=>{await pool?.end();process.exit(0);});setTimeout(()=>process.exit(1),10_000).unref();}
process.on('SIGINT',()=>shutdown('SIGINT'));process.on('SIGTERM',()=>shutdown('SIGTERM'));
await start();
