import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SupplierCredentialVault } from './supplier-credentials.mjs';
import {
  normalizeBackupSettings, mergeBackupSecrets, assertBackupConfigured,
  publicBackupSettings, repositoryId, backupError,
} from './backup-policy.mjs';

export class BackupService {
  constructor(repository, config) {
    this.repository = repository;
    this.config = config;
    this.vault = new SupplierCredentialVault(config.backupCredentialsKey);
    this.ticking = false;
    this.changing = false;
  }

  async context() {
    const value = await this.repository.settings();
    return { ...value, secrets: value.encrypted ? this.vault.decrypt(value.encrypted) : {} };
  }

  async status() {
    const value = await this.context();
    return {
      ...publicBackupSettings(value.settings, value.secrets), nextRunAt: value.nextRunAt,
      encryptionReady: this.vault.available,
      workerConfigured: Boolean(this.config.backupWorkerUrl && this.config.backupWorkerToken),
      sourceReadonly: true, scope: 'sub2api-core-v1', updatedBy: value.updatedBy,
    };
  }

  async save(input, actor) {
    if (this.changing) throw backupError('备份操作进行中，请稍后重试', 409);
    this.changing = true;
    try {
      if (await this.repository.active()) throw backupError('任务执行期间不能修改备份配置', 409);
      const previous = await this.context();
      const settings = normalizeBackupSettings(input, previous.settings);
      const secrets = mergeBackupSecrets(input, previous.secrets);
      const changedRepository = repositoryId(previous.settings) !== repositoryId(settings);
      if (changedRepository && previous.settings.bucket && input.confirmRepositoryChange !== true) throw backupError('更换仓库需要明确确认；旧仓库不会被删除');
      if (input.password && previous.secrets.password && input.password !== previous.secrets.password
        && !changedRepository) throw backupError('已有仓库密码不能直接更改；请保留原密码，或改用新的专用仓库目录');
      if (settings.enabled) {
        assertBackupConfigured(settings, secrets);
        await this.request('/storage/test', { settings, secrets });
      }
      const encrypted = Object.keys(secrets).length ? this.vault.encrypt(secrets) : '';
      await this.repository.save(settings, encrypted, actor);
      return this.status();
    } finally { this.changing = false; }
  }

  async request(path, payload, { timeout = 30000, stream = false } = {}) {
    if (!this.config.backupWorkerUrl || !this.config.backupWorkerToken) throw backupError('备份执行器尚未配置', 503);
    let response;
    try {
      response = await fetch(`${this.config.backupWorkerUrl}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.backupWorkerToken}` },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(timeout), redirect: 'error',
      });
    } catch { throw backupError('备份执行器暂不可用，请稍后重试', 503); }
    if (!response.ok) {
      const value = await response.json().catch(() => ({}));
      throw backupError(value.error || '备份执行失败', [400, 404, 409, 503].includes(response.status) ? response.status : 502);
    }
    return stream ? response : response.json();
  }

  async action(action, input = {}) {
    if (this.changing) throw backupError('备份操作进行中，请稍后重试', 409);
    this.changing = true;
    try {
      if (await this.repository.active()) throw backupError('请等待当前备份任务结束', 409);
      const { settings, secrets } = await this.context();
      if (action !== 'source') assertBackupConfigured(settings, secrets);
      if (action === 'init' && input.confirm !== true) throw backupError('请确认初始化专用空仓库');
      const paths = { source: '/source', test: '/storage/test', init: '/storage/init', snapshots: '/snapshots' };
      if (!paths[action]) throw backupError('无效备份操作');
      return await this.request(paths[action], { settings, secrets });
    } finally { this.changing = false; }
  }

  async run(actor, kind = 'manual') {
    if (this.changing) throw backupError('备份操作进行中，请稍后重试', 409);
    this.changing = true;
    try {
      const { settings, secrets } = await this.context();
      assertBackupConfigured(settings, secrets);
      const item = await this.repository.create(kind, actor);
      try {
        await this.request('/jobs', { id: item.id, settings, secrets });
        await this.repository.postpone(settings.intervalMinutes);
        return item;
      } catch (error) {
        await this.repository.update(item.id, { status: 'failed', error: error.message });
        throw error;
      }
    } finally { this.changing = false; }
  }

  async download(id, res) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw backupError('恢复点 ID 错误');
    if (this.changing) throw backupError('备份操作进行中，请稍后重试', 409);
    this.changing = true;
    try {
      if (await this.repository.active()) throw backupError('请等待备份完成后再导出', 409);
      const { settings, secrets } = await this.context();
      assertBackupConfigured(settings, secrets);
      const upstream = await this.request('/download', { id, settings, secrets }, { timeout: 7200000, stream: true });
      res.writeHead(200, { 'Content-Type': 'application/x-tar', 'Content-Disposition': `attachment; filename="sub2api-${id.slice(0, 12)}.tar"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      await pipeline(Readable.fromWeb(upstream.body), res);
    } finally { this.changing = false; }
  }

  async tick() {
    if (this.ticking || this.changing) return;
    this.ticking = true;
    try {
      const active = await this.repository.active();
      if (active) {
        try {
          const result = await this.request('/job-status', { id: active.id });
          await this.repository.update(active.id, result);
        } catch (error) {
          if (error.statusCode === 404) await this.repository.update(active.id, { status: 'failed', error: '执行器中未找到该任务，不能确认上传完成，请检查云端恢复点' });
        }
        return;
      }
      const { settings, nextRunAt } = await this.repository.settings();
      if (!settings.enabled || !nextRunAt || Date.now() < new Date(nextRunAt).getTime()) return;
      await this.repository.postpone(settings.intervalMinutes);
      await this.run('scheduler', 'scheduled');
    } catch { /* Failed tasks remain visible; a disabled/unavailable backup never stops FinOps. */ }
    finally { this.ticking = false; }
  }

  start() { this.timer = setInterval(() => void this.tick(), 5000); this.timer.unref(); void this.tick(); }
  stop() { clearInterval(this.timer); }
}
