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

function multiplier(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '--';
  return `${parsed.toFixed(3).replace(/\.?0+$/, '')}x`;
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
  const status = group.status || 'unknown';
  return `<article class="group-card is-${escapeHtml(status)}">
    <header class="group-card-header">
      <div class="group-title">
        <div>
          <h2 class="group-name">${escapeHtml(group.name)}</h2>
          <span class="group-id">分组 #${escapeHtml(group.id)}</span>
        </div>
      </div>
      <span class="status-badge is-${escapeHtml(status)}">${escapeHtml(statusText[status] || statusText.unknown)}</span>
    </header>
    <div class="group-card-body">
      <span class="metric-label">当前计费倍率</span>
      <strong class="metric-value">${escapeHtml(multiplier(group.currentMultiplier))}</strong>
    </div>
    <footer class="group-card-footer">
      <span>状态数据</span>
      <time datetime="${escapeHtml(group.lastObservedAt || '')}">${escapeHtml(formatDateTime(group.lastObservedAt))}</time>
    </footer>
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
