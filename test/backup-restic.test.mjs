import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { restic, RESTIC_TEMP_ROOT } from '../src/backup/restic.mjs';
import { BACKUP_DEFAULTS } from '../src/services/backup-policy.mjs';

const settings = { ...BACKUP_DEFAULTS, bucket: 'synthetic-fixture' };
const secrets = { accessKey: 'synthetic-ak', secretKey: 'synthetic-sk', password: 'synthetic-repository-password' };

async function fixture(t, program) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'finops-restic-test-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  let directory;
  const options = { tempRoot, spawnProcess(command, args, config) {
    assert.equal(command, 'restic');
    assert.deepEqual(args.slice(0, 2), ['--limit-upload', String(settings.uploadLimitKiB)]);
    for (const secret of Object.values(secrets)) assert.ok(!args.includes(secret));
    directory = config.env.TMPDIR;
    assert.equal(path.dirname(directory), tempRoot);
    assert.ok(existsSync(directory));
    return spawn(process.execPath, ['--input-type=module', '-e', program], config);
  } };
  return { options, directory: () => directory, async assertClean() {
    assert.deepEqual(await fs.readdir(tempRoot), []);
  } };
}

test('Restic uses private disk-backed pack staging and accepts a final JSON line without a newline', async (t) => {
  assert.equal(RESTIC_TEMP_ROOT, '/var/lib/finops-backup/tmp');
  const value = await fixture(t, String.raw`
    import fs from 'node:fs/promises';
    await fs.writeFile(process.env.TMPDIR + '/restic-temp-pack', 'synthetic-pack');
    process.stdout.write(JSON.stringify({message_type:'status', bytes_done:42}) + '\n');
    process.stdout.write(JSON.stringify({message_type:'summary', snapshot_id:'abc12345', data_added:13000000, data_added_packed:700000}));
  `);
  const statuses = [];
  const summary = await restic(['backup', '--json'], settings, secrets, undefined, (event) => statuses.push(event), value.options);
  assert.equal(summary.snapshot_id, 'abc12345');
  assert.equal(summary.data_added, 13000000);
  assert.equal(summary.data_added_packed, 700000);
  assert.equal(statuses[0].bytes_done, 42);
  await value.assertClean();
});

test('JSON stdout fatal disk errors are classified without leaking diagnostics and clean up temporary packs', async (t) => {
  const value = await fixture(t, `
    import fs from 'node:fs/promises';
    await fs.writeFile(process.env.TMPDIR + '/restic-temp-pack', 'synthetic-pack');
    process.stdout.write(JSON.stringify({message_type:'exit_error', code:1,
      message:'Fatal: write /private/user-row-secret: no space left on device'}));
    process.exitCode = 1;
  `);
  await assert.rejects(restic(['backup', '--json'], settings, secrets, undefined, () => {}, value.options), (error) => {
    assert.equal(error.statusCode, 502);
    assert.match(error.message, /本地临时空间不足/);
    assert.doesNotMatch(error.message, /user-row-secret|七牛认证|Access Key/);
    return true;
  });
  await value.assertClean();
});

test('non-progress commands classify stderr disk quota failures and also clean temporary files', async (t) => {
  const value = await fixture(t, "process.stderr.write('disk quota exceeded secret-do-not-return'); process.exitCode = 1;");
  await assert.rejects(restic(['check'], settings, secrets, undefined, undefined, value.options), /本地临时空间不足/);
  await value.assertClean();
});

test('a fatal JSON event cannot report success even if the process exits zero', async (t) => {
  const value = await fixture(t, "process.stdout.write(JSON.stringify({message_type:'exit_error', message:'ENOSPC'}));");
  await assert.rejects(restic(['backup', '--json'], settings, secrets, undefined, () => {}, value.options), /本地临时空间不足/);
  await value.assertClean();
});

test('missing executables and aborted commands clean up only after the child closes', async (t) => {
  const missing = await fixture(t, '');
  missing.options.spawnProcess = (_command, _args, config) => spawn(path.join(missing.options.tempRoot, 'missing-restic'), [], config);
  await assert.rejects(restic(['check'], settings, secrets, undefined, undefined, missing.options), /启动失败或任务超时/);
  await missing.assertClean();

  const controller = new AbortController();
  const aborted = await fixture(t, "process.stdout.write('started'); setInterval(() => {}, 1000);");
  const spawnProcess = aborted.options.spawnProcess;
  let closedWithDirectoryPresent = false;
  aborted.options.spawnProcess = (...args) => {
    const child = spawnProcess(...args);
    child.stdout.once('data', () => controller.abort());
    child.once('close', () => { closedWithDirectoryPresent = existsSync(aborted.directory()); });
    return child;
  };
  await assert.rejects(restic(['check'], settings, secrets, controller.signal, undefined, aborted.options), /启动失败或任务超时/);
  assert.equal(closedWithDirectoryPresent, true);
  await aborted.assertClean();
});
