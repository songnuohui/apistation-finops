import { inTransaction } from '../db.mjs';

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function number(value) {
  return value === null || value === undefined || value === '' ? 0 : Number(value);
}

function nullableNumber(value) {
  return value === null || value === undefined || value === '' ? null : Number(value);
}

function email(value) {
  return String(value || '').trim().toLowerCase();
}

function setting(row = {}) {
  return {
    enabled: Boolean(row.enabled),
    scanIntervalMinutes: number(row.scan_interval_minutes || 5),
    testMode: Boolean(row.test_mode),
    testUserEmails: Array.isArray(row.test_user_emails) ? row.test_user_emails.map(email).filter(Boolean) : [],
    testRecipientEmail: email(row.test_recipient_email),
    adminEmail: email(row.admin_email),
    cursorCreatedAt: row.cursor_created_at,
    cursorId: number(row.cursor_id),
    lastRecordCreatedAt: row.last_record_created_at || null,
    lastRecordId: nullableNumber(row.last_record_id),
    lastScanUntil: row.last_scan_until || null,
    lastScanStartedAt: row.last_scan_started_at || null,
    lastScanCompletedAt: row.last_scan_completed_at || null,
    lastScanStatus: row.last_scan_status || 'never',
    lastError: row.last_error || '',
    updatedBy: row.updated_by || '',
    updatedAt: row.updated_at || null,
  };
}

