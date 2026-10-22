import { randomUUID } from 'node:crypto';
import { BACKUP_DEFAULTS, backupError } from '../services/backup-policy.mjs';

function job(row) {
  if (!row) return null;
  return {
    id: row.id, kind: row.kind, status: row.status, progress: row.progress || {},
    error: row.error_message || '', createdBy: row.created_by || '',
    createdAt: row.created_at, completedAt: row.completed_at,
  };
}

export class BackupRepository {
  constructor(pool, config) {
    this.pool = pool;
    this.schema = `"${config.finopsSchema}"`;
    this.memory = { settings: {}, credentials_encrypted: '', next_run_at: null };
    this.jobs = [];
  }

  async settings() {
    const row = this.pool
      ? (await this.pool.query(`SELECT * FROM ${this.schema}.backup_settings WHERE id=1`)).rows[0]
      : this.memory;
    return { settings: { ...BACKUP_DEFAULTS, ...row?.settings }, encrypted: row?.credentials_encrypted || '', nextRunAt: row?.next_run_at || null, updatedBy: row?.updated_by || '' };
  }

  async save(settings, encrypted, actor) {
    if (!this.pool) {
      Object.assign(this.memory, { settings, credentials_encrypted: encrypted, updated_by: actor, next_run_at: settings.enabled ? new Date(Date.now() + settings.intervalMinutes * 60000).toISOString() : null });
      return;
    }
    await this.pool.query(`UPDATE ${this.schema}.backup_settings SET settings=$1, credentials_encrypted=$2,
      next_run_at=CASE WHEN $3 THEN NOW()+($4 * INTERVAL '1 minute') ELSE NULL END,
      updated_by=$5, updated_at=NOW() WHERE id=1`, [settings, encrypted, settings.enabled, settings.intervalMinutes, actor]);
  }

  async list() {
    if (!this.pool) return this.jobs.slice(0, 100);
    return (await this.pool.query(`SELECT * FROM ${this.schema}.backup_jobs ORDER BY created_at DESC LIMIT 100`)).rows.map(job);
  }

  async active() {
    if (!this.pool) return this.jobs.find((item) => ['queued', 'running'].includes(item.status)) || null;
    return job((await this.pool.query(`SELECT * FROM ${this.schema}.backup_jobs WHERE status IN ('queued','running') LIMIT 1`)).rows[0]);
  }

  async create(kind, actor) {
    const id = randomUUID();
    if (!this.pool) {
      if (this.jobs.some((item) => ['queued', 'running'].includes(item.status))) throw backupError('已有备份正在执行', 409);
      const result = { id, kind, status: 'queued', progress: {}, error: '', createdBy: actor, createdAt: new Date().toISOString(), completedAt: null };
      this.jobs.unshift(result);
      return result;
    }
    try {
      return job((await this.pool.query(`INSERT INTO ${this.schema}.backup_jobs(id,kind,status,created_by)
        VALUES($1,$2,'queued',$3) RETURNING *`, [id, kind, actor])).rows[0]);
    } catch (error) {
      if (error.code === '23505') throw backupError('已有备份正在执行', 409);
      throw error;
    }
  }

  async update(id, result) {
    if (!this.pool) {
      const item = this.jobs.find((entry) => entry.id === id);
      if (item) Object.assign(item, result);
      return;
    }
    await this.pool.query(`UPDATE ${this.schema}.backup_jobs SET status=$2,progress=$3,error_message=$4,
      completed_at=CASE WHEN $2 IN ('completed','failed') THEN NOW() ELSE NULL END WHERE id=$1`,
    [id, result.status, result.progress || {}, result.error || '']);
  }

  async postpone(minutes) {
    if (!this.pool) { this.memory.next_run_at = new Date(Date.now() + minutes * 60000).toISOString(); return; }
    await this.pool.query(`UPDATE ${this.schema}.backup_settings SET next_run_at=NOW()+($1 * INTERVAL '1 minute') WHERE id=1`, [minutes]);
  }
}
