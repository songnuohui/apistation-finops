// Opt-in Linux fixture: synthetic data, loopback storage, no source DB or cloud.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { restic, RESTIC_TEMP_ROOT } from '../src/backup/restic.mjs';
import { BACKUP_DEFAULTS } from '../src/services/backup-policy.mjs';

const root = await fs.mkdtemp('/var/lib/finops-backup/pack-fixture-');
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.some((part) => !/^[a-z0-9-]+$/.test(part))) { response.writeHead(400).end(); return; }
  const target = path.join(root, 'repo', ...parts);
  try {
    if (request.method === 'POST') {
      if (url.searchParams.has('create')) {
        await fs.mkdir(target, { recursive: true }); request.resume(); response.end(); return;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await pipeline(request, createWriteStream(target));
      // Slow storage keeps multiple encrypted packs in flight, as in production.
      if (parts[0] === 'data') await new Promise((resolve) => setTimeout(resolve, 12000));
      response.end();
    } else if (request.method === 'DELETE') {
      await fs.unlink(target); response.end();
    } else if (url.pathname.endsWith('/')) {
      const names = await fs.readdir(target).catch(() => []);
      const entries = await Promise.all(names.map(async (name) => ({ name, size: (await fs.stat(path.join(target, name))).size })));
      response.writeHead(200, { 'Content-Type': 'application/vnd.x.restic.rest.v2' }).end(JSON.stringify(entries));
    } else {
      const stat = await fs.stat(target);
      if (request.method === 'HEAD') { response.writeHead(200, { 'Content-Length': stat.size }).end(); return; }
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Number(range[2]) : stat.size - 1;
      response.writeHead(range ? 206 : 200, { 'Content-Length': end - start + 1 });
      await pipeline(createReadStream(target, { start, end }), response);
    }
  } catch (error) {
    if (!response.headersSent) response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
    else response.destroy();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const settings = { ...BACKUP_DEFAULTS, bucket: 'synthetic-fixture', uploadLimitKiB: 102400 };
const secrets = { accessKey: 'synthetic-ak', secretKey: 'synthetic-sk', password: 'synthetic-fixture-password' };
const options = { tempRoot: `${root}/tmp`, spawnProcess(command, args, config) {
  return spawn(command, args, { ...config, env: { ...config.env,
    RESTIC_REPOSITORY: `rest:http://127.0.0.1:${server.address().port}/`, RESTIC_CACHE_DIR: `${root}/cache`,
  } });
} };
const signal = AbortSignal.timeout(180000);
try {
  assert.equal((await fs.statfs('/tmp')).type, 0x01021994, 'Run with a 64 MiB /tmp tmpfs');
  const tmpfs = await fs.statfs('/tmp');
  assert.equal(tmpfs.blocks * tmpfs.bsize, 64 * 1024 * 1024);
  assert.notEqual((await fs.statfs('/var/lib/finops-backup')).type, tmpfs.type);
  await pipeline(Readable.from((function* () {
    for (let i = 0; i < 192; i++) yield randomBytes(1024 * 1024);
  })()), createWriteStream(`${root}/synthetic.bin`));
  await restic(['init'], settings, secrets, signal, undefined, options);
  const args = ['backup', '--json', '--force', `${root}/synthetic.bin`];
  await assert.rejects(restic(args, settings, secrets, signal, () => {}, { ...options, tempRoot: '/tmp' }), /本地临时空间不足/);
  console.log('PASS: 64 MiB tmpfs reproduces upload failure and classifies stdout fatal JSON');
  // Exercise the production default, not just the test override.
  const { tempRoot, ...diskOptions } = options;
  const summary = await restic(args, settings, secrets, signal, () => {}, diskOptions);
  assert.equal(summary.total_bytes_processed, 192 * 1024 * 1024);
  assert.match(summary.snapshot_id, /^[a-f0-9]{8,64}$/);
  await restic(['check'], settings, secrets, signal, undefined, diskOptions);
  const snapshots = JSON.parse(await restic(['snapshots', '--json'], settings, secrets, signal, undefined, diskOptions));
  assert.equal(snapshots.length, 1);
  assert.ok(snapshots[0].id.startsWith(summary.snapshot_id));
  assert.deepEqual(await fs.readdir(RESTIC_TEMP_ROOT), []);
  console.log('PASS: 192 MiB backup, committed snapshot, repository check and temp cleanup with disk staging');
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
