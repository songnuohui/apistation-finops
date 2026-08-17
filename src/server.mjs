import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import {
  assertDistinctDatabases,
  createFinopsPool,
  createSourcePool,
  createSub2ApiUsagePool,
} from './db.mjs';
import {
  authorize,
  clearPendingLoginCookie,
  clearSessionCookie,
  pendingLoginCookie,
  pendingLoginId,
  sessionCookie,
} from './auth.mjs';
import {
  accountScope, cashScope, filterTerm, listSort, pagination, resolveRange, searchTerm, userBalanceScope,
} from './http/query.mjs';
import {
  normalizeAccountCostArchive, normalizeAccountCostPeriod, normalizeAccountCostPeriodUpdate, normalizeAccountCostReprice, normalizeAccountLedger,
  normalizeBulkAccountCostPeriods, normalizeBulkUserBalanceStatsWhitelist, normalizeCashTransaction, normalizeCostProfile, normalizeMonitorGroup,
  normalizeMonitorSettings, normalizeSupplierAccountLink, normalizeSupplierConnection, assertSupplierCredentials,
  hasSupplierCredentialInput, mergeSupplierCredentials,
  normalizeUserBalanceStatsWhitelist, normalizeSupplierQualityTarget, normalizeAlertNotificationSettings,
  normalizeAccountProfitGuard, normalizeSub2ApiServiceAuthSettings,
  normalizeOAuthSupplyAuthSettings,
} from './http/validation.mjs';
import { resolveStaticPath } from './http/static-path.mjs';
import { routeId } from './http/route.mjs';
import { DemoRepository } from './repositories/demo-repository.mjs';
import { PostgresRepository } from './repositories/postgres-repository.mjs';
import { PendingLoginStore } from './services/pending-login-store.mjs';
import { ResponseCacheService } from './services/response-cache-service.mjs';
import { Sub2ApiRedisRuntimeReader } from './services/sub2api-redis-runtime-reader.mjs';
import { Sub2ApiReadonlyGateway } from './services/sub2api-readonly-gateway.mjs';
import { SourceUsageService } from './services/source-usage-service.mjs';
import { AccountProfitGuardService } from './services/account-profit-guard-service.mjs';
import { SupplierDeletionService } from './services/supplier-deletion-service.mjs';
import { Sub2ApiServiceAuthService } from './services/sub2api-service-auth-service.mjs';
import { OAuthSupplyAuthService } from './services/oauth-supply-auth-service.mjs';
import { OAuthSupplyClient } from './services/oauth-supply-client.mjs';
import { Sub2ApiAccountImportGateway } from './services/sub2api-account-import-gateway.mjs';
import { ReplenishmentService } from './services/replenishment-service.mjs';
import { ReplenishmentRepository } from './repositories/replenishment-repository.mjs';
import { SourceUsageRepository } from './repositories/source-usage-repository.mjs';
import {
  completeSub2ApiAdministratorTwoFactor,
  getSub2ApiRuntimeQueueStatus,
  listSub2ApiAdministratorUserConcurrency,
  listSub2ApiChannelMonitors,
  listSub2ApiAdminGroups,
  loginSub2ApiAdministrator,
  Sub2ApiAuthError,
} from './services/sub2api-auth-service.mjs';
import { SyncService } from './services/sync-service.mjs';
import { SupplierMonitorService } from './services/supplier-monitor-service.mjs';
import { QqAlertNotificationService } from './services/qq-alert-notification-service.mjs';
import { normalizeSupplierBaseUrl } from './services/supplier-adapters.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const webRoot=path.join(root,'web');
const config=loadConfig();
const sourcePool=createSourcePool(config);
const finopsPool=createFinopsPool(config);
const sub2ApiUsagePool=createSub2ApiUsagePool(config);
const repository=config.demoMode?new DemoRepository(config):new PostgresRepository(finopsPool,config);
const syncService=config.demoMode?null:new SyncService(sourcePool,finopsPool,config);
const supplierMonitorService=config.demoMode?null:new SupplierMonitorService(repository,config);
const qqAlertNotificationService=new QqAlertNotificationService(repository,config);
const responseCache=new ResponseCacheService(config);
const sub2ApiRedisRuntimeReader=new Sub2ApiRedisRuntimeReader(config);
const sub2ApiReadonlyGateway=new Sub2ApiReadonlyGateway(config);
const sourceUsageRepository=config.demoMode?null:new SourceUsageRepository(sub2ApiUsagePool,config);
const sourceUsageService=config.demoMode?repository:new SourceUsageService(
  repository,
  sub2ApiReadonlyGateway,
  config,
  sourceUsageRepository,
);
const sub2ApiServiceAuthService=new Sub2ApiServiceAuthService(repository,config);
const oauthSupplyAuthService=new OAuthSupplyAuthService(repository,config);
const oauthSupplyClient=new OAuthSupplyClient(config);
const replenishmentRepository=new ReplenishmentRepository(config.demoMode?null:finopsPool,config);
const sub2ApiAccountImportGateway=new Sub2ApiAccountImportGateway(config);
sub2ApiAccountImportGateway.setAccessTokenProvider(sub2ApiServiceAuthService);
const replenishmentService=new ReplenishmentService(
  replenishmentRepository,
  oauthSupplyAuthService,
  sub2ApiAccountImportGateway,
  config,
  console,
  {client:oauthSupplyClient,ledgerRepository:repository},
);
replenishmentService.start();
const accountProfitGuardService=new AccountProfitGuardService(repository,sub2ApiReadonlyGateway);
const supplierDeletionService=new SupplierDeletionService(repository,sub2ApiReadonlyGateway,{demoMode:config.demoMode});
const pendingLogins=new PendingLoginStore();
supplierMonitorService?.setProfitGuardService(accountProfitGuardService);
sub2ApiReadonlyGateway.setAccessTokenProvider(sub2ApiServiceAuthService);
syncService?.setSub2ApiAccessTokenProvider(sub2ApiServiceAuthService);
syncService?.setAccountDimensionReader(() => sub2ApiReadonlyGateway.listAllAccounts({ status: '' }));
syncService?.setChannelMonitorReader(({accessToken,authHeaders})=>listSub2ApiChannelMonitors({accessToken,authHeaders},config));
syncService?.setSourceGroupCatalogReader(({accessToken,authHeaders})=>listSub2ApiAdminGroups({accessToken,authHeaders},config));
syncService?.setSourceGroupCatalogWriter((groups)=>repository.upsertSourceGroupCatalog(groups));
syncService?.setRuntimeStatusReader(({accessToken,authHeaders})=>Promise.all([
  getSub2ApiRuntimeQueueStatus({accessToken,authHeaders},config),
  listSub2ApiAdministratorUserConcurrency({accessToken,authHeaders},config),
]).then(([queue, users])=>({queue,users})));
syncService?.setRuntimeConcurrencyReader(()=>sub2ApiRedisRuntimeReader.listRuntimeConcurrency());
syncService?.setReadCacheInvalidator(()=>responseCache.invalidate('runtime'));
supplierMonitorService?.setCostRefreshHandler(async()=>{
  await syncService?.refreshQueuedUsageCosts();
  await Promise.all([
    responseCache.invalidate('accounts'),
    responseCache.invalidate('overview'),
  ]);
});

const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.ico':'image/x-icon'};
const compressibleStaticExtensions=new Set(['.html','.css','.js','.svg','.json']);
const staticContentCache=new Map();
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
function compressedResponse(res,content,{compress=true}={}){
  const body=Buffer.isBuffer(content)?content:Buffer.from(content);
  const acceptsGzip=/\bgzip\b/i.test(String(res.finopsAcceptEncoding||''));
  if(!compress||body.length<1_024||!acceptsGzip)return {body,headers:compress?{'Vary':'Accept-Encoding'}:{}};
  return {body:zlib.gzipSync(body),headers:{'Content-Encoding':'gzip','Vary':'Accept-Encoding'}};
}
function json(res,status,data){
  setHeaders(res);
  const encoded=compressedResponse(res,JSON.stringify(data));
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'Content-Length':encoded.body.length,
    ...encoded.headers,
  });
  res.end(encoded.body);
}
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