function mapping(row) {
  return {
    id: number(row.id),
    sourceModel: row.source_model || '',
    allowedResponseModel: row.allowed_response_model || '',
    createdBy: row.created_by || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function scanRun(row) {
  return {
    id: number(row.id),
    runType: row.run_type || 'scheduled',
    periodStart: row.period_start,
    periodEnd: row.period_end,
    cursorBeforeCreatedAt: row.cursor_before_created_at,
    cursorBeforeId: number(row.cursor_before_id),
    cursorAfterCreatedAt: row.cursor_after_created_at,
    cursorAfterId: number(row.cursor_after_id),
    status: row.status,
    scannedCount: number(row.scanned_count),
    matchedCount: number(row.matched_count),
    allowedMappingCount: number(row.allowed_mapping_count),
    mismatchCount: number(row.mismatch_count),
    unknownCount: number(row.unknown_count),
    notificationCount: number(row.notification_count),
    errorMessage: row.error_message || '',
    startedAt: row.started_at,
    completedAt: row.completed_at || null,
  };
}

function auditEvent(row) {
  return {
    id: number(row.id),
    scanRunId: number(row.scan_run_id),
    sourceUsageId: number(row.source_usage_id),
    sourceUserId: number(row.source_user_id),
    userEmail: row.user_email || '',
    requestedModel: row.requested_model || '',
    upstreamModel: row.upstream_model || '',
    upstreamResponseModel: row.upstream_response_model || '',
    upstreamModelMismatch: row.upstream_model_mismatch === null
      ? null
      : Boolean(row.upstream_model_mismatch),
    allowedResponseModel: row.allowed_response_model || '',
    status: row.status,
    createdAt: row.created_at,
    recordedAt: row.recorded_at,
  };
}

function notification(row) {
  return {
    id: number(row.id),
    scanRunId: number(row.scan_run_id),
    kind: row.kind,
    targetEmail: row.target_email || '',
    recipientEmail: row.recipient_email || '',
    subject: row.subject,
    htmlContent: row.html_content,
    textContent: row.text_content || '',
    eventCount: number(row.event_count),
    status: row.status,
    errorMessage: row.error_message || '',
    sentAt: row.sent_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pageArgs({ page = 1, pageSize = 20 } = {}) {
  const normalizedPage = Math.max(1, Number(page) || 1);
  const normalizedPageSize = Math.min(100, Math.max(1, Number(pageSize) || 20));
  return {
    page: normalizedPage,
    pageSize: normalizedPageSize,
    offset: (normalizedPage - 1) * normalizedPageSize,
  };
}

export class ModelAuditRepository {
  constructor(pool, config) {
    this.pool = pool;
    this.schema = `"${config.finopsSchema}"`;
  }

  async getSettings(client = this.pool) {
    const result = await client.query(`SELECT * FROM ${this.schema}.model_audit_settings WHERE id=1`);
    if (!result.rowCount) throw httpError('model audit settings are not initialized', 503);
    return setting(result.rows[0]);
  }

  async updateSettings(input, actor = 'admin') {
    return inTransaction(this.pool, async (client) => {
      const current = await this.getSettings(client);
      const resetCursor = Boolean(input.enabled && !current.enabled);
      const result = await client.query(`UPDATE ${this.schema}.model_audit_settings SET
        enabled=$1,scan_interval_minutes=$2,test_mode=$3,test_user_emails=$4::text[],
        test_recipient_email=$5,admin_email=$6,
        cursor_created_at=CASE WHEN $7 THEN NOW()-INTERVAL '5 minutes' ELSE cursor_created_at END,
        cursor_id=CASE WHEN $7 THEN 0 ELSE cursor_id END,
        last_record_created_at=CASE WHEN $7 THEN NULL ELSE last_record_created_at END,
        last_record_id=CASE WHEN $7 THEN NULL ELSE last_record_id END,
        last_scan_until=CASE WHEN $7 THEN NULL ELSE last_scan_until END,
        last_scan_started_at=CASE WHEN $7 THEN NULL ELSE last_scan_started_at END,
        last_scan_completed_at=CASE WHEN $7 THEN NULL ELSE last_scan_completed_at END,
        last_scan_status=CASE WHEN $7 THEN 'never' ELSE last_scan_status END,
        last_error=CASE WHEN $7 THEN '' ELSE last_error END,
        updated_by=$8,updated_at=NOW()
        WHERE id=1
        RETURNING *`, [
        Boolean(input.enabled),
        Number(input.scanIntervalMinutes),
        Boolean(input.testMode),
        input.testUserEmails || [],
        input.testRecipientEmail || '',
        input.adminEmail || '',
        resetCursor,
        actor,
      ]);
      return setting(result.rows[0]);
    });
  }

  async listMappings({ page = 1, pageSize = 20 } = {}) {
    const paging = pageArgs({ page, pageSize });
    const result = await this.pool.query(`SELECT * FROM ${this.schema}.model_audit_mappings
      ORDER BY LOWER(BTRIM(source_model)),id LIMIT $1 OFFSET $2`, [paging.pageSize, paging.offset]);
    const count = await this.pool.query(`SELECT COUNT(*)::int AS count
      FROM ${this.schema}.model_audit_mappings`);
    return {
      items: result.rows.map(mapping),
      total: number(count.rows[0]?.count),
      page: paging.page,
      pageSize: paging.pageSize,
    };
  }

  async createMapping(input, actor = 'admin') {
    try {
      const result = await this.pool.query(`INSERT INTO ${this.schema}.model_audit_mappings
        (source_model,allowed_response_model,created_by,updated_at)
        VALUES($1,$2,$3,NOW()) RETURNING *`, [
        input.sourceModel,
        input.allowedResponseModel,
        actor,
      ]);
      return mapping(result.rows[0]);
    } catch (error) {
      if (error?.code === '23505') throw httpError('该实际模型已经存在映射，请直接编辑原映射', 409);
      throw error;
    }
  }

  async updateMapping(id, input, actor = 'admin') {
    try {
      const result = await this.pool.query(`UPDATE ${this.schema}.model_audit_mappings SET
        source_model=$2,allowed_response_model=$3,updated_by=$4,updated_at=NOW()
        WHERE id=$1 RETURNING *`, [
        id,
        input.sourceModel,
        input.allowedResponseModel,
        actor,
      ]);
      if (!result.rowCount) throw httpError('model audit mapping not found', 404);
      return mapping(result.rows[0]);
    } catch (error) {
      if (error?.code === '23505') throw httpError('该实际模型已经存在映射，请直接编辑原映射', 409);
      throw error;
    }
  }

  async deleteMapping(id) {
    const result = await this.pool.query(`DELETE FROM ${this.schema}.model_audit_mappings
      WHERE id=$1 RETURNING id`, [id]);
    if (!result.rowCount) throw httpError('model audit mapping not found', 404);
    return { ok: true };
  }

  async claimScan(now = new Date(), { force = false } = {}) {
    return inTransaction(this.pool, async (client) => {
      const lock = await client.query(
        `SELECT pg_try_advisory_xact_lock(hashtextextended('finops:model-audit',0)) AS acquired`,
      );
      if (!lock.rows[0]?.acquired) return null;

      const current = await this.getSettings(client);
      const startedAt = current.lastScanStartedAt ? new Date(current.lastScanStartedAt) : null;
      const stale = startedAt && (now.getTime() - startedAt.getTime() > 30 * 60_000);
      if (current.lastScanStatus === 'running' && !stale) return null;
      if (stale) {
        await client.query(`UPDATE ${this.schema}.model_audit_scan_runs SET
          status='failed',error_message='扫描超过 30 分钟，已由新的扫描任务回收',completed_at=NOW()
          WHERE status='running' AND started_at <= $1::timestamptz - INTERVAL '30 minutes'`, [now]);
        await client.query(`UPDATE ${this.schema}.model_audit_settings SET
          last_scan_status='failed',
          last_error='扫描超过 30 分钟，已由新的扫描任务回收',
          updated_at=NOW()
          WHERE id=1 AND last_scan_status='running'`, []);
        current.lastScanStatus = 'failed';
      }

      const activeRun = await client.query(`SELECT id,run_type,started_at
        FROM ${this.schema}.model_audit_scan_runs
        WHERE status='running' ORDER BY started_at LIMIT 1`);
      if (activeRun.rowCount) {
        const active = activeRun.rows[0];
        const activeStartedAt = new Date(active.started_at);
        if (now.getTime() - activeStartedAt.getTime() <= 30 * 60_000) return null;
        await client.query(`UPDATE ${this.schema}.model_audit_scan_runs SET
          status='failed',error_message='扫描超过 30 分钟，已由新的扫描任务回收',completed_at=NOW()
          WHERE id=$1 AND status='running'`, [active.id]);
        if (active.run_type === 'scheduled') {
          await client.query(`UPDATE ${this.schema}.model_audit_settings SET
            last_scan_status='failed',
            last_error='扫描超过 30 分钟，已由新的扫描任务回收',
            updated_at=NOW()
            WHERE id=1 AND last_scan_status='running'`);
        }
      }

      const completedAt = current.lastScanCompletedAt ? new Date(current.lastScanCompletedAt) : null;
      const due = force || !completedAt
        || current.lastScanStatus === 'failed'
        || now.getTime() - completedAt.getTime() >= current.scanIntervalMinutes * 60_000;
      if (!current.enabled || !due) return null;

      const periodStart = new Date(current.cursorCreatedAt);
      const periodEnd = new Date(now);
      if (!Number.isFinite(periodStart.getTime()) || periodStart >= periodEnd) {
        throw httpError('model audit cursor is invalid', 503);
      }
      const inserted = await client.query(`INSERT INTO ${this.schema}.model_audit_scan_runs(
        period_start,period_end,cursor_before_created_at,cursor_before_id,
        cursor_after_created_at,cursor_after_id,run_type,status,started_at)
        VALUES($1,$2,$1,$3,$1,$3,'scheduled','running',NOW()) RETURNING *`, [
        periodStart,
        periodEnd,
        current.cursorId,
      ]);
      await client.query(`UPDATE ${this.schema}.model_audit_settings SET
        last_scan_started_at=$1,last_scan_status='running',last_error=''
        WHERE id=1`, [inserted.rows[0].started_at]);
      return {
        settings: current,
        run: scanRun(inserted.rows[0]),
      };
    });
  }

  async claimTestScan(periodStart, periodEnd) {
    return inTransaction(this.pool, async (client) => {
      const lock = await client.query(
        `SELECT pg_try_advisory_xact_lock(hashtextextended('finops:model-audit',0)) AS acquired`,
      );
      if (!lock.rows[0]?.acquired) return null;

      const current = await this.getSettings(client);
      if (!current.testMode) {
        throw httpError('请先启用测试模式', 409);
      }
      const activeRun = await client.query(`SELECT id,run_type,started_at
        FROM ${this.schema}.model_audit_scan_runs
        WHERE status='running' ORDER BY started_at LIMIT 1`);
      if (activeRun.rowCount) {
        const active = activeRun.rows[0];
        if (Date.now() - new Date(active.started_at).getTime() <= 30 * 60_000) return null;
        await client.query(`UPDATE ${this.schema}.model_audit_scan_runs SET
          status='failed',error_message='扫描超过 30 分钟，已由新的扫描任务回收',completed_at=NOW()
          WHERE id=$1 AND status='running'`, [active.id]);
        if (active.run_type === 'scheduled') {
          await client.query(`UPDATE ${this.schema}.model_audit_settings SET
            last_scan_status='failed',
            last_error='扫描超过 30 分钟，已由新的扫描任务回收',
            updated_at=NOW()
            WHERE id=1 AND last_scan_status='running'`);
        }
      }
      const start = new Date(periodStart);
      const end = new Date(periodEnd);
      const inserted = await client.query(`INSERT INTO ${this.schema}.model_audit_scan_runs(
        period_start,period_end,cursor_before_created_at,cursor_before_id,
        cursor_after_created_at,cursor_after_id,run_type,status,started_at)
        VALUES($1,$2,$1,-1,$1,-1,'test','running',NOW()) RETURNING *`, [
        start,
        end,
      ]);
      return {
        settings: current,
        run: scanRun(inserted.rows[0]),
      };
    });
  }

  async completeScan(runId, {
    cursorAfterCreatedAt,
    cursorAfterId,
    lastRecordCreatedAt,
    lastRecordId,
    counts,
    events,
    notifications,
  }) {
    return inTransaction(this.pool, async (client) => {
      const runResult = await client.query(`SELECT * FROM ${this.schema}.model_audit_scan_runs
        WHERE id=$1 FOR UPDATE`, [runId]);
      if (!runResult.rowCount) throw httpError('model audit scan run not found', 404);
      if (runResult.rows[0].status !== 'running') return scanRun(runResult.rows[0]);

      for (const event of events || []) {
        await client.query(`INSERT INTO ${this.schema}.model_audit_events(
          scan_run_id,source_usage_id,source_user_id,user_email,requested_model,
          upstream_model,upstream_response_model,upstream_model_mismatch,
          allowed_response_model,status,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT(scan_run_id,source_usage_id) DO NOTHING`, [
          runId,
          event.sourceUsageId,
          event.sourceUserId,
          event.userEmail,
          event.requestedModel,
          event.upstreamModel,
          event.upstreamResponseModel,
          event.upstreamModelMismatch,
          event.allowedResponseModel,
          event.status,
          event.createdAt,
        ]);
      }

      for (const item of notifications || []) {
        await client.query(`INSERT INTO ${this.schema}.model_audit_notifications(
          scan_run_id,kind,target_email,recipient_email,subject,html_content,
          text_content,event_count,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending')
          ON CONFLICT(scan_run_id,kind,recipient_email) DO NOTHING`, [
          runId,
          item.kind,
          item.targetEmail || '',
          item.recipientEmail,
          item.subject,
          item.htmlContent,
          item.textContent || '',
          Number(item.eventCount || 0),
        ]);
      }

      const updated = await client.query(`UPDATE ${this.schema}.model_audit_scan_runs SET
        cursor_after_created_at=$2,cursor_after_id=$3,status='completed',
        scanned_count=$4,matched_count=$5,allowed_mapping_count=$6,
        mismatch_count=$7,unknown_count=$8,notification_count=$9,
        completed_at=NOW(),error_message=''
        WHERE id=$1 RETURNING *`, [
        runId,
        cursorAfterCreatedAt,
        cursorAfterId,
        counts.scanned,
        counts.matched,
        counts.allowedMapping,
        counts.mismatch,
        counts.unknown,
        notifications?.length || 0,
      ]);
      if (updated.rows[0].run_type === 'scheduled') {
        await client.query(`UPDATE ${this.schema}.model_audit_settings SET
          cursor_created_at=$1,cursor_id=$2,last_record_created_at=$3,
          last_record_id=$4,last_scan_until=$5,last_scan_completed_at=NOW(),
          last_scan_status='completed',last_error='',updated_at=NOW()
          WHERE id=1`, [
          cursorAfterCreatedAt,
          cursorAfterId,
          lastRecordCreatedAt,
          lastRecordId,
          updated.rows[0].period_end,
        ]);
      }
      return scanRun(updated.rows[0]);
    });
  }

  async failScan(runId, errorMessage) {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query(`UPDATE ${this.schema}.model_audit_scan_runs SET
        status='failed',error_message=$2,completed_at=NOW()
        WHERE id=$1 AND status='running' RETURNING *`, [
        runId,
        String(errorMessage || '扫描失败').slice(0, 4000),
      ]);
      if (result.rows[0]?.run_type === 'scheduled') {
        await client.query(`UPDATE ${this.schema}.model_audit_settings SET
          last_scan_status='failed',last_error=$1,updated_at=NOW()
          WHERE id=1 AND last_scan_status='running'
            AND last_scan_started_at=(SELECT started_at FROM ${this.schema}.model_audit_scan_runs WHERE id=$2)`, [
          String(errorMessage || '扫描失败').slice(0, 4000),
          runId,
        ]);
      }
      return result.rowCount ? scanRun(result.rows[0]) : null;
    });
  }

  async recoverRunning() {
    return inTransaction(this.pool, async (client) => {
      const result = await client.query(`UPDATE ${this.schema}.model_audit_scan_runs
        SET status='failed',error_message='FinOps 服务重启，扫描未完成',completed_at=NOW()
        WHERE status='running' RETURNING id,run_type`);
      if (result.rows.some((row) => row.run_type === 'scheduled')) {
        await client.query(`UPDATE ${this.schema}.model_audit_settings SET
          last_scan_status='failed',last_error='FinOps 服务重启，扫描未完成',updated_at=NOW()
          WHERE id=1`);
      }
      return result.rowCount;
    });
  }

  async listScanRuns({ page = 1, pageSize = 20 } = {}) {
    const paging = pageArgs({ page, pageSize });
    const result = await this.pool.query(`SELECT * FROM ${this.schema}.model_audit_scan_runs
      ORDER BY started_at DESC,id DESC LIMIT $1 OFFSET $2`, [paging.pageSize, paging.offset]);
    const count = await this.pool.query(`SELECT COUNT(*)::int AS count
      FROM ${this.schema}.model_audit_scan_runs`);
    return {
      items: result.rows.map(scanRun),
      total: number(count.rows[0]?.count),
      page: paging.page,
      pageSize: paging.pageSize,
    };
  }

  async listEvents({ page = 1, pageSize = 30, search = '' } = {}) {
    const paging = pageArgs({ page, pageSize });
    const conditions = ['status=\'mismatch\''];
    const params = [];
    if (search) {
      params.push(`%${String(search).trim().toLowerCase()}%`);
      conditions.push(`LOWER(user_email||' '||upstream_model||' '||upstream_response_model||' '||requested_model) LIKE $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = params.push(paging.pageSize);
    const offset = params.push(paging.offset);
    const result = await this.pool.query(`SELECT * FROM ${this.schema}.model_audit_events
      ${where} ORDER BY created_at DESC,id DESC LIMIT $${limit} OFFSET $${offset}`, params);
    const count = await this.pool.query(`SELECT COUNT(*)::int AS count
      FROM ${this.schema}.model_audit_events ${where}`, params.slice(0, -2));
    return {
      items: result.rows.map(auditEvent),
      total: number(count.rows[0]?.count),
      page: paging.page,
      pageSize: paging.pageSize,
    };
  }

  async listNotifications({ page = 1, pageSize = 30, status = '' } = {}) {
    const paging = pageArgs({ page, pageSize });
    const params = [];
    const where = status ? `WHERE status=$${params.push(status)}` : '';
    const limit = params.push(paging.pageSize);
    const offset = params.push(paging.offset);
    const result = await this.pool.query(`SELECT * FROM ${this.schema}.model_audit_notifications
      ${where} ORDER BY created_at DESC,id DESC LIMIT $${limit} OFFSET $${offset}`, params);
    const count = await this.pool.query(`SELECT COUNT(*)::int AS count
      FROM ${this.schema}.model_audit_notifications ${where}`, status ? [status] : []);
    return {
      items: result.rows.map(notification),
      total: number(count.rows[0]?.count),
      page: paging.page,
      pageSize: paging.pageSize,
    };
  }

  async listPendingNotifications(limit = 20) {
    const result = await this.pool.query(`SELECT * FROM ${this.schema}.model_audit_notifications
      WHERE status='pending' ORDER BY id LIMIT $1`, [Math.min(100, Math.max(1, Number(limit) || 20))]);
    return result.rows.map(notification);
  }

  async claimNotification(id) {
    const result = await this.pool.query(`UPDATE ${this.schema}.model_audit_notifications SET
      status='sending',error_message='',updated_at=NOW()
      WHERE id=$1 AND status='pending' RETURNING *`, [id]);
    return result.rowCount ? notification(result.rows[0]) : null;
  }

  async finishNotification(id, status, errorMessage = '') {
    const result = await this.pool.query(`UPDATE ${this.schema}.model_audit_notifications SET
      status=$2,error_message=$3,sent_at=CASE WHEN $2='sent' THEN NOW() ELSE sent_at END,
      updated_at=NOW() WHERE id=$1 RETURNING *`, [
      id,
      status,
      String(errorMessage || '').slice(0, 4000),
    ]);
    return result.rowCount ? notification(result.rows[0]) : null;
  }

  async recoverSendingNotifications() {
    const result = await this.pool.query(`UPDATE ${this.schema}.model_audit_notifications
      SET status='pending',error_message='FinOps 服务重启，邮件待重新投递',updated_at=NOW()
      WHERE status='sending' RETURNING id`);
    return result.rowCount;
  }
}

export class DemoModelAuditRepository {
  constructor(mainRepository) {
    this.mainRepository = mainRepository;
    this.settings = {
      enabled: false,
      scanIntervalMinutes: 5,
      testMode: true,
      testUserEmails: ['nuohuisong@gmail.com'],
      testRecipientEmail: 'test@example.com',
      adminEmail: 'admin@example.com',
      cursorCreatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      cursorId: 0,
      lastRecordCreatedAt: null,
      lastRecordId: null,
      lastScanUntil: null,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanStatus: 'never',
      lastError: '',
      updatedBy: 'demo',
      updatedAt: null,
    };
    this.mappings = [];
    this.runs = [];
    this.events = [];
    this.notifications = [];
    this.nextRunId = 1;
    this.nextEventId = 1;
    this.nextNotificationId = 1;
    const demoUser = mainRepository.users?.[0];
    this.usageRows = [
      {
        id: 700001,
        userId: Number(demoUser?.id || 1),
        userEmail: demoUser?.email || 'nuohuisong@gmail.com',
        requestedModel: 'gpt-4o',
        upstreamModel: 'gpt-4o',
        upstreamResponseModel: 'gpt-4o-mini',
        upstreamModelMismatch: true,
        createdAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      },
      {
        id: 700002,
        userId: Number(demoUser?.id || 1),
        userEmail: demoUser?.email || 'nuohuisong@gmail.com',
        requestedModel: 'gpt-4o',
        upstreamModel: 'gpt-4o',
        upstreamResponseModel: 'gpt-4o',
        upstreamModelMismatch: false,
        createdAt: new Date(Date.now() - 90_000).toISOString(),
      },
    ];
  }

  async getSettings() { return { ...this.settings, testUserEmails: [...this.settings.testUserEmails] }; }

  async updateSettings(input, actor = 'demo') {
    const reset = input.enabled && !this.settings.enabled;
    this.settings = {
      ...this.settings,
      enabled: Boolean(input.enabled),
      scanIntervalMinutes: Number(input.scanIntervalMinutes),
      testMode: Boolean(input.testMode),
      testUserEmails: [...(input.testUserEmails || [])],
      testRecipientEmail: input.testRecipientEmail || '',
      adminEmail: input.adminEmail || '',
      updatedBy: actor,
      updatedAt: new Date().toISOString(),
    };
    if (reset) {
      this.settings.cursorCreatedAt = new Date(Date.now() - 5 * 60_000).toISOString();
      this.settings.cursorId = 0;
      this.settings.lastRecordCreatedAt = null;
      this.settings.lastRecordId = null;
      this.settings.lastScanUntil = null;
      this.settings.lastScanStartedAt = null;
      this.settings.lastScanCompletedAt = null;
      this.settings.lastScanStatus = 'never';
      this.settings.lastError = '';
    }
    return this.getSettings();
  }

  async listMappings({ page = 1, pageSize = 20 } = {}) {
    const paging = pageArgs({ page, pageSize });
    return {
      items: this.mappings.slice(paging.offset, paging.offset + paging.pageSize).map((item) => ({ ...item })),
      total: this.mappings.length,
      page: paging.page,
      pageSize: paging.pageSize,
    };
  }
  async createMapping(input, actor = 'demo') {
    const sourceKey = String(input.sourceModel || '').trim().toLowerCase();
    if (this.mappings.some((item) => item.sourceModel.trim().toLowerCase() === sourceKey)) {
      throw httpError('该实际模型已经存在映射，请直接编辑原映射', 409);
    }
    const item = { id: this.mappings.length + 1, ...input, createdBy: actor, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.mappings.push(item);
    return { ...item };
  }
  async updateMapping(id, input, actor = 'demo') {
    const item = this.mappings.find((entry) => Number(entry.id) === Number(id));
    if (!item) throw httpError('model audit mapping not found', 404);
    const sourceKey = String(input.sourceModel || '').trim().toLowerCase();
    if (this.mappings.some((entry) => Number(entry.id) !== Number(id)
      && entry.sourceModel.trim().toLowerCase() === sourceKey)) {
      throw httpError('该实际模型已经存在映射，请直接编辑原映射', 409);
    }
    Object.assign(item, input, { updatedBy: actor, updatedAt: new Date().toISOString() });
    return { ...item };
  }
  async deleteMapping(id) {
    const index = this.mappings.findIndex((entry) => Number(entry.id) === Number(id));
    if (index < 0) throw httpError('model audit mapping not found', 404);
    this.mappings.splice(index, 1);
    return { ok: true };
  }

  async listModelAuditUsage({
    cursorCreatedAt,
    cursorId,
    until,
    userEmails = [],
    inclusiveCursor = false,
    limit = 5000,
  }) {
    const normalized = new Set(userEmails.map(email));
    return this.usageRows
      .filter((row) => {
        const time = new Date(row.createdAt).getTime();
        const cursorTime = new Date(cursorCreatedAt).getTime();
        const endTime = new Date(until).getTime();
        const afterCursor = inclusiveCursor
          ? (time > cursorTime || (time === cursorTime && Number(row.id) >= Number(cursorId)))
          : (time > cursorTime || (time === cursorTime && Number(row.id) > Number(cursorId)));
        return afterCursor
          && time < endTime
          && (!normalized.size || normalized.has(email(row.userEmail)));
      })
      .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt) || left.id - right.id)
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }

  async claimScan(now = new Date(), { force = false } = {}) {
    if (!this.settings.enabled) return null;
    if (this.settings.lastScanStatus === 'running') {
      const startedAt = new Date(this.settings.lastScanStartedAt || 0).getTime();
      if (!startedAt || now.getTime() - startedAt <= 30 * 60_000) return null;
      const stale = this.runs.find((item) => item.status === 'running');
      if (stale) Object.assign(stale, {
        status: 'failed',
        errorMessage: '扫描超过 30 分钟，已由新的扫描任务回收',
        completedAt: now.toISOString(),
      });
      this.settings.lastScanStatus = 'failed';
      this.settings.lastError = '扫描超过 30 分钟，已由新的扫描任务回收';
    }
    const completed = this.settings.lastScanCompletedAt && new Date(this.settings.lastScanCompletedAt).getTime();
    if (!force && completed && this.settings.lastScanStatus !== 'failed'
      && now.getTime() - completed < this.settings.scanIntervalMinutes * 60_000) return null;
    const run = {
      id: this.nextRunId++,
      periodStart: this.settings.cursorCreatedAt,
      periodEnd: now.toISOString(),
      cursorBeforeCreatedAt: this.settings.cursorCreatedAt,
      cursorBeforeId: this.settings.cursorId,
      cursorAfterCreatedAt: this.settings.cursorCreatedAt,
      cursorAfterId: this.settings.cursorId,
      runType: 'scheduled',
      status: 'running',
      scannedCount: 0,
      matchedCount: 0,
      allowedMappingCount: 0,
      mismatchCount: 0,
      unknownCount: 0,
      notificationCount: 0,
      errorMessage: '',
      startedAt: now.toISOString(),
      completedAt: null,
    };
    this.runs.unshift(run);
    this.settings.lastScanStatus = 'running';
    this.settings.lastScanStartedAt = now.toISOString();
    return { settings: await this.getSettings(), run: { ...run } };
  }

  async claimTestScan(periodStart, periodEnd) {
    if (!this.settings.testMode) throw httpError('请先启用测试模式', 409);
    const start = new Date(periodStart);
    const run = {
      id: this.nextRunId++,
      periodStart: start.toISOString(),
      periodEnd: new Date(periodEnd).toISOString(),
      cursorBeforeCreatedAt: start.toISOString(),
      cursorBeforeId: -1,
      cursorAfterCreatedAt: start.toISOString(),
      cursorAfterId: -1,
      runType: 'test',
      status: 'running',
      scannedCount: 0,
      matchedCount: 0,
      allowedMappingCount: 0,
      mismatchCount: 0,
      unknownCount: 0,
      notificationCount: 0,
      errorMessage: '',
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    this.runs.unshift(run);
    return { settings: await this.getSettings(), run: { ...run } };
  }

  async completeScan(runId, payload) {
    const run = this.runs.find((item) => item.id === Number(runId));
    if (!run || run.status !== 'running') return run ? { ...run } : null;
    for (const event of payload.events || []) {
      if (this.events.some((item) => item.scanRunId === run.id
        && item.sourceUsageId === event.sourceUsageId)) continue;
      this.events.unshift({ id: this.nextEventId++, scanRunId: run.id, recordedAt: new Date().toISOString(), ...event });
    }
    for (const item of payload.notifications || []) {
      this.notifications.unshift({
        id: this.nextNotificationId++,
        scanRunId: run.id,
        ...item,
        status: 'pending',
        errorMessage: '',
        sentAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    Object.assign(run, {
      scannedCount: payload.counts.scanned,
      matchedCount: payload.counts.matched,
      allowedMappingCount: payload.counts.allowedMapping,
      mismatchCount: payload.counts.mismatch,
      unknownCount: payload.counts.unknown,
      cursorAfterCreatedAt: payload.cursorAfterCreatedAt,
      cursorAfterId: payload.cursorAfterId,
      notificationCount: payload.notifications?.length || 0,
      status: 'completed',
      completedAt: new Date().toISOString(),
    });
    if (run.runType === 'scheduled') {
      Object.assign(this.settings, {
        cursorCreatedAt: payload.cursorAfterCreatedAt,
        cursorId: payload.cursorAfterId,
        lastRecordCreatedAt: payload.lastRecordCreatedAt,
        lastRecordId: payload.lastRecordId,
        lastScanUntil: run.periodEnd,
        lastScanCompletedAt: run.completedAt,
        lastScanStatus: 'completed',
        lastError: '',
      });
    }
    return { ...run };
  }

  async failScan(runId, errorMessage) {
    const run = this.runs.find((item) => item.id === Number(runId));
    if (!run) return null;
    Object.assign(run, { status: 'failed', errorMessage, completedAt: new Date().toISOString() });
    if (run.runType === 'scheduled') {
      this.settings.lastScanStatus = 'failed';
      this.settings.lastError = errorMessage;
    }
    return { ...run };
  }
  async recoverRunning() {
    let count = 0;
    for (const run of this.runs.filter((item) => item.status === 'running')) {
      await this.failScan(run.id, 'FinOps 服务重启，扫描未完成');
      count += 1;
    }
    return count;
  }
  async listScanRuns({ page = 1, pageSize = 20 } = {}) {
    const paging = pageArgs({ page, pageSize });
    return { items: this.runs.slice(paging.offset, paging.offset + paging.pageSize).map((item) => ({ ...item })), total: this.runs.length, page: paging.page, pageSize: paging.pageSize };
  }
  async listEvents({ page = 1, pageSize = 30, search = '' } = {}) {
    const paging = pageArgs({ page, pageSize });
    const term = String(search || '').toLowerCase();
    const filtered = this.events.filter((item) => item.status === 'mismatch'
      && (!term || `${item.userEmail} ${item.upstreamModel} ${item.upstreamResponseModel} ${item.requestedModel}`.toLowerCase().includes(term)));
    return { items: filtered.slice(paging.offset, paging.offset + paging.pageSize).map((item) => ({ ...item })), total: filtered.length, page: paging.page, pageSize: paging.pageSize };
  }
  async listNotifications({ page = 1, pageSize = 30, status = '' } = {}) {
    const paging = pageArgs({ page, pageSize });
    const filtered = this.notifications.filter((item) => !status || item.status === status);
    return { items: filtered.slice(paging.offset, paging.offset + paging.pageSize).map((item) => ({ ...item })), total: filtered.length, page: paging.page, pageSize: paging.pageSize };
  }
  async listPendingNotifications(limit = 20) {
    return this.notifications.filter((item) => item.status === 'pending').slice(0, limit).map((item) => ({ ...item }));
  }
  async claimNotification(id) {
    const item = this.notifications.find((entry) => entry.id === Number(id) && entry.status === 'pending');
    if (!item) return null;
    item.status = 'sending';
    return { ...item };
  }
  async finishNotification(id, status, errorMessage = '') {
    const item = this.notifications.find((entry) => entry.id === Number(id));
    if (!item) return null;
    item.status = status;
    item.errorMessage = errorMessage;
    if (status === 'sent') item.sentAt = new Date().toISOString();
    item.updatedAt = new Date().toISOString();
    return { ...item };
  }
  async recoverSendingNotifications() {
    let count = 0;
    for (const item of this.notifications.filter((entry) => entry.status === 'sending')) {
      item.status = 'pending';
      item.errorMessage = 'FinOps 服务重启，邮件待重新投递';
      count += 1;
    }
    return count;
  }
}
