import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { assertDistinctDatabases, createFinopsPool, createSourcePool } from './db.mjs';
import {
  authorize,
  clearPendingLoginCookie,
  clearSessionCookie,
  pendingLoginCookie,
  pendingLoginId,
  sessionCookie,
} from './auth.mjs';
import { accountScope, resolveRange, pagination, searchTerm } from './http/query.mjs';
import {
  normalizeAccountCostPeriod, normalizeAccountCostPeriodUpdate, normalizeAccountLedger,
  normalizeBulkAccountCostPeriods, normalizeCashTransaction, normalizeCostProfile, normalizeMonitorGroup,
} from './http/validation.mjs';
import { resolveStaticPath } from './http/static-path.mjs';
import { DemoRepository } from './repositories/demo-repository.mjs';
import { PostgresRepository } from './repositories/postgres-repository.mjs';
import { PendingLoginStore } from './services/pending-login-store.mjs';
import {
  completeSub2ApiAdministratorTwoFactor,
  loginSub2ApiAdministrator,
  Sub2ApiAuthError,
} from './services/sub2api-auth-service.mjs';
import { SyncService } from './services/sync-service.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const webRoot=path.join(root,'web');
const config=loadConfig();
const sourcePool=createSourcePool(config);
const finopsPool=createFinopsPool(config);
const repository=config.demoMode?new DemoRepository(config):new PostgresRepository(finopsPool,config);
const syncService=config.demoMode?null:new SyncService(sourcePool,finopsPool,config);
const pendingLogins=new PendingLoginStore();