function replenishmentCatalog(groups, modelsByPlatform = {}, proxies = []) {
  return {
    groups,
    proxies,
    platforms: [...new Set(groups.map((group) => group.platform).filter(Boolean))].sort(),
    modelsByPlatform,
  };
}

function validatedReplenishmentMapping(input, groups) {
  const groupIds = [...new Set((input.targetGroupIds || []).map(Number))]
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .sort((left, right) => left - right);
  if (!groupIds.length) {
    throw Object.assign(new Error('请至少选择一个 Sub2API 正式分组'), { statusCode: 400 });
  }
  const byId = new Map(groups.map((group) => [Number(group.id), group]));
  const selected = groupIds.map((id) => byId.get(id));
  if (selected.some((group) => !group)) {
    throw Object.assign(new Error('所选 Sub2API 分组不存在，请刷新后重新选择'), { statusCode: 400 });
  }
  if (selected.some((group) => group.status && group.status !== 'active')) {
    throw Object.assign(new Error('停用的 Sub2API 分组不能用于自动补号'), { statusCode: 400 });
  }
  const selectedPlatforms = [...new Set(selected.map((group) => group.platform).filter(Boolean))];
  const platform = String(input.platform || '').trim();
  if (selectedPlatforms.length !== 1 || selectedPlatforms[0] !== platform) {
    throw Object.assign(new Error('所选分组必须属于当前平台'), { statusCode: 400 });
  }
  return { ...input, platform, targetGroupIds: groupIds };
}

function payloadItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.accounts)) return payload.accounts;
  return [];
}

function supplierGroupItem(group, local = {}) {
  return {
    id: Number(group?.id ?? group?.group_id ?? group?.source_group_id),
    name: group?.name || '',
    description: group?.description || '',
    platform: group?.platform || '',
    status: group?.status || '',
    rateMultiplier: group?.rate_multiplier ?? group?.rateMultiplier ?? null,
    accountCount: Number(group?.account_count ?? group?.accountCount ?? local.linkedAccountCount ?? 0),
    activeAccountCount: Number(group?.active_account_count ?? group?.activeAccountCount ?? 0),
    rateLimitedAccountCount: Number(group?.rate_limited_account_count ?? group?.rateLimitedAccountCount ?? 0),
    keyCount: Number(local.keyCount || 0),
    supplierCount: Number(local.supplierCount || 0),
    linkedAccountCount: Number(local.linkedAccountCount || 0),
    supplierNames: Array.isArray(local.supplierNames) ? local.supplierNames : [],
    minimumUpstreamMultiplier: local.minimumUpstreamMultiplier ?? null,
    maximumUpstreamMultiplier: local.maximumUpstreamMultiplier ?? null,
  };
}

