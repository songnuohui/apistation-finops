const grid = document.querySelector('#group-grid');
const refreshButton = document.querySelector('#refresh-button');
const updatedLabel = document.querySelector('#updated-label');
const groupCount = document.querySelector('#group-count');
const statusSummary = document.querySelector('#status-summary');
const refreshNote = document.querySelector('.monitor-refresh-note');
let refreshTimer = null;
let refreshIntervalSeconds = 30;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
})[char]);

const statusText = {
  healthy: '运行正常',
  degraded: '部分可用',
  unavailable: '不可用',
  unknown: '等待数据',
};

function number(value, digits = 0) {
  if (value === null || value === undefined || value === '') return '--';
  return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

function multiplier(value) {
  if (value === null || value === undefined) return '--';
  return `${Number(value).toFixed(3).replace(/\.?0+$/, '')}x`;
}

function scheduleRefresh() {
  if (refreshTimer) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(load, refreshIntervalSeconds * 1000);
}

function setRefreshInterval(value) {
  const parsed = Number(value);
  if (Number.isFinite(parsed)) refreshIntervalSeconds = Math.min(3600, Math.max(5, Math.round(parsed)));
  if (refreshNote) refreshNote.textContent = `自动刷新 ${refreshIntervalSeconds} 秒`;
}

function relativeTime(value) {
  if (!value) return '暂无观测';
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function historyBars(history = []) {
  const items = history.length ? history : Array.from({ length: 60 }, () => ({ status: 'unknown' }));
  return items.slice(-60).map((item) => `<span class="history-bar is-${escapeHtml(item.status || 'unknown')}" title="${escapeHtml(statusText[item.status] || '等待数据')}"></span>`).join('');
}

function card(group) {
  const status = group.status || 'unknown';
  const latency = group.averageLatencyMs === null || group.averageLatencyMs === undefined
    ? '--'
    : `${number(group.averageLatencyMs)}<span class="metric-unit">ms</span>`;
  return `<article class="group-card is-${escapeHtml(status)}">
    <header class="group-card-header">
      <div class="group-title">
        <span class="group-mark"><img src="/icons/server-cog.svg" alt=""></span>
        <div>
          <h2 class="group-name">${escapeHtml(group.name)}</h2>
          <span class="group-model">${escapeHtml(group.modelLabel || `分组 #${group.sourceGroupId}`)}</span>
        </div>
      </div>
      <span class="status-badge is-${escapeHtml(status)}">${escapeHtml(statusText[status] || statusText.unknown)}</span>
    </header>
    <div class="group-multiplier"><span>当前倍率</span><strong>${escapeHtml(multiplier(group.configuredGroupMultiplier))}</strong></div>
    <div class="metric-row">
      <div class="metric-box"><span class="metric-label">响应延迟</span><strong class="metric-value">${latency}</strong></div>
    </div>
    <section class="availability">
      <div class="availability-head"><span>可用性 · 7 天</span><strong>${group.availabilityPercent === null || group.availabilityPercent === undefined ? '--' : `${number(group.availabilityPercent, 2)}%`}</strong></div>
      <div class="history-head"><span>近 60 次观测</span><span>${escapeHtml(relativeTime(group.lastObservedAt))}</span></div>
      <div class="history" aria-label="近 60 次观测状态">${historyBars(group.history)}</div>
      <div class="history-labels"><span>past</span><span>now</span></div>
    </section>
    <footer class="group-card-footer"><span>来源分组 #${escapeHtml(group.sourceGroupId)}</span><span>倍率与状态来自 FinOps 快照</span></footer>
  </article>`;
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
    const healthy = groups.filter((group) => group.status === 'healthy').length;
    groupCount.textContent = `${groups.length} 个分组`;
    statusSummary.textContent = groups.length ? `${healthy} 个运行正常，自动刷新中` : '暂未配置公开分组';
    grid.innerHTML = groups.length
      ? groups.map(card).join('')
      : '<div class="empty-monitor">暂无已启用的监控分组</div>';
    updatedLabel.textContent = data.generatedAt
      ? `更新于 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(data.generatedAt))}`
      : '已更新';
  } catch (error) {
    grid.innerHTML = `<div class="monitor-error">监控数据暂时不可用<br><small>${escapeHtml(error.message)}</small></div>`;
    statusSummary.textContent = '读取失败';
    updatedLabel.textContent = '连接异常';
  } finally {
    refreshButton.disabled = false;
    refreshButton.classList.remove('is-spinning');
    scheduleRefresh();
  }
}

refreshButton.addEventListener('click', load);
load();
