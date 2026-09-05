const grid = document.querySelector('#group-grid');
const refreshButton = document.querySelector('#refresh-button');
const groupCount = document.querySelector('#group-count');
const statusSummary = document.querySelector('#status-summary');
const overallStatus = document.querySelector('#overall-status');
const overallStatusLabel = document.querySelector('#overall-status-label');
const refreshCountdown = document.querySelector('#refresh-countdown');
const rangeButtons = [...document.querySelectorAll('[data-window]')];

let refreshTimer = null;
let countdownTimer = null;
let refreshIntervalSeconds = 60;
let countdownSeconds = 60;
let selectedWindow = '7d';
let currentData = null;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
})[char]);

const statusText = {
  healthy: '运行正常',
  degraded: '响应较慢',
  unavailable: '不可用',
  unknown: '等待数据',
};

const statusClass = {
  healthy: 'healthy',
  degraded: 'degraded',
  unavailable: 'unavailable',
  unknown: 'unknown',
};

const overallText = {
  healthy: 'OPERATIONAL',
  degraded: 'SLOW RESPONSE',
  unavailable: 'UNAVAILABLE',
  unknown: 'PENDING',
};

const windowText = {
  '7d': '7 天',
  '15d': '15 天',
  '30d': '30 天',
};

const providerText = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  grok: 'Grok',
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
  if (value === null || value === undefined || value === '') return '--';
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? `${Math.round(parsed)} ms` : '--';
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

function relativeTime(value) {
  if (!value) return '暂无更新';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '暂无更新';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return '刚刚更新';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return formatDateTime(value);
}

function normalizedHistory(group) {
  const history = Array.isArray(group.history) ? group.history : [];
  return history.slice(-60);
}

function historyBar(point) {
  const status = statusClass[point?.status] || 'unknown';
  const details = [
    statusText[status],
    formatDateTime(point?.observedAt),
    milliseconds(point?.latencyMs) !== '--' ? `对话 ${milliseconds(point?.latencyMs)}` : '',
    milliseconds(point?.pingLatencyMs) !== '--' ? `PING ${milliseconds(point?.pingLatencyMs)}` : '',
  ].filter(Boolean).join(' · ');
  return `<span class="history-bar is-${status}" title="${escapeHtml(details)}"></span>`;
}

function card(group) {
  const status = statusClass[group.status] || 'unknown';
  const history = normalizedHistory(group);
  const availabilityByWindow = group.availabilityByWindow || { '7d': group.availabilityPercent };
  const availability = availabilityByWindow[selectedWindow];
  const provider = providerText[String(group.provider || '').toLowerCase()] || group.provider || '上游分组';
  const model = group.modelLabel || '分组整体状态';
  const historyBars = Array.from({ length: Math.max(0, 60 - history.length) }, () => null)
    .concat(history)
    .map((point) => point ? historyBar(point) : '<span class="history-bar is-unknown"></span>')
    .join('');
  return `<article class="group-card is-${escapeHtml(status)}">
    <header class="group-card-header">
      <div class="group-title">
        <div class="group-symbol" aria-hidden="true"><img src="/icons/activity.svg" alt=""></div>
        <div class="group-heading">
          <h3 class="group-name">${escapeHtml(group.name || `分组 #${group.id}`)}</h3>
          <div class="group-tags">
            <span class="provider-tag">${escapeHtml(provider)}</span>
            <span class="model-tag">${escapeHtml(model)}</span>
          </div>
        </div>
      </div>
      <span class="status-badge is-${escapeHtml(status)}">
        <span class="status-dot" aria-hidden="true"></span>
        ${escapeHtml(statusText[status])}
      </span>
    </header>
    <div class="group-rate">
      <span class="metric-label">当前计费倍率</span>
      <strong class="rate-value">${escapeHtml(multiplier(group.currentMultiplier))}</strong>
    </div>
    <div class="group-card-metrics">
      <div class="metric-box">
        <span class="metric-label">对话延迟</span>
        <strong class="metric-value">${escapeHtml(milliseconds(group.averageLatencyMs))}</strong>
      </div>
      <div class="metric-box">
        <span class="metric-label">端点 PING</span>
        <strong class="metric-value">${escapeHtml(milliseconds(group.averagePingLatencyMs))}</strong>
      </div>
    </div>
    <section class="availability-section">
      <div class="availability-heading">
        <span class="metric-label">可用性 · ${escapeHtml(windowText[selectedWindow])}</span>
        <strong class="availability-value">${escapeHtml(percent(availability))}</strong>
      </div>
      <div class="history-heading">
        <span>近 60 次记录</span>
      </div>
      <div class="history-bars" aria-label="${escapeHtml(`${group.name || '分组'}最近状态记录`)}">${historyBars}</div>
      <div class="history-axis"><span>过去</span><span>${escapeHtml(relativeTime(group.lastObservedAt))}</span><span>现在</span></div>
    </section>
    <footer class="group-card-footer">
      <time datetime="${escapeHtml(group.lastObservedAt || '')}">${escapeHtml(formatDateTime(group.lastObservedAt))}</time>
    </footer>
  </article>`;
}

function setRefreshInterval(value) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) refreshIntervalSeconds = Math.min(3600, Math.max(15, Math.round(parsed)));
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
  const healthy = Number(summary.healthyGroups ?? groups.filter((group) => group.status === 'healthy').length);
  const degraded = Number(summary.degradedGroups ?? groups.filter((group) => group.status === 'degraded').length);
  const unavailable = Number(summary.unavailableGroups ?? groups.filter((group) => group.status === 'unavailable').length);
  overallStatus.className = `overall-status is-${status}`;
  overallStatusLabel.textContent = overallText[status];
  groupCount.textContent = `${groups.length} 个监控分组`;
  statusSummary.textContent = groups.length
    ? `${healthy} 个正常 · ${degraded} 个响应较慢 · ${unavailable} 个不可用`
    : '暂未配置公开监控分组';
}

function renderGroups(data) {
  const groups = Array.isArray(data?.groups) ? data.groups : [];
  renderSummary(data || {}, groups);
  grid.innerHTML = groups.length
    ? groups.map(card).join('')
    : '<div class="empty-monitor">暂无已启用的监控分组</div>';
}

function selectWindow(value) {
  if (!windowText[value]) return;
  selectedWindow = value;
  rangeButtons.forEach((button) => {
    const active = button.dataset.window === selectedWindow;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (currentData) renderGroups(currentData);
}

async function load() {
  refreshButton.disabled = true;
  refreshButton.classList.add('is-spinning');
  try {
    const response = await fetch('/api/public/group-monitor', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    currentData = data;
    setRefreshInterval(data.refreshIntervalSeconds);
    renderGroups(data);
  } catch (error) {
    overallStatus.className = 'overall-status is-unavailable';
    overallStatusLabel.textContent = 'OFFLINE';
    groupCount.textContent = '监控分组';
    statusSummary.textContent = '读取失败';
    grid.innerHTML = `<div class="monitor-error">监控数据暂时不可用<br><small>${escapeHtml(error.message)}</small></div>`;
  } finally {
    refreshButton.disabled = false;
    refreshButton.classList.remove('is-spinning');
    scheduleRefresh();
  }
}

rangeButtons.forEach((button) => button.addEventListener('click', () => selectWindow(button.dataset.window)));
refreshButton.addEventListener('click', load);
load();