async function refreshSourceGroupCatalog(accessToken,request){
  if(config.demoMode||!accessToken)return;
  try{
    const groups=await listSub2ApiAdminGroups({accessToken,clientIp:clientIp(request)},config);
    await repository.upsertSourceGroupCatalog(groups);
  }catch(error){
    console.warn('[monitor group catalog]',error instanceof Sub2ApiAuthError?error.code:error?.message||error);
  }
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
function usageSort(searchParams){
  const sort=searchParams.get('sort')||'userChargeCny';
  const direction=searchParams.get('direction')||'desc';
  const allowed=new Set(['userChargeCny','requests','tokens','bookedCostCny','bookedProfitCny']);
  if(!allowed.has(sort))throw Object.assign(new Error('invalid usage sort'),{statusCode:400});
  if(!['asc','desc'].includes(direction))throw Object.assign(new Error('invalid usage sort direction'),{statusCode:400});
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
    syncService?.setSub2ApiAccessToken(result.accessToken);
    sub2ApiReadonlyGateway.setAccessToken(result.accessToken);
    await refreshSourceGroupCatalog(result.accessToken,request);
    await syncService?.refreshChannelMonitorSnapshots();
    await syncService?.refreshRuntimeSnapshots();
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
    const result=await completeSub2ApiAdministratorTwoFactor({tempToken:pending.tempToken,totpCode:code,clientIp:clientIp(request)},config);
    pendingLogins.delete(pendingLoginId(request));
    syncService?.setSub2ApiAccessToken(result.accessToken);
    sub2ApiReadonlyGateway.setAccessToken(result.accessToken);
    await refreshSourceGroupCatalog(result.accessToken,request);
    await syncService?.refreshChannelMonitorSnapshots();
    await syncService?.refreshRuntimeSnapshots();
    res.setHeader('Set-Cookie',[clearPendingLoginCookie(config),sessionCookie(result.user,config)]);
    return json(res,200,{ok:true,user:result.user});
  }catch(error){
    const failure=authFailure(error);
    return json(res,failure.status,{error:failure.error});
  }
}
async function api(request,res,url){
  const auth=authorize(request,config);if(!auth.ok)return json(res,401,{error:'unauthorized'});
  const range=()=>resolveRange(url.searchParams,new Date(),config.timezone),page=()=>pagination(url.searchParams);
  if(request.method!=='GET')await responseCache.invalidate();
  const cached=(scope,ttl,loader)=>responseCache.remember(scope,`${request.method}:${url.pathname}?${url.searchParams.toString()}`,ttl,loader);
  if(request.method==='GET'&&url.pathname==='/api/bootstrap')return json(res,200,await cached('bootstrap',config.dashboardCacheTtlSeconds,()=>repository.getBootstrap()));
  if(request.method==='GET'&&url.pathname==='/api/source/dashboard-snapshot'){
    return json(res,200,await sub2ApiReadonlyGateway.dashboardSnapshot({
      includeStats:url.searchParams.get('include_stats')!=='false',
      includeTrend:url.searchParams.get('include_trend')!=='false',
      includeModels:url.searchParams.get('include_models')!=='false',
      includeGroups:url.searchParams.get('include_groups')==='true',
      includeUsersTrend:url.searchParams.get('include_users_trend')==='true',
      startDate:url.searchParams.get('start_date') || '',
      endDate:url.searchParams.get('end_date') || '',
    }));
  }
  if(request.method==='GET'&&url.pathname==='/api/source/channel-monitors'){
    return json(res,200,await sub2ApiReadonlyGateway.channelMonitors());
  }
  if(request.method==='GET'&&url.pathname==='/api/source/risk-control'){
    return json(res,200,await sub2ApiReadonlyGateway.riskControlStatus());
  }
  if(request.method==='POST'&&url.pathname==='/api/source/accounts/today-stats'){
    const input=await body(request);
    const ids=Array.isArray(input.accountIds)?input.accountIds.map(Number).filter(Number.isSafeInteger):[];
    if(!ids.length||ids.length>100)return json(res,400,{error:'accountIds must contain 1 to 100 ids'});
    return json(res,200,await sub2ApiReadonlyGateway.accountTodayStats(ids));
  }
  if(request.method==='GET'&&url.pathname==='/api/summary')return json(res,200,await cached('summary',config.dashboardCacheTtlSeconds,()=>sourceUsageService.getSummary(range())));
  if(request.method==='GET'&&url.pathname==='/api/overview-dashboard')return json(res,200,await cached('overview',config.dashboardCacheTtlSeconds,()=>sourceUsageService.getOverviewDashboard(range())));
  if(request.method==='GET'&&url.pathname==='/api/trend')return json(res,200,await cached('trend',config.dashboardCacheTtlSeconds,()=>sourceUsageService.getTrend(range())));
  if(request.method==='GET'&&url.pathname==='/api/usage/models')return json(res,200,await cached('usage',config.listCacheTtlSeconds,()=>sourceUsageService.getUsageBreakdown({...range(),...page(),...usageSort(url.searchParams)})));
  if(request.method==='GET'&&url.pathname==='/api/usage/users')return json(res,200,await cached('usage-users',config.listCacheTtlSeconds,()=>sourceUsageService.listUsers({
    ...range(),...page(),...userSort(url.searchParams),consumptionOnly:true,
  })));
  if(request.method==='GET'&&url.pathname==='/api/usage/events')return json(res,200,await cached('usage-events',config.listCacheTtlSeconds,()=>sourceUsageService.listUsageEvents({...range(),...page(),search:searchTerm(url.searchParams)})));
  const userDetails=/^\/api\/users\/(\d+)\/details$/.exec(url.pathname);
  if(request.method==='GET'&&userDetails){
    const userId=Number(userDetails[1]);
    return json(res,200,await cached('user-details',config.listCacheTtlSeconds,()=>sourceUsageService.getUserDetails({
      ...range(),userId,recharge:detailPagination(url.searchParams,'recharge'),
      usage:detailPagination(url.searchParams,'usage'),
    })));
  }
  if(request.method==='GET'&&url.pathname==='/api/users'){
    return json(res,200,await cached('users',config.listCacheTtlSeconds,()=>sourceUsageService.listUsers({
      ...range(),...page(),...userSort(url.searchParams),search:searchTerm(url.searchParams),balanceScope:userBalanceScope(url.searchParams),
    })));
  }
  const accountCostHistory=/^\/api\/accounts\/(\d+)\/cost-periods$/.exec(url.pathname);
  if(request.method==='GET'&&accountCostHistory){
    return json(res,200,await repository.listAccountCostPeriods({
      accountId:Number(accountCostHistory[1]),...page(),
    }));
  }
  const accountRuleHistory=/^\/api\/accounts\/(\d+)\/cost-rules$/.exec(url.pathname);
  if(request.method==='GET'&&accountRuleHistory){
    return json(res,200,await repository.listAccountCostRuleHistory({
      accountId:Number(accountRuleHistory[1]),...page(),
    }));
  }
  const accountProfitGuard=/^\/api\/accounts\/(\d+)\/profit-guard$/.exec(url.pathname);
  if(request.method==='GET'&&accountProfitGuard){
    return json(res,200,await repository.getAccountProfitGuard(Number(accountProfitGuard[1])));
  }
  if(request.method==='PATCH'&&accountProfitGuard){
    const accountId=Number(accountProfitGuard[1]);
    const policy=await repository.upsertAccountProfitGuard(accountId,normalizeAccountProfitGuard(await body(request)),auth.actor);
    let evaluation=null;
    if (policy.enabled && !config.demoMode) {
      try {
        const account = await repository.getAccountProfitGuard(accountId);
        if (account.supplier?.keyId) {
          evaluation=await accountProfitGuardService.evaluateSupplierConnection(
            (await repository.getSupplierKeyContext(account.supplier.keyId)).connection.id,
          );
        }
      } catch (error) {
        await repository.recordProfitGuardError(accountId,error?.message || error);
        evaluation={evaluated:0,changed:0,error:String(error?.message||error)};
      }
    }
    return json(res,200,{...await repository.getAccountProfitGuard(accountId),evaluation});
  }
  if(request.method==='GET'&&url.pathname==='/api/accounts')return json(res,200,await cached('accounts',config.listCacheTtlSeconds,async()=>{
    const groupId=filterTerm(url.searchParams,'group_id',40);
    const accountIds=groupId&&!config.demoMode
      ? await sub2ApiReadonlyGateway.listAccountIds({group:groupId,status:''})
      : null;
    return sourceUsageService.listAccounts({
      ...range(),...page(),search:searchTerm(url.searchParams),scope:accountScope(url.searchParams),
      ...listSort(url.searchParams,[
        'createdAt','name','acquisitionCostCny','userChargeCny','profitCny',
        'requests','tokens','expiresAt','status',
      ],'createdAt'),
      platform:filterTerm(url.searchParams,'platform',40),
      accountType:filterTerm(url.searchParams,'account_type',40),
      supplier:filterTerm(url.searchParams,'supplier',120),
      status:filterTerm(url.searchParams,'status',40),
      privacyMode:filterTerm(url.searchParams,'privacy_mode',80),
      groupId:config.demoMode?groupId:'',
      accountIds,
      costMode:filterTerm(url.searchParams,'cost_mode',40),
    });
  }));
  if(request.method==='GET'&&url.pathname==='/api/purchase-catalog')return json(res,200,await cached('purchase-catalog',config.listCacheTtlSeconds,()=>repository.listPurchaseCatalog()));
  if(request.method==='GET'&&url.pathname==='/api/suppliers')return json(res,200,await cached('suppliers',config.listCacheTtlSeconds,()=>sourceUsageService.getSupplierOverview({...range(),search:searchTerm(url.searchParams)})));
  if(request.method==='GET'&&url.pathname==='/api/supplier-connections')return json(res,200,await cached('supplier-connections',config.listCacheTtlSeconds,()=>repository.listSupplierConnections({search:searchTerm(url.searchParams)})));
  if(request.method==='GET'&&url.pathname==='/api/supplier-groups'){
    return json(res,200,await cached('supplier-groups',Math.min(10,config.listCacheTtlSeconds),async()=>{
      const paging=page();
      const [groupsPayload,localRows]=await Promise.all([
        config.demoMode?Promise.resolve([]):sub2ApiReadonlyGateway.listGroups(),
        repository.listSupplierGroupSummaries(),
      ]);
      const localById=new Map(localRows.map((item)=>[Number(item.groupId),item]));
      const groups=payloadItems(groupsPayload).map((group)=>supplierGroupItem(group,localById.get(Number(group?.id))));
      const search=searchTerm(url.searchParams).toLowerCase();
      const supplier=String(url.searchParams.get('supplier')||'').trim();
      const platform=String(url.searchParams.get('platform')||'').trim();
      const status=String(url.searchParams.get('status')||'').trim();
      const filtered=groups.filter((group)=>{
        if(search&&!`${group.name} ${group.description} ${group.platform} ${group.id}`.toLowerCase().includes(search))return false;
        if(supplier&&!group.supplierNames.includes(supplier))return false;
        if(platform&&group.platform!==platform)return false;
        if(status&&group.status!==status)return false;
        return true;
      }).sort((left,right)=>{
        if(left.status!==right.status)return left.status==='active'?-1:right.status==='active'?1:0;
        return left.platform.localeCompare(right.platform,'zh-CN')||left.name.localeCompare(right.name,'zh-CN');
      });
      return {
        items:filtered.slice(paging.offset,paging.offset+paging.pageSize),
        total:filtered.length,page:paging.page,pageSize:paging.pageSize,
        platforms:[...new Set(groups.map((group)=>group.platform).filter(Boolean))].sort(),
        suppliers:[...new Set(groups.flatMap((group)=>group.supplierNames).filter(Boolean))].sort(),
      };
    }));
  }
  if(request.method==='GET'&&url.pathname==='/api/supplier-keys'){
    return json(res,200,await repository.listSupplierKeys({
      search:searchTerm(url.searchParams),
      supplier:String(url.searchParams.get('supplier') || '').trim(),
      platform:String(url.searchParams.get('platform') || '').trim(),
      groupId:String(url.searchParams.get('group_id') || '').trim(),
      status:url.searchParams.get('status') || 'active',
      sortBy:String(url.searchParams.get('sort_by') || 'last_check_at').trim(),
      sortOrder:String(url.searchParams.get('sort_order') || 'desc').trim().toLowerCase(),
      ...page(),
    }));
  }
  const supplierGroupDetails=/^\/api\/supplier-groups\/(\d+)\/details$/.exec(url.pathname);
  if(request.method==='GET'&&supplierGroupDetails){
    const groupId=Number(supplierGroupDetails[1]);
    const groupPaging=page();
    const requestedPage=groupPaging.page;
    const requestedPageSize=groupPaging.pageSize;
    const [groupsPayload,accountsPayload]=await Promise.all([
      sub2ApiReadonlyGateway.listGroups(),
      sub2ApiReadonlyGateway.listAccounts({
        group:String(groupId),page:requestedPage,pageSize:requestedPageSize,status:'',
      }),
    ]);
    const group=payloadItems(groupsPayload).find((item)=>Number(item?.id??item?.group_id)===groupId);
    if(!group)throw Object.assign(new Error('supplier group not found'),{statusCode:404});
    const accounts=payloadItems(accountsPayload);
    const keys=await repository.listSupplierGroupKeysForAccounts(accounts.map((account)=>Number(account.id)));
    const keysByAccount=new Map();
    for(const key of keys){
      const list=keysByAccount.get(key.accountId)||[];
      list.push(key);
      keysByAccount.set(key.accountId,list);
    }
    return json(res,200,{
      group:supplierGroupItem(group),
      accounts:accounts.map((account)=>({
        id:Number(account.id),name:account.name||'',platform:account.platform||'',type:account.type||'',
        status:account.status||'',concurrency:Number(account.concurrency||0),priority:Number(account.priority||0),
        currentConcurrency:Number(account.current_concurrency||0),schedulable:Boolean(account.schedulable),
        errorMessage:account.error_message||'',lastUsedAt:account.last_used_at||null,
        keys:keysByAccount.get(Number(account.id))||[],
      })),
      total:Number(accountsPayload?.total||accounts.length),
      page:Number(accountsPayload?.page||requestedPage),
      pageSize:Number(accountsPayload?.page_size||accountsPayload?.pageSize||requestedPageSize),
    });
  }
  if(request.method==='GET'&&url.pathname==='/api/supplier-quality-overview'){
    return json(res,200,await cached('supplier-quality-overview',config.listCacheTtlSeconds,()=>repository.listSupplierQualityOverview(range())));
  }
  const supplierConnectionDetails=/^\/api\/supplier-connections\/(\d+)\/details$/.exec(url.pathname);
  if(request.method==='GET'&&supplierConnectionDetails){
    return json(res,200,await repository.getSupplierConnectionDetails(Number(supplierConnectionDetails[1])));
  }
  const supplierConnectionAccountCandidates=/^\/api\/supplier-connections\/(\d+)\/account-candidates$/.exec(url.pathname);
  if(request.method==='GET'&&supplierConnectionAccountCandidates){
    return json(res,200,await repository.listSupplierConnectionAccountCandidates(
      Number(supplierConnectionAccountCandidates[1]),
      {search:searchTerm(url.searchParams),limit:100},
    ));
  }
  const supplierProfitGuardDefault=/^\/api\/supplier-connections\/(\d+)\/profit-guard-default$/.exec(url.pathname);
  if(request.method==='GET'&&supplierProfitGuardDefault){
    return json(res,200,await repository.getSupplierProfitGuardDefault(Number(supplierProfitGuardDefault[1])));
  }
  if(request.method==='PATCH'&&supplierProfitGuardDefault){
    const connectionId=Number(supplierProfitGuardDefault[1]);
    const policy=await repository.upsertSupplierProfitGuardDefault(
      connectionId,normalizeAccountProfitGuard(await body(request)),auth.actor,
    );
    let evaluation=null;
    if(policy.enabled&&!config.demoMode){
      try{evaluation=await accountProfitGuardService.evaluateSupplierConnection(connectionId);}
      catch(error){evaluation={evaluated:0,changed:0,error:String(error?.message||error)};}
    }
    return json(res,200,{...policy,evaluation});
  }
  const supplierQuality=/^\/api\/supplier-connections\/(\d+)\/quality$/.exec(url.pathname);
  if(request.method==='GET'&&supplierQuality){
    const connectionId=Number(supplierQuality[1]);
    await repository.getSupplierConnection(connectionId);
    const [dashboard,targets]=await Promise.all([
      repository.getSupplierQualityDashboard(connectionId, range()),
      repository.listSupplierQualityTargets(connectionId),
    ]);
    return json(res,200,{...dashboard,targets:targets.items||[]});
  }
  const supplierQualityTargets=/^\/api\/supplier-connections\/(\d+)\/quality-targets$/.exec(url.pathname);
  if(request.method==='GET'&&supplierQualityTargets){
    return json(res,200,await repository.listSupplierQualityTargets(Number(supplierQualityTargets[1])));
  }
  const supplierKeyModels=/^\/api\/supplier-keys\/(\d+)\/models$/.exec(url.pathname);
  if(request.method==='GET'&&supplierKeyModels){
    if(config.demoMode)return json(res,200,{keyId:Number(supplierKeyModels[1]),models:['gpt-4o-mini','claude-3-5-haiku','deepseek-chat']});
    return json(res,200,await supplierMonitorService.listSupplierKeyModels(Number(supplierKeyModels[1])));
  }
  const supplierKeyDetails=/^\/api\/supplier-keys\/(\d+)\/details$/.exec(url.pathname);
  if(request.method==='GET'&&supplierKeyDetails){
    return json(res,200,await repository.getSupplierKeyDetails(Number(supplierKeyDetails[1])));
  }
  const supplierKeyAccountGroups=/^\/api\/supplier-keys\/(\d+)\/accounts\/(\d+)\/groups$/.exec(url.pathname);
  if(request.method==='GET'&&supplierKeyAccountGroups){
    const keyId=Number(supplierKeyAccountGroups[1]);
    const accountId=Number(supplierKeyAccountGroups[2]);
    const keyDetail=await repository.getSupplierKeyDetails(keyId);
    const account=keyDetail.accounts.find((item)=>Number(item.id)===accountId);
    if(!account)throw Object.assign(new Error('account is not linked to this supplier key'),{statusCode:404});
    const sourceAccount=await sub2ApiReadonlyGateway.getAccount(accountId,{fresh:true});
    const groupsPayload=await sub2ApiReadonlyGateway.listGroups();
    const groups=Array.isArray(groupsPayload)?groupsPayload:groupsPayload?.items||[];
    const rawGroupIds=sourceAccount?.group_ids??sourceAccount?.groupIds??sourceAccount?.groups??[];
    const groupIds=Array.isArray(rawGroupIds)?rawGroupIds:[];
    const assignedIds=new Set(groupIds.map((item)=>Number(typeof item==='object'?(item?.id??item?.group_id??item?.source_group_id):item)).filter((item)=>Number.isSafeInteger(item)&&item>0));
    return json(res,200,{
      account:{...account,id:accountId},
      groups:groups.filter((group)=>assignedIds.has(Number(group?.id))).map((group)=>({
        id:Number(group.id??group.group_id??group.source_group_id),name:group.name||'',platform:group.platform||'',
        rateMultiplier:group.rate_multiplier??group.rateMultiplier??null,status:group.status||'',
      })),
    });
  }
  if(request.method==='PATCH'&&url.pathname==='/api/supplier-keys/profit-guard'){
    const input=await body(request);
    const keyIds=Array.isArray(input.keyIds)
      ? [...new Set(input.keyIds.map(Number).filter((id)=>Number.isSafeInteger(id)&&id>0))]
      : [];
    if(!keyIds.length||keyIds.length>200)throw Object.assign(new Error('keyIds must contain between 1 and 200 supplier keys'),{statusCode:400});
    const policy=normalizeAccountProfitGuard(input);
    const result=await repository.upsertSupplierKeysProfitGuard(keyIds,policy,auth.actor);
    const evaluations=[];
    if(policy.enabled&&!config.demoMode){
      for(const connectionId of result.connectionIds){
        try{evaluations.push(await accountProfitGuardService.evaluateSupplierConnection(connectionId));}
        catch(error){evaluations.push({evaluated:0,changed:0,error:String(error?.message||error)});}
      }
    }
    return json(res,200,{...result,evaluation:{
      evaluated:evaluations.reduce((sum,item)=>sum+Number(item.evaluated||0),0),
      changed:evaluations.reduce((sum,item)=>sum+Number(item.changed||0),0),
      errors:evaluations.filter((item)=>item.error).map((item)=>item.error),
    }});
  }
  const supplierKeyProfitGuard=/^\/api\/supplier-keys\/(\d+)\/profit-guard$/.exec(url.pathname);
  if(request.method==='PATCH'&&supplierKeyProfitGuard){
    const keyId=Number(supplierKeyProfitGuard[1]);
    const input=await body(request);
    const accountIds=Array.isArray(input.accountIds)
      ? [...new Set(input.accountIds.map(Number).filter((id)=>Number.isSafeInteger(id)&&id>0))]
      : [];
    if(!accountIds.length||accountIds.length>200)throw Object.assign(new Error('accountIds must contain between 1 and 200 accounts'),{statusCode:400});
    const policy=normalizeAccountProfitGuard(input);
    const result=await repository.upsertSupplierKeyProfitGuard(keyId,accountIds,policy,auth.actor);
    let evaluation=null;
    if(policy.enabled&&!config.demoMode){
      try{evaluation=await accountProfitGuardService.evaluateSupplierConnection(result.connectionId);}
      catch(error){evaluation={evaluated:0,changed:0,error:String(error?.message||error)};}
    }
    return json(res,200,{...result,evaluation});
  }
  if(request.method==='POST'&&supplierQualityTargets){
    const connectionId=Number(supplierQualityTargets[1]);
    await repository.getSupplierConnection(connectionId);
    return json(res,201,await repository.upsertSupplierQualityTarget(
      connectionId,normalizeSupplierQualityTarget(await body(request)),auth.actor,
    ));
  }
  const supplierQualityTargetId=/^\/api\/supplier-quality-targets\/(\d+)$/.exec(url.pathname);
  if(request.method==='PATCH'&&supplierQualityTargetId){
    const targetId=Number(supplierQualityTargetId[1]);
    return json(res,200,await repository.updateSupplierQualityTarget(
      targetId,normalizeSupplierQualityTarget(await body(request)),auth.actor,
    ));
  }
  if(request.method==='DELETE'&&supplierQualityTargetId){
    return json(res,200,await repository.deleteSupplierQualityTarget(Number(supplierQualityTargetId[1]),auth.actor));
  }
  const supplierQualityTargetRun=/^\/api\/supplier-quality-targets\/(\d+)\/run$/.exec(url.pathname);
  if(request.method==='POST'&&supplierQualityTargetRun){
    const targetId=Number(supplierQualityTargetRun[1]);
    if(config.demoMode)return json(res,200,await repository.runSupplierQualityTarget(targetId));
    return json(res,200,await supplierMonitorService.probeSupplierQualityTarget(targetId));
  }
  if(request.method==='POST'&&url.pathname==='/api/supplier-connections'){
    if(!config.demoMode&&!supplierMonitorService?.status().available)return json(res,503,{error:'供应商凭据加密尚未配置'});
    const input=normalizeSupplierConnection(await body(request));
    input.baseUrl=normalizeSupplierBaseUrl(input.baseUrl,{blockedHosts:config.supplierBlockedHosts});
    assertSupplierCredentials(input);
    const ciphertext=config.demoMode?'demo-encrypted':supplierMonitorService.encryptCredentials(input.credentials);
    const created=await repository.createSupplierConnection(input,ciphertext,auth.actor);
    const sync=config.demoMode?await repository.syncSupplierConnection(created.id):await supplierMonitorService.syncConnection(created.id);
    return json(res,201,{connection:await repository.getSupplierConnection(created.id),sync});
  }
  const supplierConnectionId=/^\/api\/supplier-connections\/(\d+)$/.exec(url.pathname);
  if(request.method==='DELETE'&&supplierConnectionId){
    const result=await supplierDeletionService.deleteConnection(Number(supplierConnectionId[1]),auth.actor);
    responseCache.invalidate('supplier-connections');
    return json(res,200,result);
  }
  if(request.method==='PATCH'&&supplierConnectionId){
    if(!config.demoMode&&!supplierMonitorService?.status().available)return json(res,503,{error:'供应商凭据加密尚未配置'});
    const id=Number(supplierConnectionId[1]);
    const current=await repository.getSupplierConnection(id,{includeCiphertext:true});
    let input=normalizeSupplierConnection(await body(request));
    input.baseUrl=normalizeSupplierBaseUrl(input.baseUrl,{blockedHosts:config.supplierBlockedHosts});
    if (!config.demoMode && hasSupplierCredentialInput(input.credentials) && input.authMode === current.authMode) {
      input = {
        ...input,
        credentials: mergeSupplierCredentials(
          supplierMonitorService.decryptCredentials(current.credentialsCiphertext),
          input.credentials,
        ),
      };
    }
    const replaceCredentials=assertSupplierCredentials(input,{existing:true});
    if(!replaceCredentials&&input.authMode!==current.authMode){
      throw Object.assign(new Error('切换认证方式时必须重新填写访问凭据'),{statusCode:400});
    }
    const ciphertext=replaceCredentials?(config.demoMode?'demo-encrypted':supplierMonitorService.encryptCredentials(input.credentials)):current.credentialsCiphertext;
    await repository.updateSupplierConnection(id,input,ciphertext,auth.actor);
    const sync=input.enabled?(config.demoMode?await repository.syncSupplierConnection(id):await supplierMonitorService.syncConnection(id)):{ok:false,status:'disabled'};
    return json(res,200,{connection:await repository.getSupplierConnection(id),sync});
  }
  const supplierKeyId=/^\/api\/supplier-keys\/(\d+)$/.exec(url.pathname);
  if(request.method==='DELETE'&&supplierKeyId){
    const result=await supplierDeletionService.deleteKey(Number(supplierKeyId[1]),auth.actor);
    responseCache.invalidate('supplier-connections');
    return json(res,200,result);
  }
  const supplierConnectionSync=/^\/api\/supplier-connections\/(\d+)\/sync$/.exec(url.pathname);
  if(request.method==='POST'&&supplierConnectionSync){
    if(!config.demoMode&&!supplierMonitorService?.status().available)return json(res,503,{error:'供应商凭据加密尚未配置'});
    const id=Number(supplierConnectionSync[1]);
    await repository.getSupplierConnection(id);
    const sync=config.demoMode?await repository.syncSupplierConnection(id):await supplierMonitorService.syncConnection(id,{throwOnError:true});
    return json(res,200,{sync,connection:await repository.getSupplierConnection(id)});
  }
  const supplierKeyLink=/^\/api\/supplier-keys\/(\d+)\/account-link$/.exec(url.pathname);
  if(request.method==='PATCH'&&supplierKeyLink){
    const input=normalizeSupplierAccountLink(await body(request));
    const link=await repository.setSupplierKeyAccountLink(Number(supplierKeyLink[1]),input.accountId,input.linked,auth.actor);
    const sync=input.linked
      ? config.demoMode
        ? await repository.syncSupplierConnection(link.connectionId)
        : await supplierMonitorService.syncConnection(link.connectionId)
      : null;
    await syncService?.refreshQueuedUsageCosts();
    await Promise.all([
      responseCache.invalidate('accounts'),
      responseCache.invalidate('overview'),
    ]);
    return json(res,200,{...link,sync});
  }
  const supplierAlertAck=/^\/api\/supplier-alerts\/(\d+)\/acknowledge$/.exec(url.pathname);
  if(request.method==='POST'&&supplierAlertAck){
    return json(res,200,await repository.acknowledgeSupplierAlert(Number(supplierAlertAck[1]),auth.actor));
  }
  if(request.method==='GET'&&url.pathname==='/api/alert-notification-settings'){
    return json(res,200,await repository.getAlertNotificationSettings());
  }
  if(request.method==='GET'&&url.pathname==='/api/sub2api-service-auth'){
    await sub2ApiServiceAuthService.loadSettings();
    return json(res,200,sub2ApiServiceAuthService.status());
  }
  if(request.method==='GET'&&url.pathname==='/api/oauth-supply-auth'){
    await oauthSupplyAuthService.loadSettings();
    return json(res,200,oauthSupplyAuthService.status());
  }
  if(request.method==='PATCH'&&url.pathname==='/api/oauth-supply-auth'){
    const settings=await oauthSupplyAuthService.updateSettings(
      normalizeOAuthSupplyAuthSettings(await body(request)),
      auth.actor,
    );
    return json(res,200,settings);
  }
  if(request.method==='POST'&&url.pathname==='/api/oauth-supply-auth/test'){
    return json(res,200,await oauthSupplyAuthService.test());
  }
  if(request.method==='GET'&&url.pathname==='/api/replenishment/dashboard'){
    return json(res,200,await cached(
      'replenishment-dashboard',
      config.dashboardCacheTtlSeconds,
      ()=>replenishmentRepository.dashboard(range()),
    ));
  }
  if(request.method==='GET'&&url.pathname==='/api/replenishment/balance'){
    return json(res,200,await cached(
      'replenishment-balance',
      config.dashboardCacheTtlSeconds,
      ()=>replenishmentService.balance(),
    ));
  }
  if(request.method==='GET'&&url.pathname==='/api/replenishment/mappings'){
    return json(res,200,await cached(
      'replenishment-mappings',
      config.listCacheTtlSeconds,
      ()=>replenishmentRepository.listMappings(),
    ));
  }
  if(request.method==='GET'&&url.pathname==='/api/replenishment/catalog'){
    return json(res,200,await cached('replenishment-catalog',30,async()=>{
      const groups=await sub2ApiAccountImportGateway.listGroups();
      return replenishmentCatalog(
        groups,
        await sub2ApiAccountImportGateway.listModelCandidates(groups),
        await sub2ApiAccountImportGateway.listProxies(),
      );
    }));
  }
  if((request.method==='POST'||request.method==='PATCH')&&url.pathname==='/api/replenishment/mappings'){
    const input=await body(request);
    const groups=await sub2ApiAccountImportGateway.listGroups();
    return json(res,200,await replenishmentRepository.upsertMapping(
      validatedReplenishmentMapping(input,groups),
      auth.actor,
    ));
  }
  const replenishmentMappingId=/^\/api\/replenishment\/mappings\/(\d+)$/.exec(url.pathname);
  if(request.method==='DELETE'&&replenishmentMappingId){
    return json(res,200,await replenishmentRepository.deleteMapping(Number(replenishmentMappingId[1])));
  }
  if(request.method==='GET'&&url.pathname==='/api/replenishment/rules'){
    return json(res,200,await cached(
      'replenishment-rules',
      config.listCacheTtlSeconds,
      ()=>replenishmentRepository.listRules(),
    ));
  }
  if(request.method==='GET'&&url.pathname==='/api/replenishment/recovery-policies'){
    return json(res,200,await cached(
      'replenishment-recovery-policies',
      config.listCacheTtlSeconds,
      ()=>replenishmentRepository.listRecoveryPolicies(),
    ));
  }
  const replenishmentRecoveryPolicyId=/^\/api\/replenishment\/recovery-policies\/(\d+)$/.exec(url.pathname);
  if((request.method==='PATCH'||request.method==='PUT')&&replenishmentRecoveryPolicyId){
    return json(res,200,await replenishmentRepository.saveRecoveryPolicy({
      ...(await body(request)),
      ruleId:Number(replenishmentRecoveryPolicyId[1]),
    },auth.actor));
  }
  if(request.method==='GET'&&url.pathname==='/api/replenishment/events'){
    const ruleId=url.searchParams.get('ruleId');
    return json(res,200,await cached(
      'replenishment-events',
      config.listCacheTtlSeconds,
      ()=>replenishmentRepository.listEvents({
        ...range(),
        ruleId:ruleId?Number(ruleId):null,
        limit:Math.min(200,Math.max(1,Number(url.searchParams.get('limit')||100))),
      }),
    ));
  }
  if(request.method==='POST'&&url.pathname==='/api/replenishment/rules'){
    return json(res,201,await replenishmentRepository.saveRule(await body(request),auth.actor));
  }
  const replenishmentRuleId=/^\/api\/replenishment\/rules\/(\d+)$/.exec(url.pathname);
  if(request.method==='PATCH'&&replenishmentRuleId){
    return json(res,200,await replenishmentRepository.saveRule({
      ...(await body(request)),
      id:Number(replenishmentRuleId[1]),
    },auth.actor));
  }
  const replenishmentRuleStatus=/^\/api\/replenishment\/rules\/(\d+)\/status$/.exec(url.pathname);
  if(request.method==='PATCH'&&replenishmentRuleStatus){
    const input=await body(request);
    return json(res,200,await replenishmentRepository.setRuleEnabled(
      Number(replenishmentRuleStatus[1]),
      Boolean(input.enabled),
      auth.actor,
    ));
  }
  if(request.method==='DELETE'&&replenishmentRuleId){
    return json(res,200,await replenishmentRepository.deleteRule(Number(replenishmentRuleId[1])));
  }
  if(request.method==='POST'&&url.pathname==='/api/replenishment/trigger'){
    const input=await body(request);
    const selectedRule=await replenishmentRepository.getRule(Number(input.ruleId));
    if(!selectedRule)return json(res,404,{error:'replenishment rule not found'});
    return json(res,200,await replenishmentService.createOrderForRule(selectedRule,{
      trigger:'manual',
      actor:auth.actor,
      force:Boolean(input.force),
    }));
  }
  if(request.method==='GET'&&url.pathname==='/api/replenishment/orders'){
    return json(res,200,await cached(
      'replenishment-orders',
      config.listCacheTtlSeconds,
      ()=>replenishmentRepository.listOrderPage({
        ...page(),
        ...range(),
        search:searchTerm(url.searchParams),
        filters:{
          orderId:filterTerm(url.searchParams,'order_id',40),
          externalOrderId:filterTerm(url.searchParams,'external_order_id',80),
          accountName:filterTerm(url.searchParams,'account_name'),
          sub2apiAccountId:filterTerm(url.searchParams,'sub2api_account_id',40),
          ruleProduct:filterTerm(url.searchParams,'rule_product'),
          status:filterTerm(url.searchParams,'status',40),
        },
        ...listSort(url.searchParams,[
          'created_at','updated_at','id','external_order_id','status',
          'requested_quantity','delivered_quantity','valid_quantity','actual_paid_amount_cny',
        ]),
      }),
    ));
  }
  const replenishmentOrderId=/^\/api\/replenishment\/orders\/(\d+)$/.exec(url.pathname);
  if(request.method==='GET'&&replenishmentOrderId){
    const result=await replenishmentRepository.getOrder(Number(replenishmentOrderId[1]));
    return result?json(res,200,result):json(res,404,{error:'replenishment order not found'});
  }
  const replenishmentApproval=/^\/api\/replenishment\/orders\/(\d+)\/approve$/.exec(url.pathname);
  if(request.method==='POST'&&replenishmentApproval){
    return json(res,200,await replenishmentService.approveOrder(Number(replenishmentApproval[1]),auth.actor));
  }
  if(request.method==='GET'&&url.pathname==='/api/replenishment/recoveries'){
    const scope=String(url.searchParams.get('scope')||'pending').trim().toLowerCase();
    if(!['pending','completed','all'].includes(scope))return json(res,400,{error:'invalid recovery scope'});
    return json(res,200,await cached(
      'replenishment-recoveries',
      config.listCacheTtlSeconds,
      ()=>replenishmentService.recoveries({
        ...page(),
        ...range(),
        scope,
        search:searchTerm(url.searchParams),
        filters:{
          accountName:filterTerm(url.searchParams,'account_name'),
          orderId:filterTerm(url.searchParams,'order_id',40),
          externalOrderId:filterTerm(url.searchParams,'external_order_id',80),
          sub2apiAccountId:filterTerm(url.searchParams,'sub2api_account_id',40),
          status:filterTerm(url.searchParams,'status',40),
        },
        ...listSort(url.searchParams,[
          'created_at','updated_at','account_name','order_id','external_order_id',
          'sub2api_account_id','status','attempt_count','claimed_at','recovered_at','account_cost_cny',
        ]),
      }),
    ));
  }
  const replenishmentImportRetryId=/^\/api\/replenishment\/import-retries\/(\d+)\/retry$/.exec(url.pathname);
  if(request.method==='POST'&&replenishmentImportRetryId){
    return json(res,200,await replenishmentService.retryImportItem(Number(replenishmentImportRetryId[1])));
  }
  const replenishmentImportCompleteId=/^\/api\/replenishment\/import-retries\/(\d+)\/complete$/.exec(url.pathname);
  if(request.method==='POST'&&replenishmentImportCompleteId){
    return json(res,200,await replenishmentService.completeImportRetryManually(
      Number(replenishmentImportCompleteId[1]),
      auth.actor,
    ));
  }
  const replenishmentRecoveryClaim=/^\/api\/replenishment\/recoveries\/([^/]+)\/claim$/.exec(url.pathname);
  if(request.method==='POST'&&replenishmentRecoveryClaim){
    return json(res,200,await replenishmentService.claimRecovery(decodeURIComponent(replenishmentRecoveryClaim[1])));
  }
  const replenishmentRecoveryComplete=/^\/api\/replenishment\/recoveries\/([^/]+)\/complete$/.exec(url.pathname);
  if(request.method==='POST'&&replenishmentRecoveryComplete){
    return json(res,200,await replenishmentService.completeRecoveryManually(
      decodeURIComponent(replenishmentRecoveryComplete[1]),
      auth.actor,
    ));
  }
  if(request.method==='PATCH'&&url.pathname==='/api/sub2api-service-auth'){
    const settings=await sub2ApiServiceAuthService.updateSettings(
      normalizeSub2ApiServiceAuthSettings(await body(request)),
      auth.actor,
    );
    await syncService?.refreshChannelMonitorSnapshots();
    await syncService?.refreshRuntimeSnapshots();
    return json(res,200,settings);
  }
  if(request.method==='POST'&&url.pathname==='/api/sub2api-service-auth/test'){
    await sub2ApiServiceAuthService.getAccessToken({force:true});
    return json(res,200,sub2ApiServiceAuthService.status());
  }
  if(request.method==='PATCH'&&url.pathname==='/api/alert-notification-settings'){
    const input=normalizeAlertNotificationSettings(await body(request));
    const accessTokenCiphertext=input.clearAccessToken
      ? ''
      : input.accessToken
        ? config.demoMode?'':qqAlertNotificationService.encryptAccessToken(input.accessToken)
        : undefined;
    return json(res,200,await repository.updateAlertNotificationSettings(input,accessTokenCiphertext,auth.actor));
  }
  if(request.method==='POST'&&url.pathname==='/api/alert-notification-settings/test'){
    if(config.demoMode)return json(res,200,{ok:true,demo:true});
    return json(res,200,await qqAlertNotificationService.test());
  }
  if(request.method==='GET'&&url.pathname==='/api/funds')return json(res,200,await cached('funds',config.listCacheTtlSeconds,()=>repository.listCashTransactions({...range(),...page(),search:searchTerm(url.searchParams),scope:cashScope(url.searchParams)})));
  if(request.method==='GET'&&url.pathname==='/api/non-cash-balance-credits')return json(res,200,await cached('non-cash-balance-credits',config.listCacheTtlSeconds,()=>repository.listNonCashBalanceCredits({...range(),...page()})));
  if(request.method==='GET'&&url.pathname==='/api/runtime'){
    const live=url.searchParams.get('live')==='1';
    if(url.searchParams.get('refresh')==='1'&&!live){
      await syncService?.refreshRuntimeSnapshots({
        minIntervalMs:0,
      });
      await responseCache.invalidate('runtime');
    }
    return json(res,200,await cached('runtime',config.runtimeCacheTtlSeconds,async()=>{
      const liveRuntime=live&&syncService?await syncService.readLiveRuntime():null;
      return repository.getRuntimeDashboard(liveRuntime);
    }));
  }
  if(request.method==='GET'&&url.pathname==='/api/reconciliation')return json(res,200,await cached('reconciliation',config.listCacheTtlSeconds,()=>repository.getReconciliation(range())));
  if(request.method==='GET'&&url.pathname==='/api/cost-profiles')return json(res,200,await cached('cost-profiles',config.listCacheTtlSeconds,()=>repository.listCostProfiles()));
  if(request.method==='GET'&&url.pathname==='/api/sync-state')return json(res,200,await repository.getSyncState());
  if(request.method==='GET'&&url.pathname==='/api/sync-details')return json(res,200,await repository.getSyncDetails());
  if(request.method==='GET'&&url.pathname==='/api/monitor-groups')return json(res,200,await repository.listMonitorGroups());
  if(request.method==='GET'&&url.pathname==='/api/monitor-group-candidates')return json(res,200,await repository.listMonitorGroupCandidates());
  if(request.method==='GET'&&url.pathname==='/api/monitor-settings')return json(res,200,await repository.getMonitorSettings());
  if(request.method==='PATCH'&&url.pathname==='/api/monitor-settings'){
    return json(res,200,await repository.updateMonitorSettings(normalizeMonitorSettings(await body(request)),auth.actor));
  }
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
  if(request.method==='POST'&&url.pathname==='/api/users/balance-statistics-whitelist'){
    return json(res,200,await repository.setBulkUserBalanceStatsWhitelist(
      normalizeBulkUserBalanceStatsWhitelist(await body(request)),auth.actor,
    ));
  }
  const userBalanceStatsWhitelist=/^\/api\/users\/(\d+)\/balance-statistics-whitelist$/.exec(url.pathname);
  if(request.method==='PATCH'&&userBalanceStatsWhitelist){
    return json(res,200,await repository.setUserBalanceStatsWhitelist(
      Number(userBalanceStatsWhitelist[1]),normalizeUserBalanceStatsWhitelist(await body(request)),auth.actor,
    ));
  }
  if(request.method==='POST'&&url.pathname==='/api/account-cost-periods/bulk'){
    return json(res,201,await repository.createBulkAccountCostPeriods(normalizeBulkAccountCostPeriods(await body(request)),auth.actor));
  }
  const accountCostArchive=/^\/api\/accounts\/(\d+)\/cost-archive$/.exec(url.pathname);
  if(request.method==='POST'&&accountCostArchive){
    return json(res,201,await repository.archiveAccountCost(
      Number(accountCostArchive[1]),normalizeAccountCostArchive(await body(request)),auth.actor,
    ));
  }
  const accountCostReprice=/^\/api\/accounts\/(\d+)\/cost-reprice$/.exec(url.pathname);
  if(request.method==='POST'&&accountCostReprice){
    return json(res,201,await repository.repriceAccountCost(
      Number(accountCostReprice[1]),normalizeAccountCostReprice(await body(request)),auth.actor,
    ));
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
  try{
    let content=staticContentCache.get(candidate);
    if(!content){
      content=await fs.readFile(candidate);
      staticContentCache.set(candidate,content);
    }
    setHeaders(res,{embeddable});
    const extension=path.extname(candidate).toLowerCase();
    const immutable=/^\/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:css|js)$/.test(url.pathname);
    const encoded=compressedResponse(res,content,{compress:compressibleStaticExtensions.has(extension)});
    res.writeHead(200,{
      'Content-Type':types[extension]||'application/octet-stream',
      'Cache-Control':immutable?'public, max-age=31536000, immutable':extension==='.html'?'no-cache':'public, max-age=86400',
      'Content-Length':encoded.body.length,
      ...encoded.headers,
    });
    res.end(encoded.body);
  }catch(error){if(error.code==='ENOENT')return json(res,404,{error:'not found'});throw error;}
}

