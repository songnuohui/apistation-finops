const grid = document.querySelector('#group-grid');
const refreshButton = document.querySelector('#refresh-button');
const groupCount = document.querySelector('#group-count');
const statusSummary = document.querySelector('#status-summary');
const overallStatus = document.querySelector('#overall-status');
const overallStatusLabel = document.querySelector('#overall-status-label');
const summaryTitle = document.querySelector('#summary-title');
const summaryDetail = document.querySelector('#summary-detail');
const refreshCountdown = document.querySelector('#refresh-countdown');

let refreshTimer = null;
let countdownTimer = null;
let refreshIntervalSeconds = 30;
let countdownSeconds = 30;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
})[char]);

const statusText = {
  healthy: '运行正常',
  degraded: '部分可用',
  unavailable: '不可用',
  unknown: '等待数据',
};

const overallText = {
  healthy: 'OPERATIONAL',
  degraded: 'DEGRADED',
  unavailable: 'UNAVAILABLE',
  unknown: 'PENDING',
};

const statusDescription = {
  healthy: '所有已监控分组均处于正常状态',
  degraded: '部分分组当前存在不可用节点',
  unavailable: '当前没有可用的监控分组',
  unknown: '等待 FinOps 完成首次监控同步',
};

function multiplier(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '--';
  return `${parsed.toFixed(3).replace(/\.?0+$/, '')}x`;
}

function percent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '--';
  return `${parsed.toFixed(2).replace(/\.?0+$/, '')}%`;
}

function milliseconds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? `${Math.round(parsed)} ms` : '--';
}

function accountCount(group) {
  const available = Number(group.availableAccountCount);
  const total = Number(group.totalAccountCount);
  if (!Number.isFinite(available) || !Number.isFinite(total) || total <= 0) return '--';
  return `${Math.max(0, Math.round(available))}/${Math.max(0, Math.round(total))}`;
}

function formatDateTime(value) {
  if (!value) return '暂无观测';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '暂无观测';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function card(group) {
  const status = statusText[group.status] ? group.status : 'unknown';
  const model = group.modelLabel ? escapeHtml(group.modelLabel) : '分组整体状态';
  return `<article class="group-card is-${escapeHtml(status)}">
    <header class="group-card-header">
      <div class="group-title">
        <div class="group-symbol" aria-hidden="true"><img src="/icons/activity.svg" alt=""></div>
        <div class="group-heading">
          <h3 class="group-name">${escapeHtml(group.name || `分组 #${group.id}`)}</h3>
          <span class="group-model">${model}</span>
        </div>
      </div>
      <span class="status-badge is-${escapeHtml(status)}">
        <span class="status-dot" aria-hidden="true"></span>
        ${escapeHtml(statusText[status])}
      </span>
    </header>
    <div class="group-card-metrics">
      <div class="metric-box">
        <span class="metric-label">当前计费倍率</span>
        <strong class="metric-value">${escapeHtml(multiplier(group.currentMultiplier))}</strong>
      </div>
      <div class="metric-box">
        <span class="metric-label">可用率 · 7 天</span>
        <strong class="metric-value metric-value-percent">${escapeHtml(percent(group.availabilityPercent))}</strong>
      </div>
    </div>
    <div class="group-card-stats">
      <div>
        <span class="stat-label">可用账号</span>
        <strong>${escapeHtml(accountCount(group))}</strong>
      </div>
      <div>
        <span class="stat-label">平均响应</span>
        <strong>${escapeHtml(milliseconds(group.averageLatencyMs))}</strong>
      </div>
      <div>
        <span class="stat-label">节点 PING</span>
        <strong>${escapeHtml(milliseconds(group.averagePingLatencyMs))}</strong>
      </div>
    </div>
    <footer class="group-card-footer">
      <span><img src="/icons/refresh-cw.svg" alt="">最近观测</span>
      <time datetime="${escapeHtml(group.lastObservedAt || '')}">${escapeHtml(formatDateTime(group.lastObservedAt))}</time>
    </footer>
  </article>`;
}

function setRefreshInterval(value) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) refreshIntervalSeconds = Math.min(3600, Math.max(5, Math.round(parsed)));
}

function stopTimers() {
  if (refreshTimer) window.clearTimeout(refreshTimer);
  if (countdownTimer) window.clearInterval(countdownTimer);
  refreshTimer = null;
  countdownTimer = null;
}

function scheduleRefresh() {
  stopTimers();
  countdownSeconds = refreshIntervalSeconds;
  if (refreshCountdown) refreshCountdown.textContent = `${countdownSeconds}s`;
  countdownTimer = window.setInterval(() => {
    countdownSeconds = Math.max(0, countdownSeconds - 1);
    if (refreshCountdown) refreshCountdown.textContent = `${countdownSeconds}s`;
  }, 1000);
  refreshTimer = window.setTimeout(load, refreshIntervalSeconds * 1000);
}

function renderSummary(data, groups) {
  const fallbackStatus = groups.length && groups.every((group) => group.status === 'healthy')
    ? 'healthy'
    : groups.some((group) => group.status === 'unavailable')
      ? 'unavailable'
      : groups.some((group) => group.status === 'degraded')
        ? 'degraded'
        : 'unknown';
  const status = statusText[data.summary?.overallStatus] ? data.summary.overallStatus : fallbackStatus;
  const summary = data.summary || {};
  const healthy = Number(summary.healthyGroups || groups.filter((group) => group.status === 'healthy').length);
  const degraded = Number(summary.degradedGroups || groups.filter((group) => group.status === 'degraded').length);
  const unavailable = Number(summary.unavailableGroups || groups.filter((group) => group.status === 'unavailable').length);
  overallStatus.className = `overall-status is-${status}`;
  overallStatusLabel.textContent = overallText[status];
  summaryTitle.textContent = statusText[status];
  summaryDetail.textContent = statusDescription[status];
  groupCount.textContent = `${groups.length} 个监控分组`;
  statusSummary.textContent = groups.length
    ? `${healthy} 个正常 · ${degraded} 个部分可用 · ${unavailable} 个不可用`
    : '暂未配置公开监控分组';
}

async function load() {
  refreshButton.disabled = true;
  refreshButton.classList.add('is-spinning');
  try {
    const response = await fetch('/api/public/group-monitor', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    setRefreshInterval(data.refreshIntervalSeconds);
    const groups = Array.isArray(data.groups) ? data.groups : [];
    renderSummary(data, groups);
    grid.innerHTML = groups.length
      ? groups.map(card).join('')
      : '<div class="empty-monitor">暂无已启用的监控分组</div>';
  } catch (error) {
    overallStatus.className = 'overall-status is-unavailable';
    overallStatusLabel.textContent = 'OFFLINE';
    summaryTitle.textContent = '监控数据暂时不可用';
    summaryDetail.textContent = error.message || '读取公开监控接口失败';
    groupCount.textContent = '监控分组';
    statusSummary.textContent = '读取失败';
    grid.innerHTML = `<div class="monitor-error">监控数据暂时不可用<br><small>${escapeHtml(error.message)}</small></div>`;
  } finally {
    refreshButton.disabled = false;
    refreshButton.classList.remove('is-spinning');
    scheduleRefresh();
  }
}

refreshButton.addEventListener('click', load);
load();
