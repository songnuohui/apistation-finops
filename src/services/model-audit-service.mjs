const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalized(value) {
  return String(value || '').trim().toLowerCase();
}

function display(value) {
  return String(value || '').trim();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function dateText(value) {
  return value ? new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(value)) : '--';
}

function modelText(value) {
  return display(value) || '未记录';
}

export function classifyModelAuditEvent(row, mappings = []) {
  const upstreamModel = display(row.upstream_model ?? row.upstreamModel)
    || display(row.requested_model ?? row.requestedModel ?? row.model);
  const responseModel = display(row.upstream_response_model ?? row.upstreamResponseModel);
  const upstreamKey = normalized(upstreamModel);
  const responseKey = normalized(responseModel);
  const mapping = mappings.find((item) => normalized(item.sourceModel ?? item.source_model) === upstreamKey);
  const allowedResponseModel = display(mapping?.allowedResponseModel ?? mapping?.allowed_response_model);

  if (!upstreamKey || !responseKey) {
    return {
      status: 'unknown',
      allowedResponseModel,
      upstreamModel,
      upstreamResponseModel: responseModel,
    };
  }
  if (upstreamKey === responseKey) {
    return {
      status: 'matched',
      allowedResponseModel: upstreamModel,
      upstreamModel,
      upstreamResponseModel: responseModel,
    };
  }
  if (allowedResponseModel && normalized(allowedResponseModel) === responseKey) {
    return {
      status: 'allowed_mapping',
      allowedResponseModel,
      upstreamModel,
      upstreamResponseModel: responseModel,
    };
  }
  return {
    status: 'mismatch',
    allowedResponseModel,
    upstreamModel,
    upstreamResponseModel: responseModel,
  };
}

