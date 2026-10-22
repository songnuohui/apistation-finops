import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_DEFAULTS, normalizeBackupSettings, mergeBackupSecrets, resticEnvironment } from '../src/services/backup-policy.mjs';
import { BackupRepository } from '../src/repositories/backup-repository.mjs';
import { BackupService } from '../src/services/backup-service.mjs';

const key = 'ab'.repeat(32);
function setup() {
  const repository = new BackupRepository(null, { finopsSchema: 'finops' });
  const service = new BackupService(repository, { backupCredentialsKey: key });
  return { service, repository };
}
const credentials = { accessKey: 'example-access-key', secretKey: 'example-secret-key', password: 'example-strong-repository-password' };

test('backup defaults are opt-in and data-source configuration is not accepted', () => {
  const value = normalizeBackupSettings({ sourceDatabaseUrl: 'postgres://unsafe', sql: 'DROP TABLE users', restoreTarget: 'production' });
  assert.equal(value.enabled, false);
  assert.equal(value.autoPrune, false);
  assert.equal(value.intervalMinutes, 60);
  assert.equal(value.sourceDatabaseUrl, undefined);
  assert.equal(value.sql, undefined);
  assert.equal(value.restoreTarget, undefined);
});

test('backup repository endpoints reject SSRF, credentials, alternate ports and mismatched regions', () => {
  for (const endpoint of ['http://127.0.0.1', 'https://s3-cn-east-1.qiniucs.com.evil.test', 'https://user:pass@s3-cn-east-1.qiniucs.com', 'https://s3-cn-east-1.qiniucs.com:8443', 'https://s3-cn-east-1.qiniucs.com/path', 'https://s3-cn-north-1.qiniucs.com']) {
    assert.throws(() => normalizeBackupSettings({ endpoint }));
  }
  assert.equal(normalizeBackupSettings({ endpoint: 'https://s3-cn-north-1.qiniucs.com', region: 'cn-north-1' }).region, 'cn-north-1');
  for (const prefix of ['', '/root', '../other', 'shared//data', 'x/']) assert.throws(() => normalizeBackupSettings({ prefix }));
  for (const intervalMinutes of [0, 1, 14, 1.5, '60', 10081]) assert.throws(() => normalizeBackupSettings({ intervalMinutes }));
  assert.throws(() => normalizeBackupSettings({ enabled: 'false' }));
});

test('secrets preserve blanks, reject control characters and are not passed in process arguments', () => {
  assert.deepEqual(mergeBackupSecrets({ accessKey: '', password: '' }, credentials), credentials);
  assert.throws(() => mergeBackupSecrets({ password: 'short' }));
  assert.throws(() => mergeBackupSecrets({ secretKey: 'bad\nvalue' }));
  assert.throws(() => mergeBackupSecrets(null));
  const env = resticEnvironment({ ...BACKUP_DEFAULTS, bucket: 'test-bucket' }, credentials, { PATH: '/bin', UNRELATED_SECRET: 'must-not-leak' });
  assert.equal(env.RESTIC_PASSWORD, credentials.password);
  assert.equal(env.UNRELATED_SECRET, undefined);
  assert.equal(env.RESTIC_REPOSITORY, 's3:https://s3-cn-east-1.qiniucs.com/test-bucket/sub2api-backup');
});

test('settings encrypt all secrets at rest and never return them to the browser', async () => {
  const { service, repository } = setup();
  const value = await service.save({ bucket: 'test-bucket', ...credentials }, 'test-admin');
  for (const secret of Object.values(credentials)) {
    assert.ok(!JSON.stringify(await repository.settings()).includes(secret));
    assert.ok(!JSON.stringify(value).includes(secret));
  }
  assert.equal(value.enabled, false);
  assert.equal(value.passwordConfigured, true);
  assert.equal(value.accessKey, undefined);
  assert.equal(value.password, undefined);
  await service.save({ secretKey: '' }, 'test-admin');
  assert.deepEqual((await service.context()).secrets, credentials);
  await assert.rejects(service.save({ password: 'replacement-password-123456' }, 'test-admin'), /密码不能直接更改/);
  await assert.rejects(service.save({ prefix: 'another-repository' }, 'test-admin'), /明确确认/);
  await service.save({ prefix: 'another-repository', password: 'replacement-password-123456', confirmRepositoryChange: true }, 'test-admin');
});

test('cannot enable a backup or run one without a configured worker/repository', async () => {
  const { service } = setup();
  await assert.rejects(service.run('test-admin'), /先保存/);
  await service.save({ bucket: 'test-bucket', ...credentials }, 'test-admin');
  await assert.rejects(service.save({ enabled: true }, 'test-admin'), /执行器尚未配置/);
  assert.equal((await service.status()).enabled, false);
});

test('active tasks block configuration changes and duplicate task creation', async () => {
  const { service, repository } = setup();
  await service.save({ bucket: 'test-bucket', ...credentials }, 'test-admin');
  const item = await repository.create('manual', 'test-admin');
  await assert.rejects(repository.create('manual', 'other-admin'), /已有备份/);
  await assert.rejects(service.save({ intervalMinutes: 30 }, 'test-admin'), /任务执行期间/);
  await assert.rejects(service.action('init', { confirm: true }), /等待当前备份/);
  await repository.update(item.id, { status: 'completed', progress: {}, completedAt: new Date().toISOString() });
  assert.equal(await repository.active(), null);
});

test('scheduler polls existing tasks and never starts source work by default', async () => {
  const { service, repository } = setup();
  let calls = 0;
  service.request = async () => { calls++; return { status: 'completed', progress: { sourceAt: '2026-10-22T00:00:00Z' } }; };
  await service.tick();
  assert.equal(calls, 0);
  const item = await repository.create('manual', 'test-admin');
  await service.tick();
  assert.equal((await repository.list())[0].status, 'completed');
  assert.equal((await repository.list())[0].id, item.id);
  assert.equal(calls, 1);
});

test('source inspection needs no cloud credentials; init and downloads are guarded', async () => {
  const { service } = setup();
  service.request = async (route) => ({ route });
  assert.equal((await service.action('source')).route, '/source');
  await assert.rejects(service.action('restore'), /先保存/);
  await service.save({ bucket: 'test-bucket', ...credentials }, 'test-admin');
  await assert.rejects(service.action('init'), /确认初始化/);
  assert.equal((await service.action('init', { confirm: true })).route, '/storage/init');
  await assert.rejects(service.download('../production', {}), /恢复点 ID/);
});

test('configuration updates and task submission cannot overlap across awaited I/O', async () => {
  const { service, repository } = setup();
  await service.save({ bucket: 'test-bucket', ...credentials }, 'test-admin');
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const active = repository.active.bind(repository);
  repository.active = async () => { await waiting; return active(); };
  const saving = service.save({ intervalMinutes: 30 }, 'test-admin');
  await assert.rejects(service.run('test-admin'), /备份操作进行中/);
  await assert.rejects(service.save({ intervalMinutes: 90 }, 'test-admin'), /备份操作进行中/);
  release();
  await saving;
  service.request = async () => { await waiting; return {}; };
  const running = service.run('test-admin');
  await assert.rejects(service.save({ intervalMinutes: 90 }, 'test-admin'), /备份操作进行中/);
  await running;
  assert.equal((await repository.list()).length, 1);
  assert.equal((await service.status()).intervalMinutes, 30);
});
