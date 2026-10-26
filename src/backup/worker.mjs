import http from 'node:http';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { normalizeBackupSettings, mergeBackupSecrets, resticEnvironment, backupError } from '../services/backup-policy.mjs';
import { resticStorageError } from './storage-errors.mjs';

const BASE = '/var/lib/finops-backup';
const STAGING = `${BASE}/staging/current`;
const SOCKET = process.env.BACKUP_SOURCE_SOCKET || '/run/source/export.sock';
const TOKEN = process.env.FINOPS_BACKUP_WORKER_TOKEN || '';
const jobs = new Map();
let busy = false;
process.umask(0o077);

function reply(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function authorized(request) {
  const actual = Buffer.from(String(request.headers.authorization || ''));
  const expected = Buffer.from(`Bearer ${TOKEN}`);
  return TOKEN.length >= 32 && actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw backupError('请求过大');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw backupError('请求格式错误'); }
}

function sourceRequest(route, signal) {
  return new Promise((resolve, reject) => {
    const request = http.get({ socketPath: SOCKET, path: route, signal }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(backupError('只读源检查失败，请检查未知表、外键依赖及导出器状态', 503));
      } else resolve(response);
    });
    request.on('error', () => reject(backupError('只读导出器不可用', 503)));
  });
}

async function sourceInspection() {
  const response = await sourceRequest('/inspect', AbortSignal.timeout(30000));
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > 262144) throw backupError('源检查响应过大', 502);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

function restic(args, settings, secrets, signal, progress) {
  return new Promise((resolve, reject) => {
    const child = spawn('restic', ['--limit-upload', String(settings.uploadLimitKiB), ...args], {
      env: resticEnvironment(settings, secrets), stdio: ['ignore', 'pipe', 'pipe'], signal,
    });
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let output = '';
    let summary = null;
    let overflow = false;
    let diagnostic = '';
    child.stdout.on('data', (chunk) => {
      if (!progress) {
        output += chunk.toString();
        if (output.length > 8 * 1024 * 1024) { overflow = true; child.kill(); }
        return;
      }
      pending += decoder.write(chunk);
      if (pending.length > 1024 * 1024) { overflow = true; child.kill(); return; }
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        try {
          const event = JSON.parse(line);
          if (event.message_type === 'summary') summary = event;
          if (event.message_type === 'status') progress(event);
        } catch { /* Never return CLI output or file contents to the web process. */ }
      }
    });
    child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-65536); });
    child.on('error', () => reject(backupError('备份工具启动失败或任务超时', 503)));
    child.on('close', (code) => {
      if (code !== 0 || overflow) return reject(resticStorageError(code, diagnostic, overflow));
      resolve(progress ? summary : output);
    });
  });
}

const RESTORE = `# Sub2API data-only backup

This package contains sensitive account credentials and user data. Keep it private.
It contains PostgreSQL public business DATA ONLY, not DDL, indexes, FinOps or Redis.
Most usage/operational logs are intentionally excluded; referenced billing usage is included.

1. Use an ISOLATED PostgreSQL 15 instance and an EMPTY database with the matching DDL.
   Never run these commands against the production database. Do not start the app.
2. Extract this tar package and run: sha256sum -c SHA256SUMS
3. Check manifest.json (source time, table counts, schema fingerprint, excluded tables).
4. Import with a destination-only administrator, in ONE transaction:

   psql "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction \\
     -c "SET LOCAL session_replication_role=replica" -f data.sql -f validate.sql

   Only this isolated target temporarily bypasses triggers/foreign-key triggers.
   validate.sql explicitly checks foreign keys before commit. Any failure rolls back.
   COPY enforces existing unique/not-null/check constraints; use an empty target.
   Sequence floors in data.sql avoid reusing restored IDs.
5. Independently verify table row counts against manifest.json, balances, orders,
   and application compatibility. Hash validation is NOT a restore drill.

No production connection or FinOps database is required for these steps.
You must separately retain the matching DDL, external app config/encryption keys,
and the Restic repository password. Lost passwords cannot be recovered by FinOps.

Alternative without FinOps: install Restic, configure RESTIC_REPOSITORY,
AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION, RESTIC_PASSWORD;
run 'restic snapshots --tag finops-sub2api', then 'restic restore SNAPSHOT --target ./restore'.
Do not configure age-based object deletion on the backup bucket. Shared old blocks
may still be required by new snapshots. Only Restic retention/prune may remove them.
`;

async function persist(item) {
  const destination = `${BASE}/jobs/${item.id}.json`;
  await fs.writeFile(`${destination}.tmp`, JSON.stringify(item));
  await fs.rename(`${destination}.tmp`, destination);
}