function groupByEmail(events) {
  const groups = new Map();
  for (const event of events.filter((item) => item.status === 'mismatch')) {
    const key = normalized(event.userEmail) || `user:${event.sourceUserId || 'unknown'}`;
    const group = groups.get(key) || {
      targetEmail: EMAIL_RE.test(normalized(event.userEmail)) ? normalized(event.userEmail) : '',
      sourceUserIds: new Set(),
      events: [],
    };
    if (event.sourceUserId) group.sourceUserIds.add(Number(event.sourceUserId));
    group.events.push(event);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function reportRows(events) {
  return events.map((event) => `<tr>
    <td>${escapeHtml(dateText(event.createdAt))}</td>
    <td>${escapeHtml(event.userEmail || `用户 #${event.sourceUserId || '--'}`)}</td>
    <td>${escapeHtml(modelText(event.requestedModel))}</td>
    <td>${escapeHtml(modelText(event.upstreamModel))}</td>
    <td>${escapeHtml(modelText(event.upstreamResponseModel))}</td>
  </tr>`).join('');
}

function reportText(events) {
  return events.map((event) => [
    dateText(event.createdAt),
    event.userEmail || `用户 #${event.sourceUserId || '--'}`,
    `请求模型=${modelText(event.requestedModel)}`,
    `上游发送=${modelText(event.upstreamModel)}`,
    `上游响应=${modelText(event.upstreamResponseModel)}`,
  ].join(' | ')).join('\n');
}

function renderReport(title, periodStart, periodEnd, events, testMode = false) {
  const label = testMode ? '测试模式：本邮件不会发送给真实用户' : '';
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
    <style>body{font:14px/1.6 Arial,sans-serif;color:#17263d}table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #dbe5f0;padding:7px;text-align:left}th{background:#f4f7fb}
    .note{color:#ad6a00}</style><h2>${escapeHtml(title)}</h2>
    <p>扫描窗口：${escapeHtml(dateText(periodStart))} 至 ${escapeHtml(dateText(periodEnd))}</p>
    ${label ? `<p class="note">${escapeHtml(label)}</p>` : ''}
    <p>发现 ${events.length} 条未命中合法映射的模型不一致记录。</p>
    <table><thead><tr><th>记录时间</th><th>用户邮箱</th><th>请求模型</th>
    <th>上游发送模型</th><th>上游响应模型</th></tr></thead><tbody>${reportRows(events)}</tbody></table>
    </html>`;
  const text = `${title}\n扫描窗口：${dateText(periodStart)} 至 ${dateText(periodEnd)}\n`
    + (label ? `${label}\n` : '')
    + `发现 ${events.length} 条未命中合法映射的模型不一致记录。\n${reportText(events)}`;
  return { htmlContent: html, textContent: text };
}

function counts(events) {
  return events.reduce((result, event) => {
    result.scanned += 1;
    const key = event.status === 'allowed_mapping' ? 'allowedMapping' : event.status;
    result[key] += 1;
    return result;
  }, {
    scanned: 0,
    matched: 0,
    allowedMapping: 0,
    mismatch: 0,
    unknown: 0,
  });
}

export function buildModelAuditNotifications(settings, run, events) {
  const mismatches = events.filter((event) => event.status === 'mismatch');
  if (!mismatches.length) return [];

  if (settings.testMode) {
    if (!EMAIL_RE.test(normalized(settings.testRecipientEmail))) return [];
    const report = renderReport(
      '[测试] FinOps 模型一致性告警汇总',
      run.periodStart,
      run.periodEnd,
      mismatches,
      true,
    );
    return [{
      kind: 'test',
      targetEmail: normalized(settings.testRecipientEmail),
      recipientEmail: normalized(settings.testRecipientEmail),
      subject: `[测试] FinOps 模型一致性告警（${mismatches.length} 条）`,
      eventCount: mismatches.length,
      ...report,
    }];
  }

  const notices = [];
  if (settings.notifyUserEmails !== false) {
    for (const group of groupByEmail(mismatches)) {
      if (!group.targetEmail) continue;
      const report = renderReport(
        'FinOps 模型一致性告警',
        run.periodStart,
        run.periodEnd,
        group.events,
      );
      notices.push({
        kind: 'user',
        targetEmail: group.targetEmail,
        recipientEmail: group.targetEmail,
        subject: `模型一致性告警：发现 ${group.events.length} 条记录`,
        eventCount: group.events.length,
        ...report,
      });
    }
  }

  if (EMAIL_RE.test(normalized(settings.adminEmail))) {
    const report = renderReport(
      'FinOps 模型一致性告警汇总',
      run.periodStart,
      run.periodEnd,
      mismatches,
    );
    notices.push({
      kind: 'admin',
      targetEmail: normalized(settings.adminEmail),
      recipientEmail: normalized(settings.adminEmail),
      subject: `模型一致性告警汇总：${mismatches.length} 条记录`,
      eventCount: mismatches.length,
      ...report,
    });
  }
  return notices;
}

export class ModelAuditService {
  constructor(repository, sourceUsageRepository, emailService, config, logger = console) {
    this.repository = repository;
    this.sourceUsageRepository = sourceUsageRepository;
    this.emailService = emailService;
    this.config = config;
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.runDue().catch((error) => {
      this.logger.error('[model audit]', error?.message || error);
    }), 15_000);
    void (async () => {
      try {
        await this.repository.recoverRunning();
        await this.repository.recoverSendingNotifications();
        await this.deliverPendingNotifications();
        await this.runDue();
      } catch (error) {
        this.logger.error('[model audit startup]', error?.message || error);
      }
    })();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runDue() {
    if (this.running) return null;
    this.running = true;
    try {
      const claim = await this.repository.claimScan(new Date());
      if (!claim) return null;
      return await this.execute(claim);
    } finally {
      this.running = false;
    }
  }

  async runNow() {
    if (this.running) throw Object.assign(new Error('模型审计扫描正在执行'), { statusCode: 409 });
    this.running = true;
    try {
      const settings = await this.repository.getSettings();
      if (!settings.enabled) throw Object.assign(new Error('请先启用模型审计'), { statusCode: 409 });
      const claim = await this.repository.claimScan(new Date(), { force: true });
      if (!claim) throw Object.assign(new Error('当前还未到下一次扫描时间'), { statusCode: 409 });
      return await this.execute(claim);
    } finally {
      this.running = false;
    }
  }

  async runTest({ periodStart, periodEnd }) {
    if (this.running) throw Object.assign(new Error('模型审计扫描正在执行'), { statusCode: 409 });
    this.running = true;
    try {
      const claim = await this.repository.claimTestScan(periodStart, periodEnd);
      if (!claim) throw Object.assign(new Error('当前已有模型审计扫描正在执行'), { statusCode: 409 });
      return await this.execute(claim);
    } finally {
      this.running = false;
    }
  }

  async listMappings() {
    const first = await this.repository.listMappings({ page: 1, pageSize: 100 });
    if (Array.isArray(first)) return first;
    const mappings = [...(first?.items || [])];
    const total = Number(first?.total || mappings.length);
    for (let page = 2; mappings.length < total; page += 1) {
      const result = await this.repository.listMappings({ page, pageSize: 100 });
      mappings.push(...(result?.items || []));
      if (!(result?.items || []).length) break;
    }
    return mappings;
  }

  async execute({ settings, run }) {
    try {
      const mappings = await this.listMappings();
      const sourceRows = [];
      let cursorCreatedAt = run.cursorBeforeCreatedAt;
      let cursorId = run.cursorBeforeId;
      let includeStart = run.runType === 'test';
      const pageSize = 5_000;
      while (true) {
        const batch = await this.sourceUsageRepository.listModelAuditUsage({
          cursorCreatedAt,
          cursorId,
          until: run.periodEnd,
          userEmails: run.runType === 'test' && settings.testMode ? settings.testUserEmails : [],
          inclusiveCursor: includeStart,
          limit: pageSize,
        });
        sourceRows.push(...batch);
        if (batch.length < pageSize) break;
        includeStart = false;
        const last = batch[batch.length - 1];
        cursorCreatedAt = new Date(last.created_at ?? last.createdAt).toISOString();
        cursorId = Number(last.id ?? last.sourceUsageId);
      }
      const testUsers = new Set((settings.testUserEmails || []).map(normalized));
      const rows = settings.testMode
        ? sourceRows.filter((row) => testUsers.has(normalized(row.email ?? row.userEmail)))
        : sourceRows;
      const events = rows.map((row) => {
        const classification = classifyModelAuditEvent(row, mappings);
        return {
          sourceUsageId: Number(row.id ?? row.sourceUsageId),
          sourceUserId: Number(row.user_id ?? row.userId ?? 0),
          userEmail: normalized(row.email ?? row.userEmail),
          requestedModel: display(row.requested_model ?? row.requestedModel ?? row.model),
          upstreamModel: classification.upstreamModel,
          upstreamResponseModel: classification.upstreamResponseModel,
          upstreamModelMismatch: row.upstream_model_mismatch ?? row.upstreamModelMismatch ?? null,
          allowedResponseModel: classification.allowedResponseModel,
          status: classification.status,
          createdAt: row.created_at ?? row.createdAt,
        };
      });
      const summary = counts(events);
      const last = sourceRows[sourceRows.length - 1];
      const cursorAfterCreatedAt = last
        ? new Date(last.created_at ?? last.createdAt).toISOString()
        : new Date(run.periodEnd).toISOString();
      const cursorAfterId = last ? Number(last.id ?? last.sourceUsageId) : 0;
      const actualMax = last
        ? { createdAt: cursorAfterCreatedAt, id: cursorAfterId }
        : { createdAt: null, id: null };
      const mismatches = events.filter((item) => item.status === 'mismatch');
      const notifications = buildModelAuditNotifications(settings, run, mismatches);
      const completed = await this.repository.completeScan(run.id, {
        cursorAfterCreatedAt,
        cursorAfterId,
        lastRecordCreatedAt: actualMax.createdAt,
        lastRecordId: actualMax.id,
        counts: summary,
        events: mismatches,
        notifications,
      });
      await this.deliverNotifications(run.id);
      return completed;
    } catch (error) {
      await this.repository.failScan(run.id, error?.message || error).catch((recoveryError) => {
        this.logger.error('[model audit failure record]', recoveryError?.message || recoveryError);
      });
      throw error;
    }
  }

  async deliverNotifications(runId) {
    const pending = await this.repository.listPendingNotifications(100);
    for (const item of pending.filter((notification) => Number(notification.scanRunId) === Number(runId))) {
      const claimed = await this.repository.claimNotification(item.id);
      if (!claimed) continue;
      try {
        await this.emailService.sendRaw(
          claimed.recipientEmail,
          claimed.subject,
          claimed.htmlContent,
          claimed.textContent,
        );
        await this.repository.finishNotification(claimed.id, 'sent');
      } catch (error) {
        try {
          await this.repository.finishNotification(
            claimed.id,
            'failed',
            error?.message || error,
          );
        } catch (finishError) {
          this.logger.error('[model audit email status]', finishError?.message || finishError);
        }
        this.logger.error('[model audit email]', error?.message || error);
      }
    }
  }

  async deliverPendingNotifications() {
    const pending = await this.repository.listPendingNotifications(100);
    for (const item of pending) {
      const claimed = await this.repository.claimNotification(item.id);
      if (!claimed) continue;
      try {
        await this.emailService.sendRaw(
          claimed.recipientEmail,
          claimed.subject,
          claimed.htmlContent,
          claimed.textContent,
        );
        await this.repository.finishNotification(claimed.id, 'sent');
      } catch (error) {
        try {
          await this.repository.finishNotification(
            claimed.id,
            'failed',
            error?.message || error,
          );
        } catch (finishError) {
          this.logger.error('[model audit email status]', finishError?.message || finishError);
        }
        this.logger.error('[model audit email]', error?.message || error);
      }
    }
  }
}