async function readiness(){
  if(config.demoMode)return {status:'ready',mode:'demo'};
  const [, , usageReadOnly] = await Promise.all([
    sourcePool.query('SELECT 1'),
    finopsPool.query('SELECT 1'),
    sub2ApiUsagePool.query('SHOW transaction_read_only'),
  ]);
  if(usageReadOnly.rows[0]?.transaction_read_only!=='on'){
    throw new Error('Sub2API usage database connection is not read-only');
  }
  const migration=await finopsPool.query(
    `SELECT version FROM "${config.finopsSchema}".schema_migrations
     WHERE version = ANY($1::text[])`,
     [['002_cny_accounting', '003_reconciliation_snapshots', '004_cost_accounting_v2', '005_cost_snapshot_ledger', '006_group_monitoring', '007_source_group_catalog', '008_monitor_settings', '009_monitor_ping_latency', '010_multiplier_effective_history', '011_backfill_current_day_multiplier_rules', '012_cost_rule_archiving', '013_audited_cost_repricing', '014_operational_visibility', '015_canonical_usage_models', '016_supplier_monitoring', '017_supplier_key_cost_rules', '018_backfill_supplier_key_cost_links', '019_supplier_interval_seconds', '020_supplier_quality_monitoring', '021_qq_alert_notifications', '022_usage_cost_snapshot_performance', '023_incremental_cost_repricing', '024_account_profit_guard', '025_profit_guard_empty_group_default', '026_profit_guard_threshold_modes', '027_sub2api_service_auth', '028_sub2api_service_auth_api_key', '029_supplier_profit_guard_defaults', '030_profit_guard_auto_assignment', '031_oauth_supply_auth', '032_oauth_supply_replenishment', '033_replenishment_inventory_recovery', '034_replenishment_lifecycle', '035_replenishment_execution_logs', '036_supplier_refresh_token_auth', '037_replenishment_scheduling_recovery_policies', '038_replenishment_model_whitelist', '039_replenishment_recovery_completion', '040_replenishment_recovery_semantics', '041_replenishment_expiry_metadata_cleanup', '042_replenishment_expiry_metadata_guard', '043_replenishment_manual_compensation', '044_replenishment_remove_order_cooldown', '045_replenishment_manual_completion_guard', '046_replenishment_list_performance', '047_account_acquisition_accounting', '048_account_filter_dimensions', '049_replenishment_thresholds_and_schedule_interval', '050_replenishment_account_configuration', '051_replenishment_proxy_selection', '052_custom_account_cost_rule_time', '053_replenishment_trigger_strategy']],
  );
  if(migration.rowCount < 52)throw new Error('required FinOps migrations through 053_replenishment_trigger_strategy are not applied');
  const overviewMigration=await finopsPool.query(
    `SELECT 1 FROM "${config.finopsSchema}".schema_migrations WHERE version=$1`,
    ['054_overview_statistics_indexes'],
  );
  if(!overviewMigration.rowCount)throw new Error('required FinOps migration 054_overview_statistics_indexes is not applied');
  const sync=await repository.getSyncState();
  return {
    status:'ready',
    mode:'database',
    migrations:['002_cny_accounting','003_reconciliation_snapshots','004_cost_accounting_v2','005_cost_snapshot_ledger','006_group_monitoring','007_source_group_catalog','008_monitor_settings','009_monitor_ping_latency','010_multiplier_effective_history','011_backfill_current_day_multiplier_rules','012_cost_rule_archiving','013_audited_cost_repricing','014_operational_visibility','015_canonical_usage_models','016_supplier_monitoring','017_supplier_key_cost_rules','018_backfill_supplier_key_cost_links','019_supplier_interval_seconds','020_supplier_quality_monitoring','021_qq_alert_notifications','022_usage_cost_snapshot_performance','023_incremental_cost_repricing','024_account_profit_guard','025_profit_guard_empty_group_default','026_profit_guard_threshold_modes','027_sub2api_service_auth','028_sub2api_service_auth_api_key','029_supplier_profit_guard_defaults','030_profit_guard_auto_assignment','031_oauth_supply_auth','032_oauth_supply_replenishment','033_replenishment_inventory_recovery','034_replenishment_lifecycle','035_replenishment_execution_logs','036_supplier_refresh_token_auth','037_replenishment_scheduling_recovery_policies','038_replenishment_model_whitelist','039_replenishment_recovery_completion','040_replenishment_recovery_semantics','041_replenishment_expiry_metadata_cleanup','042_replenishment_expiry_metadata_guard','043_replenishment_manual_compensation','044_replenishment_remove_order_cooldown','045_replenishment_manual_completion_guard','046_replenishment_list_performance','047_account_acquisition_accounting','048_account_filter_dimensions','049_replenishment_thresholds_and_schedule_interval','050_replenishment_account_configuration','051_replenishment_proxy_selection','052_custom_account_cost_rule_time','053_replenishment_trigger_strategy'],
    syncStatus:sync.status,
    lastSuccessAt:sync.lastSuccessAt,
    sub2apiServiceAuth:sub2ApiServiceAuthService.status(),
    oauthSupplyAuth:oauthSupplyAuthService.status(),
  };
}