async function exportSource(item, signal) {
  const response = await sourceRequest('/export', signal);
  const hash = createHash('sha256');
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let tail = '';
  let metadata;
  let table;
  let bytes = 0;
  const counts = {};
  const transform = new Transform({
    transform(chunk, encoding, callback) {
      try {
        hash.update(chunk);
        bytes += chunk.length;
        item.progress = { ...item.progress, phase: 'exporting', readBytes: bytes };
        pending += decoder.write(chunk);
        if (pending.length > 32 * 1024 * 1024) throw new Error('unsupported oversized source row');
        let index;
        while ((index = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, index);
          pending = pending.slice(index + 1);
          if (!metadata) {
            if (!line.startsWith('-- FINOPS_BACKUP_METADATA ')) throw new Error('missing source metadata');
            metadata = JSON.parse(line.slice('-- FINOPS_BACKUP_METADATA '.length));
            if (!metadata.allowed || metadata.profile !== 'sub2api-core-v1' || !/^[a-f0-9]{32}$/.test(metadata.nonce)) throw new Error('invalid source metadata');
          } else if (table) {
            if (line === '\\.') table = null;
            else counts[table] += 1;
          } else {
            const match = /^COPY public\.(?:"([^"]+)"|([a-z_][a-z0-9_]*)) /.exec(line);
            if (match) { table = match[1] || match[2]; counts[table] = 0; }
          }
          tail = line;
        }
        callback(null, chunk);
      } catch { callback(backupError('导出数据格式或完整性检查失败', 502)); }
    },
  });
  await pipeline(response, transform, createWriteStream(`${STAGING}/data.sql`, { mode: 0o600 }), { signal });
  if (!metadata || pending || table || tail !== `-- FINOPS_EXPORT_COMPLETE ${metadata.nonce}`
    || [...metadata.included, 'usage_logs'].some((name) => counts[name] === undefined)) {
    throw backupError('源导出未完整结束，未创建新的云端恢复点', 502);
  }
  const validate = metadata.validationSql;
  delete metadata.validationSql;
  delete metadata.nonce;
  const checksum = hash.digest('hex');
  await fs.writeFile(`${STAGING}/manifest.json`, JSON.stringify({ ...metadata, complete: true, dataSha256: checksum, dataBytes: bytes, rowCounts: counts }, null, 2) + '\n');
  await fs.writeFile(`${STAGING}/validate.sql`, validate);
  await fs.writeFile(`${STAGING}/RESTORE.md`, RESTORE);
  let sums = `${checksum}  data.sql\n`;
  for (const name of ['manifest.json', 'validate.sql', 'RESTORE.md']) {
    sums += `${createHash('sha256').update(await fs.readFile(`${STAGING}/${name}`)).digest('hex')}  ${name}\n`;
  }
  await fs.writeFile(`${STAGING}/SHA256SUMS`, sums);
  return metadata;
}

async function runJob(item, settings, secrets) {
  const signal = AbortSignal.timeout(settings.timeoutMinutes * 60000);
  try {
    await fs.mkdir(STAGING, { recursive: true, mode: 0o700 });
    await fs.rm(STAGING, { recursive: true, force: true });
    await fs.mkdir(STAGING, { mode: 0o700 });
    item.status = 'running';
    await persist(item);
    await restic(['cat', 'config'], settings, secrets, signal);
    const source = await exportSource(item, signal);
    item.progress = { ...item.progress, phase: 'uploading', sourceAt: source.snapshotAt, schemaFingerprint: source.schemaFingerprint };
    const summary = await restic(['backup', '--json', '--force', '--host', 'sub2api',
      '--tag', 'finops-sub2api', '--tag', `schema:${source.schemaFingerprint}`,
      '--tag', `source-at:${source.snapshotAt}`, STAGING], settings, secrets, signal, (event) => {
      item.progress = { ...item.progress, bytesDone: event.bytes_done, totalBytes: event.total_bytes };
    });
    if (!summary || !/^[a-f0-9]{8,64}$/.test(summary.snapshot_id || '')) throw backupError('未取得已提交的云端快照，不能确认备份成功', 502);
    const all = JSON.parse(await restic(['snapshots', '--json', '--host', 'sub2api', '--tag', 'finops-sub2api'], settings, secrets, signal));
    const committed = all.find((entry) => entry.id.startsWith(summary.snapshot_id));
    if (!committed) throw backupError('无法从云端确认刚完成的快照', 502);
    item.progress = { ...item.progress, phase: 'checking', snapshotId: committed.id, addedBytes: summary.data_added, processedBytes: summary.total_bytes_processed };
    await restic(['check'], settings, secrets, signal);
    item.status = 'completed';
    item.progress.phase = 'completed';
    if (settings.autoPrune) {
      try {
        await restic(['forget', '--host', 'sub2api', '--tag', 'finops-sub2api', '--group-by', 'host',
          '--keep-hourly', String(settings.keepHourly), '--keep-daily', String(settings.keepDaily),
          '--keep-weekly', String(settings.keepWeekly), '--prune'], settings, secrets, signal);
      } catch { item.progress.warning = '备份和仓库检查已完成，但旧数据清理失败；未自动解锁或强制删除'; }
    }
  } catch (error) {
    item.status = 'failed';
    item.error = error.statusCode ? error.message : '任务中断或超时，不能确认备份完成；请检查云端恢复点';
    item.progress.phase = 'failed';
  } finally {
    item.completedAt = new Date().toISOString();
    try { await persist(item); } finally {
      await fs.rm(STAGING, { recursive: true, force: true }).catch(() => {});
      busy = false;
    }
  }
}