const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.ico':'image/x-icon'};
function setHeaders(res,{embeddable=false}={}){
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','same-origin');
  if(embeddable){
    const ancestors=["'self'",...config.monitorEmbedOrigins].join(' ');
    res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors ${ancestors}; base-uri 'self'; form-action 'self'`);
  }else{
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  }
}
function json(res,status,data){setHeaders(res);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(request){
  let size=0;const chunks=[];
  for await(const chunk of request){size+=chunk.length;if(size>1_048_576)throw Object.assign(new Error('request body too large'),{statusCode:413});chunks.push(chunk);}
  if(!chunks.length)return {};
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Object.assign(new Error('invalid JSON body'),{statusCode:400});}
}
function redirect(res,location){setHeaders(res);res.writeHead(302,{Location:location,'Cache-Control':'no-store'});res.end();}
function clientIp(request){
  const forwarded=request.headers['x-forwarded-for'];
  if(typeof forwarded==='string'&&forwarded.trim())return forwarded.split(',')[0].trim();
  return request.socket.remoteAddress||'';
}
function loginPayload(value){
  const email=String(value.email||'').trim().toLowerCase();
  const password=String(value.password||'');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!password)return null;
  return {email,password};
}
function totpCode(value){
  const code=String(value.totpCode||'').replace(/\s+/g,'');
  return /^\d{6}$/.test(code)?code:'';
}
function authFailure(error){
  if(error instanceof Sub2ApiAuthError){
    return {status:error.statusCode,error:error.code==='admin_required'?'admin access required':error.code==='upstream_unavailable'?'authentication service unavailable':'invalid administrator credentials'};
  }
  return {status:500,error:'internal server error'};
}
function routeId(pathname,prefix){
  const raw=pathname.slice(prefix.length);
  if(!/^\d+$/.test(raw))return null;
  const id=Number(raw);
  return Number.isSafeInteger(id)&&id>0?id:null;
}
function detailPagination(searchParams,prefix){
  const params=new URLSearchParams({
    page:searchParams.get(`${prefix}_page`)||'1',
    page_size:searchParams.get('detail_page_size')||'10',
  });
  return pagination(params);
}
function userSort(searchParams){
  const sort=searchParams.get('sort')||'userChargeCny';
  const direction=searchParams.get('direction')||'desc';
  const allowed=new Set([
    'cashPaidCny','adminCreditCny','adminDeductionCny','balanceCny',
    'userChargeCny','requests','tokens','bookedCostCny','bookedProfitCny',
  ]);
  if(!allowed.has(sort))throw Object.assign(new Error('invalid sort'),{statusCode:400});
  if(!['asc','desc'].includes(direction))throw Object.assign(new Error('invalid sort direction'),{statusCode:400});
  return {sort,direction};
}
async function login(request,res){
  const credentials=loginPayload(await body(request));
  if(!credentials)return json(res,400,{error:'email and password are required'});
  try{
    const result=await loginSub2ApiAdministrator({...credentials,clientIp:clientIp(request)},config);
    if(result.requiresTwoFactor){
      const id=pendingLogins.create(result.tempToken);
      res.setHeader('Set-Cookie',[clearPendingLoginCookie(config),pendingLoginCookie(id,config)]);
      return json(res,200,{requiresTwoFactor:true,emailMasked:result.emailMasked});
    }
    res.setHeader('Set-Cookie',[clearPendingLoginCookie(config),sessionCookie(result.user,config)]);
    return json(res,200,{ok:true,user:result.user});
  }catch(error){
    const failure=authFailure(error);
    return json(res,failure.status,{error:failure.error});
  }
}
async function loginTwoFactor(request,res){
  const pending=pendingLogins.get(pendingLoginId(request));
  const code=totpCode(await body(request));
  if(!pending||!code)return json(res,400,{error:'two-factor login session or verification code is invalid'});
  try{
    const user=await completeSub2ApiAdministratorTwoFactor({tempToken:pending.tempToken,totpCode:code,clientIp:clientIp(request)},config);
    pendingLogins.delete(pendingLoginId(request));
    res.setHeader('Set-Cookie',[clearPendingLoginCookie(config),sessionCookie(user,config)]);
    return json(res,200,{ok:true,user});
  }catch(error){
    const failure=authFailure(error);
    return json(res,failure.status,{error:failure.error});
  }
}
async function api(request,res,url){
  const auth=authorize(request,config);if(!auth.ok)return json(res,401,{error:'unauthorized'});
  const range=()=>resolveRange(url.searchParams,new Date(),config.timezone),page=()=>pagination(url.searchParams);
  if(request.method==='GET'&&url.pathname==='/api/bootstrap')return json(res,200,await repository.getBootstrap());
  if(request.method==='GET'&&url.pathname==='/api/summary')return json(res,200,await repository.getSummary(range()));
  if(request.method==='GET'&&url.pathname==='/api/trend')return json(res,200,await repository.getTrend(range()));
  if(request.method==='GET'&&url.pathname==='/api/usage/models')return json(res,200,await repository.getUsageBreakdown({...range(),...page()}));
  const userDetails=/^\/api\/users\/(\d+)\/details$/.exec(url.pathname);
  if(request.method==='GET'&&userDetails){
    const userId=Number(userDetails[1]);
    return json(res,200,await repository.getUserDetails({
      ...range(),userId,recharge:detailPagination(url.searchParams,'recharge'),
      usage:detailPagination(url.searchParams,'usage'),
    }));
  }
  if(request.method==='GET'&&url.pathname==='/api/users'){
    return json(res,200,await repository.listUsers({
      ...range(),...page(),...userSort(url.searchParams),search:searchTerm(url.searchParams),
    }));
  }
  const accountCostHistory=/^\/api\/accounts\/(\d+)\/cost-periods$/.exec(url.pathname);
  if(request.method==='GET'&&accountCostHistory){
    return json(res,200,await repository.listAccountCostPeriods({
      accountId:Number(accountCostHistory[1]),...page(),
    }));
  }
  if(request.method==='GET'&&url.pathname==='/api/accounts')return json(res,200,await repository.listAccounts({
    ...range(),...page(),search:searchTerm(url.searchParams),scope:accountScope(url.searchParams),
  }));
  if(request.method==='GET'&&url.pathname==='/api/suppliers')return json(res,200,await repository.getSupplierOverview({...range(),search:searchTerm(url.searchParams)}));
  if(request.method==='GET'&&url.pathname==='/api/funds')return json(res,200,await repository.listCashTransactions({...range(),...page(),search:searchTerm(url.searchParams)}));
  if(request.method==='GET'&&url.pathname==='/api/reconciliation')return json(res,200,await repository.getReconciliation(range()));
  if(request.method==='GET'&&url.pathname==='/api/cost-profiles')return json(res,200,await repository.listCostProfiles());
  if(request.method==='GET'&&url.pathname==='/api/sync-state')return json(res,200,await repository.getSyncState());
  if(request.method==='GET'&&url.pathname==='/api/sync-details')return json(res,200,await repository.getSyncDetails());
  if(request.method==='GET'&&url.pathname==='/api/monitor-groups')return json(res,200,await repository.listMonitorGroups());
  if(request.method==='GET'&&url.pathname==='/api/monitor-group-candidates')return json(res,200,await repository.listMonitorGroupCandidates());
  if(request.method==='POST'&&url.pathname==='/api/monitor-groups'){
    return json(res,201,await repository.createMonitorGroup(normalizeMonitorGroup(await body(request)),auth.actor));
  }
  const monitorGroupId=routeId(url.pathname,'/api/monitor-groups/');
  if(request.method==='PATCH'&&monitorGroupId){
    return json(res,200,await repository.updateMonitorGroup(monitorGroupId,normalizeMonitorGroup(await body(request)),auth.actor));
  }
  if(request.method==='POST'&&url.pathname==='/api/cost-profiles'){
    return json(res,201,await repository.createCostProfile(normalizeCostProfile(await body(request)),auth.actor));
  }
  if(request.method==='POST'&&url.pathname==='/api/account-cost-periods'){
    return json(res,201,await repository.createAccountCostPeriod(normalizeAccountCostPeriod(await body(request)),auth.actor));
  }
  if(request.method==='POST'&&url.pathname==='/api/account-cost-periods/bulk'){
    return json(res,201,await repository.createBulkAccountCostPeriods(normalizeBulkAccountCostPeriods(await body(request)),auth.actor));
  }
  const accountId=routeId(url.pathname,'/api/accounts/');
  if(request.method==='PATCH'&&accountId)return json(res,200,await repository.updateAccountLedger(accountId,normalizeAccountLedger(await body(request)),auth.actor));
  const periodId=routeId(url.pathname,'/api/account-cost-periods/');
  if(request.method==='PATCH'&&periodId){
    return json(res,200,await repository.updateAccountCostPeriod(periodId,normalizeAccountCostPeriodUpdate(await body(request)),auth.actor));
  }
  if(request.method==='POST'&&url.pathname==='/api/cash-transactions')return json(res,201,await repository.createCashTransaction(normalizeCashTransaction(await body(request)),auth.actor));
  return json(res,404,{error:'API endpoint not found'});
}

async function publicMonitorApi(res){
  return json(res,200,await repository.getPublicMonitorDashboard());
}

async function staticFile(res,url,{embeddable=false}={}){
  const candidate=resolveStaticPath(webRoot,url.pathname);
  try{const content=await fs.readFile(candidate);setHeaders(res,{embeddable});const extension=path.extname(candidate).toLowerCase();const revalidate=['.html','.css','.js'].includes(extension);res.writeHead(200,{'Content-Type':types[extension]||'application/octet-stream','Cache-Control':revalidate?'no-cache':'public, max-age=86400'});res.end(content);}catch(error){if(error.code==='ENOENT')return json(res,404,{error:'not found'});throw error;}
}

async function readiness(){
  if(config.demoMode)return {status:'ready',mode:'demo'};
  await Promise.all([sourcePool.query('SELECT 1'),finopsPool.query('SELECT 1')]);
  const migration=await finopsPool.query(
    `SELECT version FROM "${config.finopsSchema}".schema_migrations
     WHERE version = ANY($1::text[])`,
    [['002_cny_accounting', '003_reconciliation_snapshots', '004_cost_accounting_v2', '005_cost_snapshot_ledger', '006_group_monitoring']],
  );
  if(migration.rowCount < 5)throw new Error('required FinOps migrations 002_cny_accounting through 006_group_monitoring are not applied');
  const sync=await repository.getSyncState();
  return {
    status:'ready',
    mode:'database',
     migrations:['002_cny_accounting','003_reconciliation_snapshots','004_cost_accounting_v2','005_cost_snapshot_ledger','006_group_monitoring'],
    syncStatus:sync.status,
    lastSuccessAt:sync.lastSuccessAt,
  };
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
    if(request.method==='POST'&&url.pathname==='/auth/login')return await login(request,res);
    if(request.method==='POST'&&url.pathname==='/auth/login/2fa')return await loginTwoFactor(request,res);
    if(request.method==='POST'&&url.pathname==='/auth/logout'){
      res.setHeader('Set-Cookie',[clearPendingLoginCookie(config),clearSessionCookie(config)]);
      return json(res,200,{ok:true});
    }
    if(request.method==='GET'&&url.pathname==='/auth/session'){
      const auth=authorize(request,config);
      return auth.ok?json(res,200,{user:auth.user}):json(res,401,{error:'unauthorized'});
    }
    if(request.method==='GET'&&url.pathname==='/monitor'){
      return staticFile(res,{pathname:'/monitor.html'},{embeddable:true});
    }
    if(request.method==='GET'&&url.pathname==='/api/public/group-monitor'){
      return publicMonitorApi(res);
    }
    if(request.method==='GET'&&url.pathname==='/login'){
      return authorize(request,config).ok?redirect(res,'/'):staticFile(res,{pathname:'/login.html'});
    }
    if(url.pathname.startsWith('/api/'))return await api(request,res,url);
    if((url.pathname==='/'||!path.extname(url.pathname))&&!authorize(request,config).ok)return redirect(res,'/login');
    return await staticFile(res,url);
  }catch(error){console.error('[request]',error);if(!res.headersSent)json(res,error.statusCode||500,{error:error.statusCode?error.message:'internal server error'});else res.end();}
  finally{if(config.nodeEnv==='development')console.info(`[http] ${request.method} ${request.url} ${res.statusCode} ${Date.now()-started}ms`);}
});

async function start(){
  if(!config.demoMode)await assertDistinctDatabases(sourcePool,finopsPool);
  if(syncService&&config.syncEnabled){await syncService.validateSourceSchema();syncService.start();}
  server.listen(config.port,config.host,()=>console.log(`ApiStation FinOps listening on http://${config.host}:${config.port} (${config.demoMode?'demo':'database'} mode)`));
}
async function shutdown(signal){console.log(`${signal}: shutting down`);syncService?.stop();server.close(async()=>{await Promise.all([sourcePool?.end(),finopsPool?.end()]);process.exit(0);});setTimeout(()=>process.exit(1),10_000).unref();}
process.on('SIGINT',()=>shutdown('SIGINT'));process.on('SIGTERM',()=>shutdown('SIGTERM'));
await start();