const server=http.createServer(async(request,res)=>{
  const started=Date.now();
  res.finopsAcceptEncoding=request.headers['accept-encoding']||'';
  try{
    const url=new URL(request.url,`http://${request.headers.host||'localhost'}`);
    if(url.pathname==='/health')return json(res,200,{status:'ok',mode:config.demoMode?'demo':config.usageDataMode,uptimeSeconds:Math.round(process.uptime()),cache:responseCache.status()});
    if(url.pathname==='/ready'){
      try{return json(res,200,await readiness());}
      catch(error){console.error('[ready]',error);return json(res,503,{status:'not_ready'});}
    }
    if(request.method==='POST'&&url.pathname==='/auth/login')return await login(request,res);
    if(request.method==='POST'&&url.pathname==='/auth/login/2fa')return await loginTwoFactor(request,res);
    if(request.method==='POST'&&url.pathname==='/auth/logout'){
      syncService?.clearSub2ApiAccessToken();
      sub2ApiReadonlyGateway.clearAccessToken();
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
  finally{
    const duration=Date.now()-started;
    const pathname=String(request.url||'').split('?')[0];
    if(config.nodeEnv==='development')console.info(`[http] ${request.method} ${pathname} ${res.statusCode} ${duration}ms`);
    else if(duration>=1_000)console.warn(`[slow-http] ${request.method} ${pathname} ${res.statusCode} ${duration}ms`);
  }
});

async function start(){
  if(!config.demoMode)await assertDistinctDatabases(sourcePool,finopsPool);
  sub2ApiServiceAuthService.start();
  if(syncService&&config.syncEnabled){await syncService.validateSourceSchema();syncService.start();}
  supplierMonitorService?.start();
  qqAlertNotificationService.start();
  server.listen(config.port,config.host,()=>console.log(`ApiStation FinOps listening on http://${config.host}:${config.port} (${config.demoMode?'demo':'database'} mode)`));
}
async function shutdown(signal){console.log(`${signal}: shutting down`);sub2ApiServiceAuthService.stop();syncService?.stop();supplierMonitorService?.stop();qqAlertNotificationService.stop();server.close(async()=>{await Promise.all([sourcePool?.end(),finopsPool?.end(),sub2ApiUsagePool?.end(),responseCache.close(),sub2ApiRedisRuntimeReader.close()]);process.exit(0);});setTimeout(()=>process.exit(1),10_000).unref();}
process.on('SIGINT',()=>shutdown('SIGINT'));process.on('SIGTERM',()=>shutdown('SIGTERM'));
await start();