async function download(input, settings, secrets, res) {
  if (!/^[a-f0-9]{64}$/.test(input.id || '')) throw backupError('恢复点 ID 错误');
  const signal = AbortSignal.timeout(7200000);
  const snapshots = JSON.parse(await restic(['snapshots', '--json', '--host', 'sub2api', '--tag', 'finops-sub2api'], settings, secrets, signal));
  if (!snapshots.some((entry) => entry.id === input.id && entry.paths?.includes(STAGING))) throw backupError('当前仓库中没有该恢复点', 404);
  const child = spawn('restic', ['dump', '--archive', 'tar', input.id, STAGING], { env: resticEnvironment(settings, secrets), stdio: ['ignore', 'pipe', 'pipe'], signal });
  child.stderr.resume();
  let started = false;
  child.stdout.once('data', () => { started = true; res.writeHead(200, { 'Content-Type': 'application/x-tar', 'Cache-Control': 'no-store' }); });
  const result = new Promise((resolve, reject) => {
    child.on('error', () => reject(backupError('导出工具不可用', 503)));
    child.on('close', (code) => code === 0 ? resolve() : reject(backupError('导出失败或中断，请重新下载并校验文件', 502)));
  });
  res.once('close', () => child.kill());
  child.stdout.pipe(res, { end: false });
  try {
    await result;
    if (!started) throw backupError('导出文件为空', 502);
    res.end();
  } catch (error) {
    if (started) res.destroy();
    else throw error;
  }
}

await fs.mkdir(`${BASE}/jobs`, { recursive: true, mode: 0o700 });
await fs.rm(STAGING, { recursive: true, force: true });
for (const name of (await fs.readdir(`${BASE}/jobs`)).filter((name) => /^[a-f0-9-]+\.json$/.test(name))) {
  const item = JSON.parse(await fs.readFile(path.join(BASE, 'jobs', name), 'utf8'));
  if (['queued', 'running'].includes(item.status)) {
    Object.assign(item, { status: 'failed', error: '执行器重启，任务结果未确认；请检查云端恢复点', completedAt: new Date().toISOString() });
    await persist(item);
  }
  jobs.set(item.id, item);
}

const server = http.createServer(async (request, res) => {
  if (request.url === '/health' && request.method === 'GET') return reply(res, 200, { status: 'ok', busy });
  if (!authorized(request)) return reply(res, 401, { error: 'unauthorized' });
  let ownsLock = false;
  try {
    if (request.method !== 'POST') throw backupError('method not allowed');
    const input = await body(request);
    if (request.url === '/job-status') {
      const item = jobs.get(input.id);
      if (!item) return reply(res, 404, { error: '任务不存在' });
      return reply(res, 200, item);
    }
    if (busy) throw backupError('执行器正在备份或导出，请稍后重试', 409);
    busy = true;
    ownsLock = true;
    if (request.url === '/source') return reply(res, 200, await sourceInspection());
    const settings = normalizeBackupSettings(input.settings);
    const secrets = mergeBackupSecrets(input.secrets || {});
    const signal = AbortSignal.timeout(30000);
    if (request.url === '/storage/test') {
      await restic(['cat', 'config'], settings, secrets, signal);
      return reply(res, 200, { ok: true, message: '已连接加密仓库；此检查没有恢复数据库' });
    }
    if (request.url === '/storage/init') {
      await restic(['init'], settings, secrets, signal);
      return reply(res, 200, { ok: true, message: '专用加密仓库已初始化，请独立保存密码' });
    }
    if (request.url === '/snapshots') {
      const snapshots = JSON.parse(await restic(['snapshots', '--json', '--host', 'sub2api', '--tag', 'finops-sub2api'], settings, secrets, signal));
      return reply(res, 200, { items: snapshots.map((item) => ({ id: item.id, time: item.time,
        sourceAt: item.tags?.find((tag) => tag.startsWith('source-at:'))?.slice(10) || null,
        schemaFingerprint: item.tags?.find((tag) => tag.startsWith('schema:'))?.slice(7) || '',
      })).sort((a, b) => b.time.localeCompare(a.time)) });
    }
    if (request.url === '/download') return await download(input, settings, secrets, res);
    if (request.url === '/jobs') {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.id || '')) throw backupError('任务 ID 错误');
      if (jobs.has(input.id)) throw backupError('该任务已提交', 409);
      const item = { id: input.id, status: 'queued', progress: { phase: 'queued' }, error: '', createdAt: new Date().toISOString() };
      await persist(item);
      jobs.set(item.id, item);
      ownsLock = false;
      void runJob(item, settings, secrets).catch(() => { busy = false; });
      return reply(res, 202, item);
    }
    throw backupError('endpoint not found', 404);
  } catch (error) {
    if (!res.headersSent) reply(res, error.statusCode || 500, { error: error.statusCode ? error.message : '备份执行器内部错误' });
    else res.destroy();
  } finally { if (ownsLock) busy = false; }
});
server.requestTimeout = 30000;
server.listen(8093, '0.0.0.0');
