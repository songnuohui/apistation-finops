const state = {
  page: 'overview',
  range: '7d',
  customStart: '',
  customEnd: '',
  bootstrap: null,
  lastExport: [],
  tables: new Map(),
  selectedAccounts: new Set(),
  selectedUsers: new Set(),
  accountItems: new Map(),
  accountScope: 'current',
  accountSearch: '',
  userItems: new Map(),
  userSearch: '',
  userSort: 'userChargeCny',
  userSortDirection: 'desc',
  usageView: window.localStorage.getItem('finops.usage-view') === 'models' ? 'models' : 'events',
  usageSearch: '',
  overviewTrend: null,
  overviewMetrics: null,
  overviewAccountMasked: window.localStorage.getItem('finops.overview-account-masked') === 'true',
  userDetail: null,
  overviewDetail: null,
  whitelistManager: null,
  supplierSearch: '',
  supplierConnectionItems: new Map(),
  supplierDetail: null,
  runtimeRefreshTimer: null,
};

const RUNTIME_LIVE_REFRESH_MS = 3_000;
const NEW_PURCHASE_BATCH_VALUE = '__new_purchase_batch__';

const pageMeta = {
  overview: ['经营总览', '实收现金、用户实际消费、账号成本与经营毛利'],
  users: ['用户账务与利润', '充值、人工调账、实际消费和用户贡献'],
  accounts: ['账号台账与成本', '账号采购、成本归属、实际消费与毛利'],
  usage: ['用量与扣费', '按模型汇总或逐请求核查实际扣费、成本快照与计价来源'],
  suppliers: ['供应商与采购', '上游资源、采购批次与经营毛利'],
  costs: ['成本核算', '成本模板、生效期间和分摊方法'],
  runtime: ['并发与排队', '只读展示 Sub2API 当前并发、工作线程和排队负载'],
};

const content = document.querySelector('#content');
const title = document.querySelector('#page-title');
const subtitle = document.querySelector('#page-subtitle');
const rangeSelect = document.querySelector('#range-select');
const rangeTabs = document.querySelector('#range-tabs');
const customRange = document.querySelector('#custom-range');
const rangeStart = document.querySelector('#range-start');
const rangeEnd = document.querySelector('#range-end');
const rangeApply = document.querySelector('#range-apply');
const refreshButton = document.querySelector('#refresh-button');
const sidebarRefresh = document.querySelector('#sidebar-refresh');
const syncStatus = document.querySelector('#sync-status');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
})[char]);
const cny = (value) => new Intl.NumberFormat('zh-CN', {
  style: 'currency', currency: 'CNY', maximumFractionDigits: 2,
}).format(Number(value || 0));
const usd = (value) => new Intl.NumberFormat('zh-CN', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 2,
}).format(Number(value || 0));
const compact = (value) => new Intl.NumberFormat('zh-CN', {
  notation: 'compact', maximumFractionDigits: 2,
}).format(Number(value || 0));
const percent = (value) => value === null || value === undefined ? '--' : `${(Number(value) * 100).toFixed(1)}%`;
const icon = (name) => `<img src="/icons/${name}.svg" alt="">`;
const profitClass = (value) => Number(value) >= 0 ? 'money-positive' : 'money-negative';
const dateTime = (value) => value ? new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
}).format(new Date(value)) : '--';
const dateOnly = (value) => value ? new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(value)) : '--';

function dateInputValue(value = new Date()) {
  const offset = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offset).toISOString().slice(0, 10);
}

function dateTimeInputValue(value) {
  if (!value) return '';
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function metric(label, value, hint = '', tone = '') {
  return `<div class="metric ${tone}"><div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></div>`;
}

function metricAction(label, value, hint = '', tone = '', action = '') {
  return `<button type="button" class="metric metric-action ${tone}" ${action}><span class="label">${label}</span><span class="value">${value}</span><span class="hint">${hint}</span></button>`;
}

function maskedIdentity(value) {
  const text = String(value || '');
  if (!text) return '用户';
  const at = text.indexOf('@');
  if (at > 0) return `${text.slice(0, Math.min(2, at))}****${text.slice(at)}`;
  return `${text.slice(0, Math.min(2, text.length))}****`;
}

function overviewIdentity(item, field = 'email') {
  const value = item[field] || (field === 'email' ? item.username : '') || `用户 #${item.id}`;
  return state.overviewAccountMasked ? maskedIdentity(value) : String(value);
}

function modelName(item) {
  return String(item?.name || item?.model || '').trim() || '未标注模型';
}

function dashboardRankList(items, {
  value,
  detail,
  identity = (item) => overviewIdentity(item),
  secondary = (item) => (item.username && item.username !== item.email
    ? (state.overviewAccountMasked ? maskedIdentity(item.username) : item.username)
    : ''),
}) {
  if (!items.length) return '<div class="dashboard-rank-empty">当前周期暂无数据</div>';
  return items.map((item, index) => {
    const secondaryText = secondary(item);
    return `<div class="dashboard-rank-item">
      <span class="dashboard-rank-index">${index + 1}</span>
      <div class="dashboard-rank-user"><strong>${escapeHtml(identity(item))}</strong>${secondaryText ? `<small>${escapeHtml(secondaryText)}</small>` : ''}</div>
      <div class="dashboard-rank-value"><strong>${value(item)}</strong><small>${detail(item)}</small></div>
    </div>`;
  }).join('');
}

function section(titleText, description) {
  return `<div class="section-heading"><div><h2>${titleText}</h2><p>${description}</p></div></div>`;
}

function tags(values = []) {
  return values.length
    ? values.map((value) => `<span class="tag">${escapeHtml(value)}</span>`).join('')
    : '<span class="secondary-text">无标签</span>';
}

function costModeLabel(value) {
  return ({
    probe_multiplier: '探测上游倍率',
    manual_multiplier: '手动上游倍率',
    fixed_purchase: '固定采购成本',
    free: '免费资源',
    unconfigured: '未配置',
  })[value] || value || '未配置';
}

function costCoverage(item) {
  if (item.costCoverageStatus === 'complete') return '<span class="status">已核算</span>';
  if (item.costCoverageStatus === 'pending') return '<span class="status warning">尚无用量</span>';
  if (item.costCoverageStatus === 'historical_unpriced') {
    return '<span class="status warning" title="该账号已从 sub2api 删除，历史成本尚未追溯，不计入已核算成本">历史成本未追溯</span>';
  }
  return `<span class="status warning">待补成本${item.unbookedAccountCount ? ` · ${compact(item.unbookedAccountCount)} 账号` : item.unpricedUserChargeCny ? ` · ${cny(item.unpricedUserChargeCny)}` : ''}</span>`;
}

function toast(message) {
  const element = document.querySelector('#toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, 2800);
}

async function api(path, options = {}) {
  const url = new URL(`/api${path}`, location.origin);
  if (options.range !== false) {
    url.searchParams.set('range', state.range);
    if (state.range === 'custom') {
      url.searchParams.set('start', state.customStart);
      url.searchParams.set('end', state.customEnd);
    }
  }
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (response.status === 401) {
    location.assign('/login');
    throw new Error('登录状态已失效，请重新登录');
  }
  const body = await response.text();
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error(`数据服务暂时不可用（HTTP ${response.status}）`);
  }
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('数据服务返回了无效响应'); }
  if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
  return data;
}

function table(headers, rows, minWidth = 900) {
  return `<div class="table-scroll"><table class="data-table" style="min-width:${minWidth}px"><thead><tr>${
    headers.map((header) => `<th class="${header.right ? 'number' : ''}">${header.label}</th>`).join('')
  }</tr></thead><tbody>${
    rows.length
      ? rows.map((row) => `<tr>${row.map((cell, index) => `<td class="${headers[index]?.right ? 'number' : ''}">${cell}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${headers.length}" class="empty">当前筛选范围没有数据</td></tr>`
  }</tbody></table></div>`;
}

function tableState(key) {
  if (!state.tables.has(key)) state.tables.set(key, { page: 1, pageSize: 20 });
  return state.tables.get(key);
}

function queryFor(key, search = '', extra = {}) {
  const current = tableState(key);
  const query = new URLSearchParams({ page: String(current.page), page_size: String(current.pageSize) });
  if (search) query.set('search', search);
  Object.entries(extra).forEach(([name, value]) => {
    if (value !== undefined && value !== null && value !== '') query.set(name, String(value));
  });
  return query.toString();
}

function localPage(items, key) {
  const current = tableState(key);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / current.pageSize));
  current.page = Math.min(Math.max(1, current.page), pages);
  const start = (current.page - 1) * current.pageSize;
  return { items: items.slice(start, start + current.pageSize), total, page: current.page, pageSize: current.pageSize };
}

function pageNumbers(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1);
  const visible = new Set([1, 2, pages - 1, pages]);
  for (let value = page - 1; value <= page + 1; value += 1) {
    if (value > 0 && value <= pages) visible.add(value);
  }
  const numbers = [...visible].sort((left, right) => left - right);
  return numbers.flatMap((value, index) => (
    index && value - numbers[index - 1] > 1 ? ['ellipsis', value] : [value]
  ));
}

function pager(data, key, label = '条记录') {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return `<div class="pager">
    <span>共 ${compact(data.total)} ${label}</span>
    <label>每页<select data-page-size="${escapeHtml(key)}">${
      [10, 20, 50, 100].map((size) => `<option value="${size}" ${size === data.pageSize ? 'selected' : ''}>${size}</option>`).join('')
    }</select></label>
    <div class="pager-nav" aria-label="分页">
      <button type="button" class="icon-button pager-button" data-page-prev="${escapeHtml(key)}" title="上一页" ${data.page <= 1 ? 'disabled' : ''}>&lsaquo;</button>
      ${pageNumbers(data.page, pages).map((value) => value === 'ellipsis'
        ? '<span class="pager-ellipsis">…</span>'
        : `<button type="button" class="page-number ${value === data.page ? 'active' : ''}" data-page-to="${escapeHtml(key)}" data-page-number="${value}" ${value === data.page ? 'aria-current="page"' : ''}>${value}</button>`).join('')}
      <button type="button" class="icon-button pager-button" data-page-next="${escapeHtml(key)}" title="下一页" ${data.page >= pages ? 'disabled' : ''}>&rsaquo;</button>
    </div>
    <span>第 ${data.page} / ${pages} 页</span>
  </div>`;
}

function searchTools(placeholder, actions = '', searchValue = '') {
  return `<div class="table-tools"><div class="search">${icon('search')}<input id="table-search" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(searchValue)}"></div><div class="table-actions">${actions}</div></div>`;
}

function drawTrend(canvas, items) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const width = rect.width;
  const height = rect.height;
  const padding = { left: 44, right: 14, top: 19, bottom: 34 };
  ctx.clearRect(0, 0, width, height);
  if (!items.length) return;
  const keys = [['consumptionCny', '#2f6feb'], ['bookedCostCny', '#d85d18'], ['bookedProfitCny', '#178545']];
  const max = Math.max(...items.flatMap((item) => keys.map(([key]) => Number(item[key] ?? item.revenue ?? 0)))) * 1.12 || 1;
  ctx.font = '10px Microsoft YaHei';
  ctx.strokeStyle = '#e8ecee';
  ctx.fillStyle = '#76818a';
  for (let index = 0; index < 5; index += 1) {
    const y = padding.top + (height - padding.top - padding.bottom) * index / 4;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillText(compact(max * (1 - index / 4)), 4, y + 3);
  }
  keys.forEach(([key, color]) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    items.forEach((item, index) => {
      const x = padding.left + (width - padding.left - padding.right) * index / Math.max(1, items.length - 1);
      const value = Number(item[key] ?? (key === 'consumptionCny' ? item.revenue : 0));
      const y = padding.top + (height - padding.top - padding.bottom) * (1 - value / max);
      if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.stroke();
  });
  items.forEach((item, index) => {
    if (index % Math.ceil(items.length / 7) !== 0 && index !== items.length - 1) return;
    const x = padding.left + (width - padding.left - padding.right) * index / Math.max(1, items.length - 1);
    ctx.fillStyle = '#76818a';
    ctx.fillText(item.day.slice(5), x - 12, height - 10);
  });
  [['实际消费', '#2f6feb'], ['已登记成本', '#d85d18'], ['经营毛利', '#178545']].forEach(([label, color], index) => {
    ctx.fillStyle = color;
    ctx.fillRect(padding.left + index * 92, 2, 9, 3);
    ctx.fillStyle = '#58636c';
    ctx.fillText(label, padding.left + 14 + index * 92, 8);
  });
}

function chartTooltip(canvas) {
  const host = canvas.parentElement;
  let tooltip = host.querySelector('.chart-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    tooltip.hidden = true;
    host.append(tooltip);
  }
  return tooltip;
}

function drawTrendWithTooltip(canvas, items, { rechargeEvents = [], title = '', series: seriesOverride = null } = {}) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const width = rect.width;
  const height = rect.height;
  const padding = { left: 48, right: 16, top: 27, bottom: 34 };
  const series = seriesOverride || [
    { key: 'consumptionCny', label: '实际消费', color: '#2563eb' },
    { key: 'bookedCostCny', label: '已登记成本', color: '#d97706' },
    { key: 'bookedProfitCny', label: '经营毛利', color: '#078a57' },
    { key: 'rechargeCny', label: '充值实收', color: '#b45309' },
  ];
  const tooltip = chartTooltip(canvas);
  ctx.clearRect(0, 0, width, height);
  if (!items.length) {
    tooltip.hidden = true;
    return;
  }

  const values = items.flatMap((item) => series.map(({ key }) => Number(item[key] || 0)));
  const max = Math.max(1, ...values) * 1.12;
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const xAt = (index) => padding.left + chartWidth * index / Math.max(1, items.length - 1);
  const yAt = (value) => padding.top + chartHeight * (1 - Number(value || 0) / max);

  ctx.font = '10px Microsoft YaHei';
  ctx.strokeStyle = '#e7edf5';
  ctx.fillStyle = '#718096';
  for (let index = 0; index < 5; index += 1) {
    const y = padding.top + chartHeight * index / 4;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillText(compact(max * (1 - index / 4)), 3, y + 3);
  }

  series.forEach(({ key, color }) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    items.forEach((item, index) => {
      const x = xAt(index);
      const y = yAt(item[key]);
      if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.stroke();
    items.forEach((item, index) => {
      ctx.beginPath();
      ctx.fillStyle = '#fff';
      ctx.arc(xAt(index), yAt(item[key]), 2.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = color;
      ctx.stroke();
    });
  });

  items.forEach((item, index) => {
    if (index % Math.ceil(items.length / 7) !== 0 && index !== items.length - 1) return;
    const x = xAt(index);
    ctx.fillStyle = '#718096';
    ctx.fillText(String(item.day).slice(5), x - 12, height - 10);
  });
  series.forEach(({ label, color }, index) => {
    const x = padding.left + index * 106;
    ctx.fillStyle = color;
    ctx.fillRect(x, 4, 9, 3);
    ctx.fillStyle = '#58636c';
    ctx.fillText(label, x + 14, 10);
  });

  const showTooltip = (event) => {
    const bounds = canvas.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const index = Math.max(0, Math.min(items.length - 1, Math.round((x - padding.left) / chartWidth * Math.max(1, items.length - 1))));
    const item = items[index];
    const pointX = xAt(index);
    const rows = series.map(({ key, label, color }) => (
      `<div><i style="background:${color}"></i><span>${label}</span><strong>${cny(item[key])}</strong></div>`
    ));
    if (rechargeEvents.length) {
      const events = rechargeEvents.map((entry) => (
        `<div class="chart-event"><span>${dateTime(entry.occurredAt)}</span><strong>${cny(entry.amountCny)}</strong></div>`
      )).join('');
      rows.push(`<div class="chart-event-title">今日逐笔充值</div>${events}`);
    }
    tooltip.innerHTML = `<p>${escapeHtml(title ? `${title} · ${item.day}` : item.day)}</p>${rows.join('')}`;
    tooltip.hidden = false;
    tooltip.style.left = `${Math.min(width - 184, Math.max(8, pointX + 12))}px`;
    tooltip.style.top = '22px';
  };

  canvas.onmousemove = showTooltip;
  canvas.onmouseenter = showTooltip;
  canvas.onmouseleave = () => { tooltip.hidden = true; };
}

function applySyncState(sync) {
  const status = sync?.status || 'pending';
  syncStatus?.classList.toggle('pending', status === 'pending');
  syncStatus?.classList.toggle('error', status !== 'healthy' && status !== 'pending');
  const label = document.querySelector('#sync-label');
  const detail = document.querySelector('#sync-detail');
  if (label) label.textContent = status === 'healthy' ? '同步正常' : status === 'pending' ? '等待首次同步' : '同步异常';
  if (detail) detail.textContent = sync?.lagSeconds === null || sync?.lagSeconds === undefined ? '尚无数据' : `延迟 ${Math.round(sync.lagSeconds)} 秒`;
}

function setRange(range) {
  if (range === 'custom') {
    customRange.hidden = false;
    if (!rangeStart.value) rangeStart.value = state.customStart || dateInputValue(new Date(Date.now() - 6 * 86_400_000));
    if (!rangeEnd.value) rangeEnd.value = state.customEnd || dateInputValue();
    return;
  }
  state.range = range;
  customRange.hidden = true;
  if (rangeSelect) rangeSelect.value = range;
  rangeTabs.querySelectorAll('[data-range]').forEach((button) => {
    const active = button.dataset.range === range;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  render();
}

function applyCustomRange() {
  if (!rangeStart.value || !rangeEnd.value || rangeStart.value > rangeEnd.value) {
    toast('请选择有效的起止日期');
    return;
  }
  state.range = 'custom';
  state.customStart = rangeStart.value;
  state.customEnd = rangeEnd.value;
  if (rangeSelect) rangeSelect.value = 'custom';
  rangeTabs.querySelectorAll('[data-range]').forEach((button) => {
    const active = button.dataset.range === 'custom';
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  render();
}

function runtimeQueueUsagePercent(queue) {
  const value = Number(queue?.queueUsagePercent || 0);
  return value <= 1 ? value * 100 : value;
}

function overviewRuntimePanel(data) {
  const queue = data?.queue || { available: false };
  const activeUsers = (data?.users || []).filter((item) => Number(item.currentConcurrency || 0) > 0);
  const users = activeUsers.slice(0, 5);
  const queueUsage = runtimeQueueUsagePercent(queue);
  const workerCount = Number(queue.workerCount || 0);
  const activeWorkers = Number(queue.activeWorkers || 0);
  const observedAt = queue.observedAt || users[0]?.observedAt;
  return `<section class="panel dashboard-runtime-panel" id="overview-runtime-panel">
    <div class="panel-header">
      <div><h2>实时并发与排队</h2><span>${queue.available ? `采样于 ${dateTime(observedAt)}` : '等待运行快照'}</span></div>
      <label class="visibility-toggle"><input type="checkbox" data-overview-mask ${state.overviewAccountMasked ? 'checked' : ''}><span>隐藏账号</span></label>
    </div>
    <div class="dashboard-runtime-metrics">
      <div><span>排队长度</span><strong>${queue.available ? compact(queue.queueLength) : '--'}</strong><small>${queue.available ? `容量 ${compact(queue.queueSize)} · ${queueUsage.toFixed(1)}%` : '暂无上游快照'}</small></div>
      <div><span>工作线程</span><strong>${queue.available ? `${activeWorkers} / ${workerCount}` : '--'}</strong><small>${queue.available ? `空闲 ${compact(queue.idleWorkers || 0)}` : '暂无上游快照'}</small></div>
      <div><span>当前并发用户</span><strong>${compact(activeUsers.length)}</strong><small>${queue.available ? (queue.enabled ? '队列已启用' : '队列未启用') : '等待同步'}</small></div>
    </div>
    <div class="dashboard-runtime-users">${
      users.length ? users.map((item) => {
        const maxConcurrency = Number(item.maxConcurrency || 0);
        const currentConcurrency = Number(item.currentConcurrency || 0);
        const usage = item.usagePercent === null || item.usagePercent === undefined
          ? '--'
          : `${Number(item.usagePercent).toFixed(1)}%`;
        return `<div class="dashboard-runtime-user">
          <div><strong>${escapeHtml(overviewIdentity(item))}</strong><small>ID ${item.id}${item.username && item.username !== item.email ? ` · ${escapeHtml(state.overviewAccountMasked ? maskedIdentity(item.username) : item.username)}` : ''}</small></div>
          <div><strong>${compact(currentConcurrency)} / ${compact(maxConcurrency)}</strong><small>并发 · ${usage}</small></div>
        </div>`;
      }).join('') : '<div class="dashboard-runtime-empty">暂无正在执行的用户请求</div>'
    }</div>
  </section>`;
}

async function refreshOverviewRuntimePanel() {
  if (state.page !== 'overview') return;
  const current = document.querySelector('#overview-runtime-panel');
  if (!current) return;
  const data = await api('/runtime?live=1', { range: false });
  if (state.page === 'overview' && current.isConnected) current.outerHTML = overviewRuntimePanel(data);
}

async function renderOverview() {
  const [dashboard, trendData, modelData, runtimeData] = await Promise.all([
    api('/overview-dashboard'),
    api('/trend'),
    api(`/usage/models?${queryFor('overviewModels', '', { sort: 'userChargeCny', direction: 'desc' })}`),
    api('/runtime?live=1', { range: false }),
  ]);
  const summary = dashboard.summary || {};
  const operations = summary.operations || {};
  const cash = summary.cash || {};
  const usage = summary.usage || {};
  const alerts = summary.alerts || [];
  const netRecharge = Number(cash.rechargeReceived || 0) - Number(cash.refunds || 0);
  const consumptionCny = Number(operations.consumptionCny ?? operations.userChargeCny ?? 0);
  const totalCostCny = Number(operations.effectiveCostCny ?? operations.bookedCostCny ?? 0);
  const grossProfitCny = Number(operations.grossProfitCny ?? operations.bookedProfitCny ?? consumptionCny - totalCostCny);
  const grossMargin = operations.grossMargin ?? (consumptionCny ? grossProfitCny / consumptionCny : null);
  const totalTokens = Number(usage.inputTokens || 0)
    + Number(usage.outputTokens || 0)
    + Number(usage.cacheTokens || 0);
  state.overviewMetrics = {
    consumptionCny,
    totalCostCny,
    grossProfitCny,
    grossMargin,
    requests: Number(usage.requests || 0),
    totalTokens,
    balanceCny: Number(dashboard.totals.balanceCny || 0),
    balanceUserCount: Number(dashboard.totals.balanceUserCount || 0),
  };
  state.lastExport = [
    ...dashboard.rankings.tokenUsage.map((item) => ({ ranking: 'Token 使用排行', ...item })),
    ...dashboard.rankings.cashRecharge.map((item) => ({ ranking: '用户充值排行', ...item })),
    ...(runtimeData.users || []).map((item) => ({ ranking: '实时用户并发', ...item })),
  ];
  content.innerHTML = `<div class="dashboard-meta"><span>运营看板</span><small>更新于 ${dateTime(dashboard.generatedAt)}</small></div>
    <div class="dashboard-metric-grid">
      ${metricAction('充值净额', cny(netRecharge), `充值实收 ${cny(cash.rechargeReceived)} · 已退款 ${cny(cash.refunds)} · 查看明细`, netRecharge >= 0 ? 'good' : 'bad', 'data-open-overview-detail="recharge"')}
      ${metricAction('赠送金额', cny(dashboard.totals.giftBalanceCreditCny), `${compact(dashboard.totals.giftBalanceCreditCount)} 笔赠送、兑换或返利入账 · 查看明细`, 'good', 'data-open-overview-detail="gift"')}
      ${metricAction('退款金额', cny(cash.refunds), '已从充值净额扣除 · 查看退款明细', Number(cash.refunds || 0) ? 'warn' : '', 'data-open-overview-detail="recharge"')}
      ${metricAction('总消耗', cny(consumptionCny), `${compact(usage.requests)} 次请求 · 查看明细`, '', 'data-open-overview-detail="consumption"')}
      ${metricAction('剩余余额', cny(dashboard.totals.balanceCny), `${compact(dashboard.totals.balanceUserCount)} 位余额用户 · 查看明细`, '', 'data-open-overview-detail="balance"')}
      ${metricAction('总 Token', compact(totalTokens), '输入、输出与缓存合计 · 查看明细', '', 'data-open-overview-detail="tokens"')}
    </div>
    <div class="overview-ranking-grid">
      ${overviewRuntimePanel(runtimeData)}
      <section class="panel dashboard-rank-panel">
        <div class="panel-header"><h2>Token 使用排行</h2><span>${compact(dashboard.rankings.tokenUsage.length)} 位用户</span></div>
        <div class="dashboard-rank-list">${
          dashboardRankList(dashboard.rankings.tokenUsage, {
            value: (item) => compact(item.tokens),
            detail: (item) => `${compact(item.requests)} 次请求`,
          })
        }</div>
      </section>
      <section class="panel dashboard-rank-panel">
        <div class="panel-header"><h2>用户充值排行</h2><span>${compact(dashboard.rankings.cashRecharge.length)} 位用户</span></div>
        <div class="dashboard-rank-list">${
          dashboardRankList(dashboard.rankings.cashRecharge, {
            value: (item) => cny(item.cashPaidCny),
            detail: () => '现金实收',
          })
        }</div>
      </section>
    </div>
    ${section('经营趋势', '实际消费、已登记成本和经营毛利按日汇总')}
    <div class="split">
      <section class="panel"><div class="panel-header"><h2>实际消费、成本与毛利趋势</h2><span>按日</span></div><div class="chart-wrap"><canvas id="trend-chart"></canvas></div></section>
      <section class="panel"><div class="panel-header"><h2>待处理事项</h2><span>${alerts.length} 项</span></div><div class="alert-list">${
        alerts.length ? alerts.map((alert) => `<div class="alert ${alert.severity}"><span class="alert-dot"></span><div><strong>${escapeHtml(alert.title)}</strong><p>${escapeHtml(alert.detail)}</p></div></div>`).join('') : '<div class="empty">没有待处理事项</div>'
      }</div></section>
    </div>
    <section class="table-panel"><div class="panel-header"><h2>模型单位经济性</h2><span>实际消费与已登记成本</span></div>${
      table([
        { label: '模型' }, { label: '请求', right: true }, { label: 'Token', right: true }, { label: '标准牌价 USD', right: true },
        { label: '用户实际消费 CNY', right: true }, { label: '已登记成本 CNY', right: true }, { label: '经营毛利 CNY', right: true }, { label: '成本覆盖' },
      ], modelData.items.map((item) => [
        `<span class="primary-text">${escapeHtml(modelName(item))}</span>`, compact(item.requests), compact(item.tokens), usd(item.tokenListValueUsd),
        cny(item.userChargeCny), cny(item.bookedCostCny), `<span class="${profitClass(item.bookedProfitCny)}">${cny(item.bookedProfitCny)}</span>`, costCoverage(item),
      ]), 1220)
    }${pager(modelData, 'overviewModels', '个模型')}</section>`;
  state.overviewTrend = trendData;
  requestAnimationFrame(() => drawTrendWithTooltip(
    document.querySelector('#trend-chart'),
    trendData.items.map((item) => ({ ...item, consumptionCny: item.userChargeCny })),
    { rechargeEvents: trendData.rechargeEvents, title: '经营趋势' },
  ));
}

function bindSearch(renderer) {
  const input = document.querySelector('#table-search');
  let timer;
  input?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      tableState(`${state.page}Search`).page = 1;
      renderer(input.value);
    }, 260);
  });
}

async function renderUsers(search = '') {
  const data = await api(`/users?${queryFor('usersSearch', search)}`);
  state.lastExport = data.items;
  content.innerHTML = `${section('用户核算', '现金充值、管理员调账、实际消费和成本分别核对')}
    <section class="table-panel">${searchTools('搜索邮箱、用户名', '', search)}${
      table([
        { label: '用户' }, { label: '现金实收 CNY', right: true }, { label: '管理员加款 CNY', right: true }, { label: '管理员扣款 CNY', right: true },
        { label: '当前余额 CNY', right: true }, { label: '实际消费 CNY', right: true }, { label: '请求', right: true }, { label: 'Token', right: true },
        { label: '已登记成本 CNY', right: true }, { label: '经营毛利 CNY', right: true }, { label: '成本覆盖' },
      ], data.items.map((item) => [
        `<span class="primary-text">${escapeHtml(item.email)}</span><div class="secondary-text">ID ${item.id} · ${tags(item.tags)}</div>`,
        cny(item.cashPaidCny), cny(item.adminCreditCny), cny(item.adminDeductionCny), cny(item.balanceCny), cny(item.userChargeCny),
        compact(item.requests), compact(item.tokens), cny(item.bookedCostCny), `<span class="${profitClass(item.bookedProfitCny)}">${cny(item.bookedProfitCny)}</span>`, costCoverage(item),
      ]), 1450)
    }${pager(data, 'usersSearch', '位用户')}</section>`;
  bindSearch(renderUsers);
}

function userSortHeader(label, key) {
  const active = state.userSort === key;
  const direction = active ? state.userSortDirection : '';
  const indicator = direction === 'asc' ? '↑' : direction === 'desc' ? '↓' : '↕';
  return `<button type="button" class="sort-button ${active ? 'active' : ''}" data-user-sort="${key}" aria-label="按${label}排序">${label}<span>${indicator}</span></button>`;
}

function detailRangeFor(preset, customStart = '', customEnd = '') {
  if (preset === 'custom' && customStart && customEnd) return { start: customStart, end: customEnd };
  const end = new Date();
  const start = new Date(end);
  if (preset === 'today') {
    return { start: dateInputValue(start), end: dateInputValue(end) };
  }
  if (preset === '30d') start.setDate(start.getDate() - 29);
  else if (preset === 'month') start.setDate(1);
  else start.setDate(start.getDate() - 6);
  return { start: dateInputValue(start), end: dateInputValue(end) };
}

function defaultDetailRange() {
  return detailRangeFor(state.range, state.customStart, state.customEnd);
}

function detailRangeTabs(active) {
  return [
    ['today', '今天'], ['7d', '近 7 天'], ['30d', '近 30 天'], ['month', '本月'], ['custom', '自定义'],
  ].map(([value, label]) => (
    `<button type="button" class="${active === value ? 'active' : ''}" data-detail-range="${value}" aria-pressed="${active === value}">${label}</button>`
  )).join('');
}

function userDetailParams() {
  const detail = state.userDetail;
  return new URLSearchParams({
    range: 'custom',
    start: detail.start,
    end: detail.end,
    recharge_page: String(detail.rechargePage),
    usage_page: String(detail.usagePage),
    detail_page_size: String(detail.pageSize),
  });
}

function userDetailPager(data, kind, label) {
  const key = `detail-${kind}`;
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return `<div class="detail-pager">
    <span>共 ${compact(data.total)} ${label}</span>
    <div class="pager-nav">
      <button type="button" class="icon-button pager-button" data-detail-page="${kind}" data-detail-target="${Math.max(1, data.page - 1)}" ${data.page <= 1 ? 'disabled' : ''}>&lsaquo;</button>
      ${pageNumbers(data.page, pages).map((value) => value === 'ellipsis'
        ? '<span class="pager-ellipsis">…</span>'
        : `<button type="button" class="page-number ${value === data.page ? 'active' : ''}" data-detail-page="${kind}" data-detail-target="${value}">${value}</button>`).join('')}
      <button type="button" class="icon-button pager-button" data-detail-page="${kind}" data-detail-target="${Math.min(pages, data.page + 1)}" ${data.page >= pages ? 'disabled' : ''}>&rsaquo;</button>
    </div>
    <span>第 ${data.page} / ${pages} 页</span>
  </div>`;
}

function renderUserDetailModal(data) {
  const user = data.user;
  const detail = state.userDetail;
  const userName = user.username || user.email;
  openContentModal(`${userName} 的账户明细`, `
    <div class="detail-filter">
      <div class="detail-range-tabs" role="group" aria-label="用户明细统计周期">${detailRangeTabs(detail.range)}</div>
      <div class="detail-custom-range" ${detail.range === 'custom' ? '' : 'hidden'}>
        <label><span>开始日期</span><input id="detail-range-start" type="date" value="${escapeHtml(detail.start)}"></label>
        <label><span>结束日期</span><input id="detail-range-end" type="date" value="${escapeHtml(detail.end)}"></label>
        <button type="button" class="button primary" id="detail-range-apply">查询</button>
      </div>
      <span class="detail-range-note">仅查看该用户在选定日期内的真实充值与消费</span>
    </div>
    <div class="detail-user-heading">
      <div><strong>${escapeHtml(user.email)}</strong><span>ID ${user.id}${user.tags?.length ? ` · ${tags(user.tags)}` : ''}</span></div>
      <span class="status">${escapeHtml(user.status || 'active')}</span>
    </div>
    <div class="detail-metrics">
      ${metric('充值实收', cny(user.rechargeCny), `到账额度 ${cny(user.creditedCny)}`, 'good')}
      ${metric('实际消费', cny(user.consumptionCny), `${compact(user.requests)} 次请求`, 'warn')}
      ${metric('管理员调账', cny(user.adminCreditCny - user.adminDeductionCny), `加款 ${cny(user.adminCreditCny)} · 扣款 ${cny(user.adminDeductionCny)}`)}
      ${metric('当前余额', cny(user.balanceCny), `Token ${compact(user.tokens)}`, user.balanceCny >= 0 ? 'good' : 'bad')}
    </div>
    <section class="detail-section">
      <div class="detail-section-header"><h3>充值与消费趋势</h3><span>按日汇总</span></div>
      <div class="chart-wrap detail-chart-wrap"><canvas id="user-detail-chart"></canvas></div>
    </section>
    <section class="detail-section">
      <div class="detail-section-header"><h3>充值明细</h3><span>支付成功记录</span></div>
      ${table([
        { label: '支付时间' }, { label: '订单号' }, { label: '支付方式' },
        { label: '实收 CNY', right: true }, { label: '到账额度 CNY', right: true },
      ], data.recharges.items.map((item) => [
        dateTime(item.occurredAt), `<span class="primary-text">${escapeHtml(item.reference)}</span>`,
        escapeHtml(item.paymentMethod || '--'), cny(item.amountCny), cny(item.creditedCny),
      ]), 720)}
      ${userDetailPager(data.recharges, 'recharge', '笔充值')}
    </section>
    <section class="detail-section">
      <div class="detail-section-header"><h3>消费明细</h3><span>sub2api 实际扣费记录</span></div>
      ${table([
        { label: '扣费时间' }, { label: '模型' }, { label: '账号' },
        { label: 'Token', right: true }, { label: '实际消费 CNY', right: true }, { label: '耗时', right: true },
      ], data.usage.items.map((item) => [
        dateTime(item.occurredAt), `<span class="primary-text">${escapeHtml(item.model)}</span><div class="secondary-text">${escapeHtml(item.requestedModel || '')}</div>`,
        `#${escapeHtml(item.accountId)}`, compact(item.tokens), cny(item.userChargeCny),
        item.durationMs ? `${(item.durationMs / 1000).toFixed(2)}s` : '--',
      ]), 840)}
      ${userDetailPager(data.usage, 'usage', '笔消费')}
    </section>
  `, 'user-detail-modal');
  requestAnimationFrame(() => drawUserDetailTrend(data.trend));

  const form = document.querySelector('#modal-form');
  form.onclick = async (event) => {
    const rangeButton = event.target.closest('[data-detail-range]');
    if (rangeButton) {
      const preset = rangeButton.dataset.detailRange;
      if (preset === detail.range) return;
      detail.range = preset;
      detail.rechargePage = 1;
      detail.usagePage = 1;
      if (preset === 'custom') {
        renderUserDetailModal(data);
        return;
      }
      const range = detailRangeFor(preset);
      detail.start = range.start;
      detail.end = range.end;
      await loadUserDetails();
      return;
    }
    const pagerButton = event.target.closest('[data-detail-page]');
    if (!pagerButton || pagerButton.disabled) return;
    const kind = pagerButton.dataset.detailPage;
    detail[`${kind}Page`] = Number(pagerButton.dataset.detailTarget);
    await loadUserDetails();
  };
  document.querySelector('#detail-range-apply')?.addEventListener('click', async () => {
    const start = document.querySelector('#detail-range-start').value;
    const end = document.querySelector('#detail-range-end').value;
    if (!start || !end || start > end) return toast('请选择有效的日期范围');
    detail.range = 'custom';
    detail.start = start;
    detail.end = end;
    detail.rechargePage = 1;
    detail.usagePage = 1;
    await loadUserDetails();
  });
}

function drawUserDetailTrend(items) {
  drawTrendWithTooltip(document.querySelector('#user-detail-chart'), items, {
    title: '用户趋势',
    series: [
      { key: 'consumptionCny', label: '实际消费', color: '#2563eb' },
      { key: 'rechargeCny', label: '充值实收', color: '#b45309' },
    ],
  });
}

async function loadUserDetails() {
  const detail = state.userDetail;
  if (!detail) return;
  const form = document.querySelector('#modal-form');
  if (form) form.innerHTML = '<div class="detail-loading"><span></span>正在读取用户明细</div>';
  try {
    const data = await api(`/users/${detail.id}/details?${userDetailParams()}`, { range: false });
    if (state.userDetail !== detail) return;
    detail.data = data;
    renderUserDetailModal(data);
  } catch (error) {
    if (state.userDetail !== detail) return;
    if (form) form.innerHTML = `<div class="empty"><strong>用户明细读取失败</strong><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function openUserDetails(userId) {
  const range = defaultDetailRange();
  state.userDetail = {
    id: Number(userId),
    range: state.range,
    start: range.start,
    end: range.end,
    rechargePage: 1,
    usagePage: 1,
    pageSize: 10,
    data: null,
  };
  openContentModal('用户明细', '<div class="detail-loading"><span></span>正在读取用户明细</div>', 'user-detail-modal');
  loadUserDetails();
}

const overviewDetailMeta = {
  recharge: { title: '充值净额明细', loading: '正在读取充值明细', error: '充值明细读取失败', label: '笔充值或退款' },
  gift: { title: '赠送金额明细', loading: '正在读取赠送入账', error: '赠送入账读取失败', label: '笔赠送入账' },
  consumption: { title: '总消耗明细', loading: '正在读取消费汇总', error: '消费汇总读取失败', label: '条汇总' },
  balance: { title: '剩余余额明细', loading: '正在读取余额用户', error: '余额用户读取失败', label: '位余额用户' },
  tokens: { title: '总 Token 明细', loading: '正在读取模型 Token 明细', error: '模型 Token 明细读取失败', label: '个模型' },
};

function overviewDetailPager(data, label) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return `<div class="detail-pager">
    <span>共 ${compact(data.total)} ${label}</span>
    <label>每页<select id="overview-detail-page-size">${
      [10, 20, 50, 100].map((size) => `<option value="${size}" ${size === data.pageSize ? 'selected' : ''}>${size}</option>`).join('')
    }</select></label>
    <div class="pager-nav">
      <button type="button" class="icon-button pager-button" data-overview-detail-page="${Math.max(1, data.page - 1)}" ${data.page <= 1 ? 'disabled' : ''}>&lsaquo;</button>
      ${pageNumbers(data.page, pages).map((value) => value === 'ellipsis'
        ? '<span class="pager-ellipsis">…</span>'
        : `<button type="button" class="page-number ${value === data.page ? 'active' : ''}" data-overview-detail-page="${value}" ${value === data.page ? 'aria-current="page"' : ''}>${value}</button>`).join('')}
      <button type="button" class="icon-button pager-button" data-overview-detail-page="${Math.min(pages, data.page + 1)}" ${data.page >= pages ? 'disabled' : ''}>&rsaquo;</button>
    </div>
    <span>第 ${data.page} / ${pages} 页</span>
  </div>`;
}

function multiplier(value) {
  if (value === null || value === undefined || value === '') return '--';
  return `${Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 6 })}x`;
}

function multiplierSourceLabel(value) {
  return ({
    usage_log_snapshot: '请求倍率快照',
    probe_observation: '自动探测',
    probe_snapshot: '自动探测',
    supplier_direct_probe: '供应商密钥探测',
    manual_rule: '手动规则',
    audited_reprice: '审计重算',
  })[value] || '待确认来源';
}

function probeStatusLabel(value) {
  return ({
    ok: '探测已确认',
    unsupported: '上游未提供探测',
    pending: '等待探测',
    skipped: '密钥不可探测',
    failed: '探测失败',
    unknown: '尚无探测结果',
  })[String(value || '').toLowerCase()] || '尚无探测结果';
}

function accountPricingDetail(account) {
  const mode = account.costMode || account.costType;
  if (mode === 'free') return '<span class="primary-text">免费资源</span><div class="secondary-text">不计入上游成本</div>';
  if (mode === 'fixed_purchase') {
    if (!account.currentCostPeriodId) return '<span class="secondary-text">待登记固定成本期</span>';
    const total = Number(account.currentOriginalAmount || 0) + Number(account.currentFeeAmount || 0) + Number(account.currentTaxAmount || 0);
    return `<span class="primary-text">${cny(total)}</span><div class="secondary-text">固定成本期 · ${dateOnly(account.currentEffectiveFrom)}</div>`;
  }
  if (mode === 'manual_multiplier') {
    return `<span class="primary-text">手动 ${multiplier(account.upstreamMultiplier)}</span><div class="secondary-text">按消费记录销售倍率自动计算成本</div>`;
  }
  if (mode === 'probe_multiplier') {
    const keyLabel = account.supplierKeyName || account.supplierKeyMasked || '';
    if (account.upstreamMultiplier) {
      return `<span class="primary-text">自动 ${multiplier(account.upstreamMultiplier)}</span><div class="secondary-text">${escapeHtml(keyLabel || multiplierSourceLabel(account.upstreamMultiplierSource))} · ${escapeHtml(probeStatusLabel(account.probeStatus))}</div>`;
    }
    const nextStep = account.supplierKeyId
      ? `${keyLabel || '已关联密钥'} · 等待有效倍率快照`
      : account.probeStatus === 'unsupported' ? '请切换为手动倍率' : '请关联 Sub2API 供应商密钥';
    return `<span class="secondary-text">${escapeHtml(probeStatusLabel(account.probeStatus))}</span><div class="secondary-text">${nextStep}</div>`;
  }
  return '<span class="secondary-text">先选择固定成本或倍率模式</span>';
}

function costStatusLabel(value) {
  return ({
    priced: '已计价',
    fixed_cost: '固定成本分摊',
    free: '免费资源',
    unconfigured: '未配置成本规则',
    missing_upstream_multiplier: '缺少上游倍率',
    missing_source_selling_multiplier: '缺少消费记录倍率',
    missing_selling_multiplier: '缺少消费记录倍率',
    missing_cny_basis: '缺少 CNY 基准',
    not_snapshotted: '等待成本快照',
  })[value] || value || '等待成本快照';
}

function usageCostCell(item) {
  const source = item.upstreamMultiplierSource ? multiplierSourceLabel(item.upstreamMultiplierSource) : '';
  const rate = item.upstreamMultiplier === null || item.upstreamMultiplier === undefined
    ? '' : `上游 ${multiplier(item.upstreamMultiplier)}`;
  if (item.calculatedCostCny === null || item.calculatedCostCny === undefined) {
    return `<span class="secondary-text">待计价</span><div class="secondary-text">${escapeHtml([costStatusLabel(item.costStatus), source].filter(Boolean).join(' · '))}</div>`;
  }
  return `<span class="primary-text">${cny(item.calculatedCostCny)}</span><div class="secondary-text">${escapeHtml([source, rate].filter(Boolean).join(' · ') || costStatusLabel(item.costStatus))}</div>`;
}

function usageCostState(item) {
  const settled = ['priced', 'fixed_cost', 'free'].includes(item.costStatus);
  const lifecycle = item.costSnapshotFinalized ? '已封存' : '当日可更新';
  return `<span class="status ${settled ? '' : 'warning'}">${escapeHtml(costStatusLabel(item.costStatus))}</span><div class="secondary-text">${lifecycle}</div>`;
}

function durationText(value) {
  return value === null || value === undefined ? '--' : `${(Number(value) / 1000).toFixed(2)}s`;
}

function bindOverviewDetailControls() {
  const form = document.querySelector('#modal-form');
  form.onclick = async (event) => {
    const detail = state.overviewDetail;
    if (!detail) return;
    const viewButton = event.target.closest('[data-overview-detail-view]');
    if (viewButton) {
      const view = viewButton.dataset.overviewDetailView === 'models' ? 'models' : 'users';
      if (detail.view !== view) {
        detail.view = view;
        detail.page = 1;
        detail.sort = 'userChargeCny';
        detail.direction = 'desc';
        await loadOverviewDetails();
      }
      return;
    }
    const sortButton = event.target.closest('[data-overview-detail-sort]');
    if (sortButton) {
      const sort = sortButton.dataset.overviewDetailSort;
      detail.direction = detail.sort === sort && detail.direction === 'desc' ? 'asc' : 'desc';
      detail.sort = sort;
      detail.page = 1;
      await loadOverviewDetails();
      return;
    }
    const button = event.target.closest('[data-overview-detail-page]');
    if (!button || button.disabled) return;
    detail.page = Number(button.dataset.overviewDetailPage);
    await loadOverviewDetails();
  };
  document.querySelector('#overview-detail-page-size')?.addEventListener('change', async (event) => {
    if (!state.overviewDetail) return;
    state.overviewDetail.pageSize = Number(event.target.value);
    state.overviewDetail.page = 1;
    await loadOverviewDetails();
  });
}

function renderRechargeDetailModal(data) {
  const summary = data.summary || {};
  const rechargeReceived = Number(summary.rechargeReceived || 0);
  const refunds = Number(summary.refunds || 0);
  const netRecharge = rechargeReceived - refunds;
  openContentModal('充值净额明细', `
    <div class="detail-filter">
      <span class="detail-range-note">仅包含用户充值与退款；充值净额 = 充值实收 - 已退款，不包含其他现金收支、赠送、返利和管理员余额调整。</span>
    </div>
    <div class="detail-metrics">
      ${metric('充值净额', cny(netRecharge), `充值实收 ${cny(rechargeReceived)} · 已退款 ${cny(refunds)}`, netRecharge >= 0 ? 'good' : 'bad')}
      ${metric('充值实收', cny(rechargeReceived), `${compact(summary.transactions)} 笔充值或退款`, 'good')}
      ${metric('已退款', cny(refunds), '退款会从充值净额中扣除', refunds ? 'warn' : '')}
    </div>
    <section class="detail-section">
      <div class="detail-section-header"><h3>充值与退款流水</h3><span>按发生时间倒序</span></div>
      ${table([
        { label: '时间' }, { label: '流水 / 对方' }, { label: '类型' }, { label: '支付方式' },
        { label: '方向' }, { label: '现金金额 CNY', right: true }, { label: '入账余额 CNY', right: true }, { label: '状态' },
      ], data.items.map((item) => [
        dateTime(item.occurredAt), `<span class="primary-text">${escapeHtml(item.reference)}</span><div class="secondary-text">${escapeHtml(item.party || '')}</div>`,
        `<span class="tag neutral">${escapeHtml(item.type)}</span>`, escapeHtml(item.method || '--'),
        item.direction === 'in' ? '<span class="money-positive">流入</span>' : '<span class="money-negative">流出</span>',
        cny(item.baseAmountCny), item.creditedAmountCny ? cny(item.creditedAmountCny) : '--',
        `<span class="status ${item.status === 'completed' ? '' : 'warning'}">${escapeHtml(item.status)}</span>`,
      ]), 950)}
      ${overviewDetailPager(data, overviewDetailMeta.recharge.label)}
    </section>
  `, 'cash-detail-modal overview-detail-modal');
  bindOverviewDetailControls();
}

function nonCashBalanceCreditLabel(item) {
  return ({
    admin_adjustment: '管理员加款',
    redeem: '兑换入账',
    affiliate_rebate: '邀请返利',
  })[item.type] || item.type || '--';
}

function renderGiftBalanceCreditDetailModal(data) {
  const summary = data.summary || {};
  openContentModal('赠送金额明细', `
    <div class="detail-filter">
      <span class="detail-range-note">包含赠送、兑换和返利等零现金基础的余额入账；不包含邀请返利额度等未进入用户余额的额度记录。</span>
    </div>
    <div class="detail-metrics">
      ${metric('赠送金额', cny(summary.amountCny), `${compact(summary.events)} 笔实际余额入账`, 'good')}
    </div>
    <section class="detail-section">
      <div class="detail-section-header"><h3>赠送入账记录</h3><span>按发生时间倒序</span></div>
      ${table([
        { label: '时间' }, { label: '用户' }, { label: '入账类型' }, { label: '来源' }, { label: '入账金额 CNY', right: true },
      ], data.items.map((item) => {
        const identity = item.email || item.username || '--';
        const secondary = item.username && item.username !== item.email ? item.username : '';
        const source = [item.action, item.redeemType].filter(Boolean).join(' · ') || (item.sourceId ? `记录 #${item.sourceId}` : '--');
        return [
          dateTime(item.occurredAt),
          `<span class="primary-text">${escapeHtml(identity)}</span>${secondary ? `<div class="secondary-text">${escapeHtml(secondary)}</div>` : ''}`,
          `<span class="tag neutral">${escapeHtml(nonCashBalanceCreditLabel(item))}</span>`,
          escapeHtml(source), cny(item.amountCny),
        ];
      }), 850)}
      ${overviewDetailPager(data, overviewDetailMeta.gift.label)}
    </section>
  `, 'cash-detail-modal overview-detail-modal');
  bindOverviewDetailControls();
}

function overviewDetailSortHeader(label, detail) {
  const active = detail.sort === 'userChargeCny';
  const indicator = active ? (detail.direction === 'asc' ? '↑' : '↓') : '↕';
  return `<button type="button" class="sort-button ${active ? 'active' : ''}" data-overview-detail-sort="userChargeCny" aria-label="按${label}排序">${label}<span>${indicator}</span></button>`;
}

function overviewConsumptionViewTabs(active) {
  return `<div class="usage-view-tabs" role="group" aria-label="总消耗汇总维度">
    <button type="button" data-overview-detail-view="users" class="${active === 'users' ? 'active' : ''}" aria-pressed="${active === 'users'}">用户消费汇总</button>
    <button type="button" data-overview-detail-view="models" class="${active === 'models' ? 'active' : ''}" aria-pressed="${active === 'models'}">模型消费汇总</button>
  </div>`;
}

function renderUsageOverviewDetailModal(data) {
  const detail = state.overviewDetail;
  const metrics = detail?.metrics || {};
  const isTokenDetail = detail?.type === 'tokens';
  const view = detail?.view === 'models' ? 'models' : 'users';
  const isUserView = !isTokenDetail && view === 'users';
  const titleText = isTokenDetail ? '总 Token 明细' : '总消耗明细';
  openContentModal(titleText, `
    <div class="detail-filter">
      ${isTokenDetail ? '<span class="detail-range-note">Token 包含输入、输出与缓存 Token，按模型汇总。</span>' : overviewConsumptionViewTabs(view)}
    </div>
    <div class="detail-metrics">
      ${metric('总消耗', cny(metrics.consumptionCny), `${compact(metrics.requests)} 次请求`, 'good')}
      ${metric('总成本', cny(metrics.totalCostCny), '已登记的固定与计价成本')}
      ${metric('经营毛利', cny(metrics.grossProfitCny), '总消耗减已登记成本', Number(metrics.grossProfitCny || 0) >= 0 ? 'good' : 'bad')}
      ${metric('毛利率', percent(metrics.grossMargin), '经营毛利 / 总消耗', Number(metrics.grossMargin || 0) >= 0 ? 'good' : 'bad')}
      ${metric('总 Token', compact(metrics.totalTokens), `当前显示 ${compact(data.total)} ${isUserView ? '位用户' : '个模型'}`)}
    </div>
    <section class="detail-section">
      <div class="detail-section-header"><h3>${isTokenDetail ? '模型 Token 汇总' : isUserView ? '用户消费汇总' : '模型消费汇总'}</h3><span>${isTokenDetail ? '按 Token 数量倒序' : '可按实际消费排序'}</span></div>
      ${table([
        { label: isUserView ? '用户' : '模型' }, { label: '请求', right: true }, { label: 'Token', right: true },
        { label: isTokenDetail ? '实际消费 CNY' : overviewDetailSortHeader('实际消费 CNY', detail), right: true },
        { label: '已登记成本 CNY', right: true }, { label: '经营毛利 CNY', right: true }, { label: '毛利率', right: true }, { label: '成本覆盖' },
      ], data.items.map((item) => [
        isUserView
          ? `<span class="primary-text">${escapeHtml(item.email || item.username || '--')}</span><div class="secondary-text">ID ${item.id}${item.username && item.username !== item.email ? ` · ${escapeHtml(item.username)}` : ''}</div>`
          : `<span class="primary-text">${escapeHtml(modelName(item))}</span>`,
        compact(item.requests), compact(item.tokens), cny(item.userChargeCny), cny(item.bookedCostCny),
        `<span class="${profitClass(item.bookedProfitCny)}">${cny(item.bookedProfitCny)}</span>`, percent(item.grossMargin), costCoverage(item),
      ]), 1180)}
      ${overviewDetailPager(data, overviewDetailMeta[detail.type].label)}
    </section>
  `, 'cash-detail-modal overview-detail-modal');
  bindOverviewDetailControls();
}

function renderBalanceDetailModal(data) {
  const detail = state.overviewDetail;
  const metrics = detail?.metrics || {};
  openContentModal('剩余余额明细', `
    <div class="detail-filter">
      <span class="detail-range-note">仅包含未加入自用账号白名单的正余额用户；自用账号白名单只排除余额统计，消耗和成本仍正常计入。</span>
    </div>
    <div class="detail-metrics">
      ${metric('剩余余额', cny(metrics.balanceCny), `${compact(metrics.balanceUserCount)} 位余额用户`, Number(metrics.balanceCny) >= 0 ? 'good' : 'bad')}
    </div>
    <section class="detail-section">
      <div class="detail-section-header"><h3>余额用户</h3><span>按余额从高到低</span></div>
      ${table([
        { label: '用户' }, { label: '当前余额 CNY', right: true }, { label: '实际消费 CNY', right: true },
        { label: '请求', right: true }, { label: 'Token', right: true }, { label: '已登记成本 CNY', right: true },
      ], data.items.map((item) => [
        `<span class="primary-text">${escapeHtml(item.email || item.username || '--')}</span><div class="secondary-text">ID ${item.id}${item.tags?.length ? ` · ${tags(item.tags)}` : ''}</div>`,
        cny(item.balanceCny), cny(item.userChargeCny), compact(item.requests), compact(item.tokens), cny(item.bookedCostCny),
      ]), 1020)}
      ${overviewDetailPager(data, overviewDetailMeta.balance.label)}
    </section>
  `, 'cash-detail-modal overview-detail-modal');
  bindOverviewDetailControls();
}

function renderOverviewDetailModal(data) {
  const type = state.overviewDetail?.type;
  if (type === 'recharge') renderRechargeDetailModal(data);
  else if (type === 'gift') renderGiftBalanceCreditDetailModal(data);
  else if (type === 'consumption' || type === 'tokens') renderUsageOverviewDetailModal(data);
  else if (type === 'balance') renderBalanceDetailModal(data);
}

function overviewDetailPath(detail) {
  const paging = `page=${detail.page}&page_size=${detail.pageSize}`;
  if (detail.type === 'recharge') return `/funds?scope=recharge&${paging}`;
  if (detail.type === 'gift') return `/non-cash-balance-credits?${paging}`;
  if (detail.type === 'consumption') {
    const view = detail.view === 'models' ? 'models' : 'users';
    return `/usage/${view}?sort=${detail.sort || 'userChargeCny'}&direction=${detail.direction || 'desc'}&${paging}`;
  }
  if (detail.type === 'tokens') return `/usage/models?sort=tokens&direction=desc&${paging}`;
  if (detail.type === 'balance') return `/users?sort=balanceCny&direction=desc&balance_scope=reported&${paging}`;
  return '';
}

async function loadOverviewDetails() {
  const detail = state.overviewDetail;
  const meta = detail && overviewDetailMeta[detail.type];
  if (!detail || !meta) return;
  const form = document.querySelector('#modal-form');
  if (form) form.innerHTML = `<div class="detail-loading"><span></span>${meta.loading}</div>`;
  try {
    const data = await api(overviewDetailPath(detail));
    if (state.overviewDetail !== detail) return;
    renderOverviewDetailModal(data);
  } catch (error) {
    if (state.overviewDetail !== detail) return;
    if (form) form.innerHTML = `<div class="empty"><strong>${meta.error}</strong><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function openOverviewDetails(type) {
  const meta = overviewDetailMeta[type];
  if (!meta) return;
  state.overviewDetail = {
    type,
    page: 1,
    pageSize: 20,
    view: type === 'consumption' ? 'users' : 'models',
    sort: type === 'tokens' ? 'tokens' : 'userChargeCny',
    direction: 'desc',
    metrics: { ...(state.overviewMetrics || {}) },
  };
  openContentModal(meta.title, `<div class="detail-loading"><span></span>${meta.loading}</div>`, 'cash-detail-modal overview-detail-modal');
  loadOverviewDetails();
}

async function renderUsersEnhanced(search = state.userSearch) {
  state.userSearch = search;
  const data = await api(`/users?${queryFor('usersSearch', search, {
    sort: state.userSort,
    direction: state.userSortDirection,
  })}`);
  state.lastExport = data.items;
  state.userItems = new Map(data.items.map((item) => [String(item.id), item]));
  content.innerHTML = `${section('用户核算', '点击用户查看充值、消费明细与趋势；自用账号白名单只排除余额统计，消耗和成本仍正常计入')}
    <section class="table-panel">${searchTools('搜索邮箱、用户名', `
      <button type="button" class="button" id="user-whitelist-button">${icon('shield-check')}自用账号白名单</button>
      <span class="selection-text" id="user-selection-count">已选择 ${state.selectedUsers.size} 位</span>
      <button type="button" class="button" id="user-exclude-balance" ${state.selectedUsers.size ? '' : 'disabled'}>${icon('user-round-x')}加入自用账号白名单</button>
      <button type="button" class="button" id="user-include-balance" ${state.selectedUsers.size ? '' : 'disabled'}>${icon('user-round-check')}恢复余额统计</button>
    `, search)}${
      table([
        { label: '<input type="checkbox" id="select-current-users" title="选择当前页">' },
        { label: '用户' },
        { label: userSortHeader('现金实收 CNY', 'cashPaidCny'), right: true },
        { label: userSortHeader('管理员加款 CNY', 'adminCreditCny'), right: true },
        { label: userSortHeader('管理员扣款 CNY', 'adminDeductionCny'), right: true },
        { label: userSortHeader('当前余额 CNY', 'balanceCny'), right: true },
        { label: userSortHeader('实际消费 CNY', 'userChargeCny'), right: true },
        { label: userSortHeader('请求', 'requests'), right: true },
        { label: userSortHeader('Token', 'tokens'), right: true },
        { label: userSortHeader('已登记成本 CNY', 'bookedCostCny'), right: true },
        { label: userSortHeader('经营毛利 CNY', 'bookedProfitCny'), right: true },
        { label: '成本覆盖' },
      ], data.items.map((item) => [
        `<input type="checkbox" data-user-select="${item.id}" ${state.selectedUsers.has(Number(item.id)) ? 'checked' : ''}>`,
        `<button type="button" class="user-link" data-user-details="${item.id}"><span>${escapeHtml(item.email)}</span><small>ID ${item.id} · ${tags(item.tags)}${item.excludeFromBalanceStats ? ' · 自用账号白名单' : ''}</small></button>`,
        cny(item.cashPaidCny), cny(item.adminCreditCny), cny(item.adminDeductionCny), cny(item.balanceCny), cny(item.userChargeCny),
        compact(item.requests), compact(item.tokens), cny(item.bookedCostCny), `<span class="${profitClass(item.bookedProfitCny)}">${cny(item.bookedProfitCny)}</span>`, costCoverage(item),
      ]), 1480)
    }${pager(data, 'usersSearch', '位用户')}</section>`;
  bindSearch(renderUsersEnhanced);
  const updateUserSelection = () => {
    const count = document.querySelector('#user-selection-count');
    const enabled = state.selectedUsers.size > 0;
    if (count) count.textContent = `已选择 ${state.selectedUsers.size} 位`;
    ['#user-exclude-balance', '#user-include-balance'].forEach((selector) => {
      const button = document.querySelector(selector);
      if (button) button.disabled = !enabled;
    });
  };
  document.querySelector('#select-current-users')?.addEventListener('change', (event) => {
    data.items.forEach((item) => {
      if (event.target.checked) state.selectedUsers.add(Number(item.id));
      else state.selectedUsers.delete(Number(item.id));
    });
    renderUsersEnhanced(search);
  });
  document.querySelectorAll('[data-user-select]').forEach((checkbox) => checkbox.addEventListener('change', (event) => {
    const userId = Number(event.target.dataset.userSelect);
    if (event.target.checked) state.selectedUsers.add(userId);
    else state.selectedUsers.delete(userId);
    updateUserSelection();
  }));
  const updateWhitelist = async (excludeFromBalanceStats) => {
    if (!state.selectedUsers.size) return;
    try {
      await api('/users/balance-statistics-whitelist', {
        method: 'POST',
        range: false,
        body: JSON.stringify({
          userIds: [...state.selectedUsers],
          excludeFromBalanceStats,
        }),
      });
      state.selectedUsers.clear();
      toast(excludeFromBalanceStats ? '已加入自用账号白名单' : '已恢复余额统计');
      await renderUsersEnhanced(search);
    } catch (error) {
      toast(error.message);
    }
  };
  document.querySelector('#user-whitelist-button')?.addEventListener('click', openWhitelistManager);
  document.querySelector('#user-exclude-balance')?.addEventListener('click', () => updateWhitelist(true));
  document.querySelector('#user-include-balance')?.addEventListener('click', () => updateWhitelist(false));
}

function whitelistViewTabs(scope) {
  return [
    ['whitelist', '当前白名单'], ['all', '搜索全部用户'],
  ].map(([value, label]) => (
    `<button type="button" class="${scope === value ? 'active' : ''}" data-whitelist-scope="${value}" aria-pressed="${scope === value}">${label}</button>`
  )).join('');
}

function whitelistPager(data) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return `<div class="detail-pager">
    <span>共 ${compact(data.total)} 位用户</span>
    <div class="pager-nav" aria-label="白名单分页">
      <button type="button" class="icon-button pager-button" data-whitelist-page="${Math.max(1, data.page - 1)}" title="上一页" ${data.page <= 1 ? 'disabled' : ''}>&lsaquo;</button>
      ${pageNumbers(data.page, pages).map((value) => value === 'ellipsis'
        ? '<span class="pager-ellipsis">…</span>'
        : `<button type="button" class="page-number ${value === data.page ? 'active' : ''}" data-whitelist-page="${value}" ${value === data.page ? 'aria-current="page"' : ''}>${value}</button>`).join('')}
      <button type="button" class="icon-button pager-button" data-whitelist-page="${Math.min(pages, data.page + 1)}" title="下一页" ${data.page >= pages ? 'disabled' : ''}>&rsaquo;</button>
    </div>
    <span>第 ${data.page} / ${pages} 页</span>
  </div>`;
}

function renderWhitelistManager(data) {
  const manager = state.whitelistManager;
  if (!manager) return;
  const showingWhitelist = manager.scope === 'whitelist';
  openContentModal('自用账号白名单', `
    <div class="whitelist-toolbar">
      <div class="whitelist-view-tabs" role="group" aria-label="白名单视图">${whitelistViewTabs(manager.scope)}</div>
      <label class="whitelist-search">${icon('search')}<input type="search" data-whitelist-search placeholder="搜索邮箱或用户名" value="${escapeHtml(manager.search)}"></label>
    </div>
    <div class="whitelist-note">白名单只从“剩余余额”统计中排除；用户消费、成本和排行继续正常计入。配置仅保存于 FinOps。</div>
    <section class="detail-section whitelist-table-section">
      <div class="detail-section-header"><h3>${showingWhitelist ? '已排除余额统计的自用账号' : '全部用户'}</h3><span>${showingWhitelist ? '可随时恢复余额统计' : '搜索后直接加入或剔除'}</span></div>
      ${table([
        { label: '用户' }, { label: '当前余额 CNY', right: true }, { label: '实际消费 CNY', right: true },
        { label: 'Token', right: true }, { label: '余额统计' }, { label: '操作' },
      ], data.items.map((item) => [
        `<span class="primary-text">${escapeHtml(item.email || item.username || `用户 #${item.id}`)}</span><div class="secondary-text">ID ${item.id}${item.username && item.username !== item.email ? ` · ${escapeHtml(item.username)}` : ''}</div>`,
        cny(item.balanceCny), cny(item.userChargeCny), compact(item.tokens),
        item.excludeFromBalanceStats ? '<span class="status warning">已排除</span>' : '<span class="status">参与统计</span>',
        item.excludeFromBalanceStats
          ? `<button type="button" class="button" data-whitelist-toggle="remove" data-whitelist-user="${item.id}">${icon('user-round-check')}恢复</button>`
          : `<button type="button" class="button primary" data-whitelist-toggle="add" data-whitelist-user="${item.id}">${icon('user-round-x')}加入</button>`,
      ]), 950)}
      ${whitelistPager(data)}
    </section>
  `, 'whitelist-modal');

  const form = document.querySelector('#modal-form');
  form.onclick = async (event) => {
    const scopeButton = event.target.closest('[data-whitelist-scope]');
    if (scopeButton) {
      manager.scope = scopeButton.dataset.whitelistScope === 'whitelist' ? 'whitelist' : 'all';
      manager.search = '';
      manager.page = 1;
      await loadWhitelistManager();
      return;
    }
    const pageButton = event.target.closest('[data-whitelist-page]');
    if (pageButton && !pageButton.disabled) {
      manager.page = Number(pageButton.dataset.whitelistPage);
      await loadWhitelistManager();
      return;
    }
    const toggleButton = event.target.closest('[data-whitelist-toggle]');
    if (!toggleButton) return;
    const excludeFromBalanceStats = toggleButton.dataset.whitelistToggle === 'add';
    try {
      await api(`/users/${Number(toggleButton.dataset.whitelistUser)}/balance-statistics-whitelist`, {
        method: 'PATCH', range: false,
        body: JSON.stringify({ excludeFromBalanceStats }),
      });
      toast(excludeFromBalanceStats ? '已加入自用账号白名单' : '已恢复余额统计');
      if (state.page === 'users') await renderUsersEnhanced(state.userSearch);
      await loadWhitelistManager();
    } catch (error) {
      toast(error.message);
    }
  };
  let searchTimer;
  form.querySelector('[data-whitelist-search]')?.addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      manager.search = event.target.value;
      manager.page = 1;
      loadWhitelistManager();
    }, 260);
  });
}

async function loadWhitelistManager() {
  const manager = state.whitelistManager;
  if (!manager) return;
  const form = document.querySelector('#modal-form');
  if (form) form.innerHTML = '<div class="detail-loading"><span></span>正在读取白名单</div>';
  try {
    const query = new URLSearchParams({
      page: String(manager.page), page_size: String(manager.pageSize), balance_scope: manager.scope,
    });
    if (manager.search) query.set('search', manager.search);
    const data = await api(`/users?${query}`);
    if (state.whitelistManager !== manager) return;
    renderWhitelistManager(data);
  } catch (error) {
    if (state.whitelistManager !== manager) return;
    if (form) form.innerHTML = `<div class="empty"><strong>白名单读取失败</strong><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function openWhitelistManager() {
  state.whitelistManager = { scope: 'whitelist', search: '', page: 1, pageSize: 20 };
  openContentModal('自用账号白名单', '<div class="detail-loading"><span></span>正在读取白名单</div>', 'whitelist-modal');
  loadWhitelistManager();
}

function accountActionButtons(item) {
  return `<div class="table-actions table-row-actions">
    <button type="button" class="icon-button table-icon" title="配置账号成本方式" data-edit-ledger="${item.id}">${icon('settings-2')}</button>
    <button type="button" class="icon-button table-icon" title="查看计价版本与封存记录" data-account-rule-history="${item.id}">${icon('shield-check')}</button>
    <button type="button" class="icon-button table-icon" title="查看与编辑成本明细" data-account-cost-history="${item.id}">${icon('receipt-text')}</button>
  </div>`;
}

function accountScopeTabs(active) {
  return [
    ['current', '当前可用'], ['deleted', '已删除历史'], ['all', '全部账号'],
  ].map(([value, label]) => (
    `<button type="button" class="${active === value ? 'active' : ''}" data-account-scope="${value}" aria-pressed="${active === value}">${label}</button>`
  )).join('');
}

function usageViewTabs(active) {
  return [
    ['events', '请求明细'], ['models', '模型汇总'],
  ].map(([value, label]) => (
    `<button type="button" class="${active === value ? 'active' : ''}" data-usage-view="${value}" aria-pressed="${active === value}">${label}</button>`
  )).join('');
}

function accountLifecycle(item) {
  if (item.lifecycle === 'deleted') return '<span class="account-lifecycle deleted">历史已删除</span>';
  if (item.lifecycle === 'inactive') return '<span class="account-lifecycle inactive">当前停用</span>';
  return '';
}

async function renderAccounts(search = state.accountSearch) {
  state.accountSearch = search;
  const [data, profiles] = await Promise.all([
    api(`/accounts?${queryFor('accountsSearch', search, { scope: state.accountScope })}`),
    api('/cost-profiles', { range: false }),
  ]);
  state.lastExport = data.items;
  state.accountItems = new Map(data.items.map((item) => [String(item.id), item]));
  const actions = `<div class="account-scope"><span>账号范围</span><div class="account-scope-tabs" role="group" aria-label="账号范围">${accountScopeTabs(state.accountScope)}</div></div>
    <span class="selection-text" id="selection-count">已选择 ${state.selectedAccounts.size} 个</span>
    <button type="button" class="button" id="batch-cost-button" ${state.selectedAccounts.size ? '' : 'disabled'}>${icon('tags')}批量登记成本</button>
    <button type="button" class="button primary" id="account-cost-button">${icon('plus')}登记单个成本</button>`;
  content.innerHTML = `${section('账号成本中心', '默认只显示 sub2api 当前可用账号；已删除账号保留历史用量与审计依据，不会凭空补录成本')}
    <section class="table-panel">${searchTools('搜索账号、平台、供应商', actions, search)}${
      table([
        { label: '<input type="checkbox" id="select-current-accounts" title="选择当前页">' }, { label: '账号' }, { label: '平台/供应商' },
        { label: '核算规则' }, { label: '本期计价来源' }, { label: '实际消费 CNY', right: true }, { label: '已登记成本 CNY', right: true },
        { label: '经营毛利 CNY', right: true }, { label: '成本覆盖' }, { label: '编辑' },
      ], data.items.map((item) => [
        `<input type="checkbox" data-account-select="${item.id}" ${state.selectedAccounts.has(Number(item.id)) ? 'checked' : ''}>`,
        `<span class="primary-text">${escapeHtml(item.name)}</span><div class="secondary-text">#${item.id} · ${tags(item.tags)} ${accountLifecycle(item)}</div>`,
        `<span class="primary-text">${escapeHtml(item.platform)}</span><div class="secondary-text">${escapeHtml(item.supplier || '未标记供应商')}${
          item.purchaseBatch ? ` · ${escapeHtml(item.purchaseBatch)}` : ''
        }</div>`,
        `<span class="tag neutral">${escapeHtml(costModeLabel(item.costMode || item.costType))}</span><div class="secondary-text">${
          item.costMode === 'probe_multiplier' ? probeStatusLabel(item.probeStatus) : item.upstreamMultiplier ? `上游 ${multiplier(item.upstreamMultiplier)}` : ''
        }</div>`,
        accountPricingDetail(item),
        cny(item.userChargeCny), cny(item.bookedCostCny), `<span class="${profitClass(item.bookedProfitCny)}">${cny(item.bookedProfitCny)}</span>`, costCoverage(item), accountActionButtons(item),
      ]), 1390)
    }${pager(data, 'accountsSearch', '个账号')}</section>`;
  bindSearch(renderAccounts);
  document.querySelector('#account-cost-button')?.addEventListener('click', () => {
    openSingleCostModal(data.items, profiles).catch((error) => toast(error.message));
  });
  document.querySelector('#batch-cost-button')?.addEventListener('click', () => {
    openBulkCostModal(profiles).catch((error) => toast(error.message));
  });
  document.querySelector('#select-current-accounts')?.addEventListener('change', (event) => {
    data.items.forEach((item) => {
      if (event.target.checked) state.selectedAccounts.add(Number(item.id));
      else state.selectedAccounts.delete(Number(item.id));
    });
    renderAccounts(search);
  });
}

async function renderUsage(search = state.usageSearch) {
  state.usageSearch = search;
  const view = state.usageView === 'models' ? 'models' : 'events';
  const viewTabs = `<div class="usage-view-tabs" role="group" aria-label="用量视图">${usageViewTabs(view)}</div>`;
  if (view === 'models') {
    const data = await api(`/usage/models?${queryFor('usageModels')}`);
    state.lastExport = data.items;
    content.innerHTML = `${section('用量与扣费', '模型汇总用于对比规模、实际扣费与已登记成本；需要追溯时切换到请求明细')}
      <section class="table-panel"><div class="table-tools"><div class="usage-view-copy"><strong>模型汇总</strong><span>按模型聚合，不展示单笔请求</span></div><div class="table-actions">${viewTabs}</div></div>${table([
        { label: '模型' }, { label: '请求', right: true }, { label: 'Token', right: true }, { label: '标准牌价 USD', right: true },
        { label: '实际消费 CNY', right: true }, { label: '已登记成本 CNY', right: true }, { label: '经营毛利 CNY', right: true }, { label: '成本覆盖' },
      ], data.items.map((item) => [
        `<span class="primary-text">${escapeHtml(modelName(item))}</span>`, compact(item.requests), compact(item.tokens), usd(item.tokenListValueUsd),
        cny(item.userChargeCny), cny(item.bookedCostCny), `<span class="${profitClass(item.bookedProfitCny)}">${cny(item.bookedProfitCny)}</span>`, costCoverage(item),
      ]), 1190)}${pager(data, 'usageModels', '个模型')}</section>`;
    return;
  }

  const data = await api(`/usage/events?${queryFor('usageEvents', search)}`);
  state.lastExport = data.items;
  content.innerHTML = `${section('用量与扣费', '逐请求核对模型、Token、实际扣费、成本快照和倍率来源；与总览汇总分开查看')}
    <section class="table-panel">${searchTools('搜索请求 ID、用户、账号或模型', viewTabs, search)}${table([
      { label: '时间' }, { label: '请求 / 用户' }, { label: '模型' }, { label: '上游账号' },
      { label: 'Token 明细', right: true }, { label: '实际扣费 CNY', right: true }, { label: '计算成本 CNY', right: true },
      { label: '计价状态' }, { label: '耗时', right: true },
    ], data.items.map((item) => {
      const modelDetail = [
        item.requestedModel && item.requestedModel !== item.model ? `请求 ${item.requestedModel}` : '',
        item.upstreamModel && item.upstreamModel !== item.model ? `上游 ${item.upstreamModel}` : '',
      ].filter(Boolean).join(' · ');
      const cacheTokens = Number(item.cacheCreationTokens || 0) + Number(item.cacheReadTokens || 0);
      return [
        dateTime(item.occurredAt),
        `<span class="primary-text">${escapeHtml(item.requestId || `#${item.sourceUsageId}`)}</span><div class="secondary-text">${escapeHtml(item.email || item.username || `用户 #${item.userId}`)}</div>`,
        `<span class="primary-text">${escapeHtml(modelName(item))}</span>${modelDetail ? `<div class="secondary-text">${escapeHtml(modelDetail)}</div>` : ''}`,
        `<span class="primary-text">${escapeHtml(item.accountName || `#${item.accountId || '--'}`)}</span><div class="secondary-text">组 #${item.groupId || '--'} · 渠道 #${item.channelId || '--'}</div>`,
        `<span class="primary-text">${compact(item.totalTokens)}</span><div class="secondary-text">入 ${compact(item.inputTokens)} · 出 ${compact(item.outputTokens)} · 缓存 ${compact(cacheTokens)}</div>`,
        `<span class="primary-text">${cny(item.userChargeCny)}</span><div class="secondary-text">目录价 ${usd(item.standardCostUsdReference)}</div>`,
        usageCostCell(item), usageCostState(item), durationText(item.durationMs),
      ];
    }), 1740)}${pager(data, 'usageEvents', '笔请求')}</section>`;
  bindSearch(renderUsage);
}

const supplierStateMeta = {
  ok: ['正常', 'ok'],
  warning: ['需关注', 'warning'],
  failed: ['失败', 'error'],
  pending: ['等待同步', 'pending'],
  disabled: ['已停用', 'muted'],
  unsupported: ['暂不支持', 'warning'],
  active: ['可用', 'ok'],
  inactive: ['不可用', 'warning'],
  removed: ['已移除', 'muted'],
  unknown: ['未知', 'pending'],
  skipped: ['已跳过', 'muted'],
  open: ['待处理', 'warning'],
  acknowledged: ['已确认', 'muted'],
  resolved: ['已恢复', 'ok'],
};

function supplierNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function supplierAmount(value, currency = '') {
  if (!supplierNumber(value)) return currency ? `-- ${currency}` : '--';
  const code = String(currency || '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat('zh-CN', {
        style: 'currency', currency: code, maximumFractionDigits: 2,
      }).format(Number(value));
    } catch {
      // Some supplier portals expose non-ISO quota units. Keep them visible as units.
    }
  }
  const amount = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(Number(value));
  return code ? `${amount} ${code}` : amount;
}

function supplierAdapterLabel(value) {
  return ({
    auto: '自动识别',
    sub2api: 'Sub2API',
    newapi: 'NewAPI',
    openai_compatible: 'OpenAI 兼容',
    custom: '自定义适配器',
  })[value] || value || '未识别';
}

function supplierAuthModeLabel(value) {
  return ({ password: '账号密码', access_token: '访问令牌', api_key: 'API 密钥' })[value] || value || '--';
}

function supplierQualityModeLabel(value) {
  return ({ off: '关闭', passive: '仅被动', active: '仅主动', hybrid: '混合' })[value] || value || '仅被动';
}

function supplierState(status, label = '') {
  const meta = supplierStateMeta[String(status || '').toLowerCase()] || ['未知', 'pending'];
  return `<span class="supplier-state ${meta[1]}">${escapeHtml(label || meta[0])}</span>`;
}

function supplierSeverity(severity) {
  const value = String(severity || 'warning').toLowerCase();
  const label = ({ critical: '严重', warning: '警告', info: '提示' })[value] || value;
  return `<span class="supplier-severity ${escapeHtml(value)}">${escapeHtml(label)}</span>`;
}

function supplierConnectionStatusHint(item) {
  if (item.connectionStatus === 'failed' && item.lastError) return item.lastError;
  if (Number(item.consecutiveFailures || 0)) return `连续失败 ${compact(item.consecutiveFailures)} 次`;
  if (!item.enabled) return '已停用，不参与自动同步';
  return item.detectedAdapterType
    ? `已识别 ${supplierAdapterLabel(item.detectedAdapterType)}`
    : `配置 ${supplierAdapterLabel(item.adapterType)}`;
}

function supplierQuotaText(key) {
  const currency = key.quotaCurrency || '';
  if (supplierNumber(key.quotaRemaining) && supplierNumber(key.quotaTotal)) {
    return `${supplierAmount(key.quotaRemaining, currency)} / ${supplierAmount(key.quotaTotal, currency)}`;
  }
  if (supplierNumber(key.quotaRemaining)) return `余 ${supplierAmount(key.quotaRemaining, currency)}`;
  if (supplierNumber(key.quotaUsed)) return `已用 ${supplierAmount(key.quotaUsed, currency)}`;
  return currency ? `未提供 ${currency} 额度` : '未提供额度';
}

function supplierAuthModeOptions(adapterType) {
  if (adapterType === 'openai_compatible') return [['api_key', 'API 密钥']];
  if (['auto', 'sub2api', 'newapi'].includes(adapterType)) return [['password', '账号密码'], ['access_token', '访问令牌']];
  return [['password', '账号密码'], ['access_token', '访问令牌'], ['api_key', 'API 密钥']];
}

function supplierAuthModeSelectOptions(options, selected) {
  return options.map(([value, label]) => (
    `<option value="${value}" ${value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`
  )).join('');
}

function refreshSupplierAuthMode(form) {
  const select = form.elements.authMode;
  const options = supplierAuthModeOptions(form.elements.adapterType.value);
  const current = select.value;
  select.innerHTML = supplierAuthModeSelectOptions(options, options.some(([value]) => value === current) ? current : options[0][0]);
}

function supplierConnectionCredentialFields(adapterType, authMode, values = {}, editing = false) {
  const preserved = editing ? '<p class="supplier-credential-note">未切换认证方式且不修改手工密钥资料时，凭据可留空并继续使用已加密保存的值。切换认证方式或修改下方手工资料时，需重新填写对应凭据；凭据不会在页面回显。</p>' : '';
  const optional = editing ? '' : 'required';
  const value = (name) => escapeHtml(values[name] ?? '');
  let fields;
  let adapterHint = '';
  if (authMode === 'password') {
    fields = `
      <label class="field"><span>登录账号</span><input name="username" autocomplete="username" ${optional} value="${value('username')}"></label>
      <label class="field"><span>登录密码</span><input name="password" type="password" autocomplete="new-password" ${optional} value="${value('password')}"></label>`;
    if (adapterType === 'sub2api') {
      fields += `<label class="field full"><span>TOTP 密钥（可选）</span><input name="totpSecret" type="password" autocomplete="off" value="${value('totpSecret')}"></label>`;
    }
    if (adapterType === 'newapi') {
      adapterHint = '<p class="supplier-credential-note">NewAPI 账号启用二步验证时，请改用访问令牌认证。</p>';
    }
  } else if (authMode === 'api_key') {
    fields = `<label class="field full"><span>API 密钥</span><input name="apiKey" type="password" autocomplete="off" ${optional} value="${value('apiKey')}"></label>`;
  } else {
    fields = `<label class="field full"><span>访问令牌</span><input name="accessToken" type="password" autocomplete="off" ${optional} value="${value('accessToken')}"></label>`;
  }
  const openAiFields = adapterType === 'openai_compatible' ? `
    <label class="field"><span>密钥显示名（可选）</span><input name="keyName" value="${value('keyName')}"></label>
    <label class="field"><span>上游倍率（可选）</span><input name="rateMultiplier" type="number" step="any" min="0" value="${value('rateMultiplier')}"></label>
    <label class="field"><span>手工余额（可选）</span><input name="balance" type="number" step="any" min="0" value="${value('balance')}"></label>
    <label class="field"><span>手工余额币种（可选）</span><input name="credentialsBalanceCurrency" value="${value('credentialsBalanceCurrency')}"></label>` : '';
  return `${preserved}${adapterHint}<div class="supplier-credential-grid">${fields}${openAiFields}</div>`;
}

function supplierConnectionFormMarkup(connection = null) {
  const editing = Boolean(connection);
  const value = (name, fallback = '') => escapeHtml(connection?.[name] ?? fallback);
  const checked = (name, fallback) => (connection ? connection[name] : fallback) ? 'checked' : '';
  const select = (name, options, fallback) => `<select name="${name}">${options.map(([option, label]) => (
    `<option value="${option}" ${String(connection?.[name] ?? fallback) === option ? 'selected' : ''}>${escapeHtml(label)}</option>`
  )).join('')}</select>`;
  const adapterType = connection?.adapterType || 'auto';
  const authOptions = supplierAuthModeOptions(adapterType);
  const configuredAuthMode = connection?.authMode;
  const authMode = authOptions.some(([mode]) => mode === configuredAuthMode) ? configuredAuthMode : authOptions[0][0];
  const requiresCredentialReplacement = editing && configuredAuthMode && configuredAuthMode !== authMode;
  return `<div class="supplier-form-note">供应商连接仅供 FinOps 读取上游门户的库存、余额和密钥巡检；采购金额与成本期在下方的采购核算中单独登记。</div>
    <div class="supplier-connection-form">
      <label class="field"><span>供应商名称</span><input name="supplierName" required value="${value('supplierName')}"></label>
      <label class="field"><span>连接名称</span><input name="name" required value="${value('name', '主账号')}"></label>
      <label class="field"><span>系统类型</span>${select('adapterType', [
        ['auto', '自动识别'], ['sub2api', 'Sub2API'], ['newapi', 'NewAPI'], ['openai_compatible', 'OpenAI 兼容'], ['custom', '自定义适配器'],
      ], 'auto')}</label>
      <label class="field"><span>认证方式</span><select name="authMode">${supplierAuthModeSelectOptions(authOptions, authMode)}</select></label>
      <label class="field full"><span>站点地址</span><input name="baseUrl" type="url" required placeholder="https://supplier.example.com" value="${value('baseUrl')}"></label>
      <label class="field"><span>凭据标识（可选）</span><input name="credentialLabel" placeholder="例如采购邮箱或负责人" value="${value('credentialLabel')}"></label>
      <label class="field"><span>余额币种</span><input name="balanceCurrency" required value="${value('balanceCurrency', 'USD')}"></label>
      <div class="supplier-form-section full">
        <div class="supplier-form-section-heading"><strong>同步与告警</strong><span>这些设置只影响 FinOps 的读取频率和巡检范围</span></div>
        <div class="supplier-connection-form compact">
          <label class="supplier-form-toggle"><input name="enabled" type="checkbox" ${checked('enabled', true)}><span>启用连接</span><small>纳入定时读取</small></label>
          <label class="supplier-form-toggle"><input name="activeCheckEnabled" type="checkbox" ${checked('activeCheckEnabled', true)}><span>巡检可用密钥</span><small>只检测，不写入上游</small></label>
          <label class="field"><span>质量监控模式</span>${select('qualityMonitorMode', [
            ['off', '关闭'], ['passive', '仅被动上游数据'], ['active', '仅主动探测（产生少量费用）'], ['hybrid', '混合模式'],
          ], 'passive')}<small class="field-hint">主动模式只请求你选择的密钥和模型</small></label>
          <label class="field"><span>库存同步间隔（秒）</span><input name="inventoryIntervalSeconds" type="number" min="3" max="86400" required value="${value('inventoryIntervalSeconds', 600)}"></label>
          <label class="field"><span>单次巡检上限</span><input name="activeCheckLimit" type="number" min="1" max="100" required value="${value('activeCheckLimit', 20)}"></label>
          <label class="field full"><span>低余额告警阈值（可选）</span><input name="lowBalanceThreshold" type="number" min="0" step="any" placeholder="不设置则不触发余额告警" value="${value('lowBalanceThreshold')}"></label>
        </div>
      </div>
      <div class="supplier-form-section full">
        <div class="supplier-form-section-heading"><strong>访问凭据</strong><span>${requiresCredentialReplacement ? '旧认证方式已不支持，请填写新的只读凭据' : editing && connection.credentialsConfigured ? '当前已配置加密凭据' : '首次保存后将加密保存在 FinOps'}</span></div>
        <div data-supplier-credentials>${supplierConnectionCredentialFields(adapterType, authMode, {}, editing)}</div>
      </div>
    </div>
    <div class="form-actions"><button type="button" class="button" data-supplier-form-cancel>取消</button><button type="submit" class="button primary">${editing ? '保存连接' : '创建并同步'}</button></div>`;
}

function refreshSupplierCredentialFields(form, editing) {
  const adapterType = form.elements.adapterType.value;
  const authMode = form.elements.authMode.value;
  const values = Object.fromEntries(new FormData(form));
  const target = form.querySelector('[data-supplier-credentials]');
  if (target) target.innerHTML = supplierConnectionCredentialFields(adapterType, authMode, values, editing);
}

function supplierConnectionPayload(form) {
  const values = Object.fromEntries(new FormData(form));
  return {
    supplierName: values.supplierName,
    name: values.name,
    adapterType: values.adapterType,
    baseUrl: values.baseUrl,
    authMode: values.authMode,
    credentialLabel: values.credentialLabel || '',
    enabled: form.querySelector('[name="enabled"]').checked,
    inventoryIntervalSeconds: values.inventoryIntervalSeconds,
    activeCheckEnabled: form.querySelector('[name="activeCheckEnabled"]').checked,
    activeCheckLimit: values.activeCheckLimit,
    qualityMonitorMode: values.qualityMonitorMode || 'passive',
    lowBalanceThreshold: values.lowBalanceThreshold || null,
    balanceCurrency: values.balanceCurrency,
    credentials: {
      username: values.username || '',
      password: values.password || '',
      accessToken: values.accessToken || '',
      apiKey: values.apiKey || '',
      totpSecret: values.totpSecret || '',
      keyName: values.keyName || '',
      rateMultiplier: values.rateMultiplier || null,
      balance: values.balance || null,
      balanceCurrency: values.credentialsBalanceCurrency || '',
    },
  };
}

function supplierCredentialsProvided(payload) {
  if (payload.authMode === 'password') return Boolean(payload.credentials.username && payload.credentials.password);
  if (payload.authMode === 'api_key') return Boolean(payload.credentials.apiKey);
  return Boolean(payload.credentials.accessToken);
}

function supplierCredentialChangeRequested(payload) {
  const credentials = payload.credentials;
  return Boolean(
    credentials.username || credentials.password || credentials.accessToken || credentials.apiKey || credentials.totpSecret
    || credentials.keyName || credentials.rateMultiplier || credentials.balance || credentials.balanceCurrency,
  );
}

function openSupplierConnectionModal(connection = null) {
  const editing = Boolean(connection);
  const previousDetail = state.supplierDetail;
  openContentModal(editing ? '编辑供应商连接' : '新建供应商连接', supplierConnectionFormMarkup(connection), 'supplier-connection-modal');
  const form = document.querySelector('#modal-form');
  form.classList.add('supplier-connection-form-shell');
  form.querySelector('[data-supplier-form-cancel]')?.addEventListener('click', () => {
    if (previousDetail?.data) renderSupplierConnectionDetails(previousDetail.data);
    else closeModal();
  });
  form.onchange = (event) => {
    if (!event.target.matches('[name="adapterType"], [name="authMode"]')) return;
    if (event.target.name === 'adapterType') refreshSupplierAuthMode(form);
    refreshSupplierCredentialFields(form, editing);
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    const payload = supplierConnectionPayload(form);
    const replacingCredentials = supplierCredentialsProvided(payload);
    const requiresCredentials = !editing
      || !connection.credentialsConfigured
      || payload.authMode !== connection.authMode
      || supplierCredentialChangeRequested(payload);
    if (requiresCredentials && !replacingCredentials) {
      toast(`请填写${supplierAuthModeLabel(payload.authMode)}后再保存`);
      return;
    }
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const result = await api(editing ? `/supplier-connections/${connection.id}` : '/supplier-connections', {
        method: editing ? 'PATCH' : 'POST',
        range: false,
        body: JSON.stringify(payload),
      });
      const connectionId = result.connection?.id || connection?.id;
      closeModal();
      await renderSuppliers();
      toast(result.sync?.ok === false ? '连接已保存，首次同步未完成' : editing ? '供应商连接已更新' : '供应商连接已创建');
      if (connectionId) openSupplierConnectionDetails(connectionId);
    } catch (error) {
      toast(error.message);
    } finally {
      submit.disabled = false;
    }
  };
}

function supplierDetailTabs(detail) {
  const openAlerts = (detail.alerts || []).filter((item) => item.status === 'open').length;
  const tabs = [
    ['keys', 'API 密钥', (detail.keys || []).length],
    ['quality', '质量评分', (detail.quality?.metrics?.sampleCount || 0)],
    ['balances', '余额历史', (detail.balances || []).length],
    ['checks', '巡检记录', (detail.checks || []).length],
    ['alerts', '告警', openAlerts],
    ['purchases', '采购批次', (detail.purchases || []).length],
  ];
  return `<div class="supplier-detail-tabs" role="tablist" aria-label="供应商连接详情">${tabs.map(([name, label, count]) => (
    `<button type="button" role="tab" data-supplier-detail-tab="${name}" class="${state.supplierDetail?.tab === name ? 'active' : ''}" aria-selected="${state.supplierDetail?.tab === name}">${label}<small>${compact(count)}</small></button>`
  )).join('')}</div>`;
}

function supplierKeyLinks(key) {
  const links = key.accountLinks || [];
  if (!links.length) return '<span class="secondary-text">尚未关联本地账号</span>';
  return `<div class="supplier-key-links">${links.map((link) => (
    `<span class="supplier-account-link">${escapeHtml(link.accountName || `账号 #${link.accountId}`)}<button type="button" class="icon-button supplier-link-remove" title="解除关联" data-supplier-key-unlink="${key.id}" data-supplier-account-id="${link.accountId}">${icon('x')}</button></span>`
  )).join('')}</div>`;
}

function supplierKeysTab(detail) {
  const keys = detail.keys || [];
  return `<section class="detail-section supplier-detail-section">
    <div class="detail-section-header"><div><h3>API 密钥库存</h3><span>密钥只显示上游返回的脱敏标识；关联本地账号后，已确认的探测倍率才会进入成本快照。</span></div></div>
    ${table([
      { label: '密钥' }, { label: '状态' }, { label: '分组 / 倍率' }, { label: '额度' }, { label: '最近巡检' }, { label: '本地账号' },
    ], keys.map((key) => [
      `<span class="primary-text">${escapeHtml(key.name || key.maskedKey || `密钥 #${key.id}`)}</span><div class="secondary-text">${escapeHtml(key.maskedKey || key.externalId || '--')} · ID ${escapeHtml(key.externalId || '--')}</div>`,
      supplierState(key.removedAt ? 'removed' : key.status),
      `<span class="primary-text">${escapeHtml(key.groupName || '未分组')}</span><div class="secondary-text">${supplierNumber(key.rateMultiplier) ? `${escapeHtml(String(key.rateMultiplier))}x` : '未提供倍率'}</div>`,
      `<span class="primary-text">${escapeHtml(supplierQuotaText(key))}</span><div class="secondary-text">${key.expiresAt ? `到期 ${escapeHtml(dateTime(key.expiresAt))}` : key.lastUsedAt ? `最近使用 ${escapeHtml(dateTime(key.lastUsedAt))}` : '无到期或使用记录'}</div>`,
      `${supplierState(key.lastCheckStatus || 'pending')}<div class="secondary-text">${escapeHtml(key.lastCheckMethod || '等待巡检')}${key.lastCheckAt ? ` · ${escapeHtml(dateTime(key.lastCheckAt))}` : ''}${key.lastCheckError ? `<br>${escapeHtml(key.lastCheckError)}` : ''}</div>`,
      `<div class="supplier-key-link-cell">${supplierKeyLinks(key)}${key.removedAt ? '' : `<button type="button" class="button supplier-link-button" data-supplier-key-link-picker="${key.id}">${icon('plus')}关联账号</button>`}</div>`,
    ]), 1290)}
  </section>`;
}

function supplierBalancesTab(detail) {
  const balances = detail.balances || [];
  return `<section class="detail-section supplier-detail-section">
    <div class="detail-section-header"><div><h3>余额历史</h3><span>保留最近 ${compact(balances.length)} 个同步快照；采购成本不从该余额自动推导。</span></div></div>
    ${table([
      { label: '采样时间' }, { label: '余额', right: true }, { label: '币种' },
    ], balances.map((item) => [
      dateTime(item.observedAt), `<span class="primary-text">${escapeHtml(supplierAmount(item.balance, item.currency))}</span>`, escapeHtml(item.currency || '--'),
    ]), 680)}
  </section>`;
}

function supplierChecksTab(detail) {
  const checks = detail.checks || [];
  return `<section class="detail-section supplier-detail-section">
    <div class="detail-section-header"><div><h3>主动巡检记录</h3><span>巡检只请求供应商侧的状态或计费元数据，不会修改供应商或 Sub2API。</span></div></div>
    ${table([
      { label: '时间' }, { label: '密钥' }, { label: '结果' }, { label: '方式' }, { label: 'HTTP / 耗时' }, { label: '异常' },
    ], checks.map((item) => [
      dateTime(item.checkedAt), `<span class="primary-text">${escapeHtml(item.keyName || item.maskedKey || `密钥 #${item.keyId}`)}</span><div class="secondary-text">${escapeHtml(item.maskedKey || '')}</div>`,
      supplierState(item.status), escapeHtml(item.method || '--'),
      `${item.httpStatus || '--'}${supplierNumber(item.latencyMs) ? ` / ${Math.round(item.latencyMs)} ms` : ''}`,
      item.errorMessage ? `<span class="supplier-inline-error">${escapeHtml(item.errorMessage)}</span><div class="secondary-text">${escapeHtml(item.errorCode || '')}</div>` : '<span class="secondary-text">--</span>',
    ]), 980)}
  </section>`;
}

function supplierAlertsTab(detail) {
  const alerts = detail.alerts || [];
  return `<section class="detail-section supplier-detail-section">
    <div class="detail-section-header"><div><h3>连接告警</h3><span>确认只会标记 FinOps 内的告警，不会关闭上游服务或删除告警历史。</span></div></div>
    ${table([
      { label: '级别' }, { label: '告警' }, { label: '状态' }, { label: '最近出现' }, { label: '次数', right: true }, { label: '操作' },
    ], alerts.map((item) => [
      supplierSeverity(item.severity),
      `<span class="primary-text">${escapeHtml(item.title || item.type || '供应商告警')}</span><div class="secondary-text">${escapeHtml(item.message || '--')}</div>`,
      `${supplierState(item.status)}${item.acknowledgedBy ? `<div class="secondary-text">${escapeHtml(item.acknowledgedBy)} · ${escapeHtml(dateTime(item.acknowledgedAt))}</div>` : ''}`,
      dateTime(item.lastSeenAt), compact(item.occurrenceCount),
      item.status === 'open'
        ? `<button type="button" class="button" data-supplier-alert-ack="${item.id}">确认告警</button>`
        : '<span class="secondary-text">--</span>',
    ]), 920)}
  </section>`;
}

function supplierPurchasesTab(detail) {
  const purchases = detail.purchases || [];
  return `<section class="detail-section supplier-detail-section">
    <div class="detail-section-header">
      <div><h3>采购批次</h3><span>采购金额、生效期和分摊独立于供应商门户连接；请以实际采购单据登记人民币成本。</span></div>
      <button type="button" class="button primary" data-supplier-detail-cost>${icon('plus')}登记采购成本</button>
    </div>
    ${table([
      { label: '账号' }, { label: '采购批次' }, { label: '成本模板' }, { label: '含税费 CNY', right: true }, { label: '生效期' }, { label: '状态' },
    ], purchases.map((item) => [
      `<span class="primary-text">${escapeHtml(item.accountName || `账号 #${item.accountId}`)}</span><div class="secondary-text">#${escapeHtml(item.accountId)}</div>`,
      `<span class="primary-text">${escapeHtml(item.purchaseBatch || '未标注批次')}</span><div class="secondary-text">${escapeHtml(item.supplier || detail.connection.supplierName)}</div>`,
      `<span class="tag neutral">${escapeHtml(item.costProfile || '未绑定模板')}</span>`, cny(item.totalCost),
      `${dateOnly(item.effectiveFrom)} - ${dateOnly(item.effectiveTo)}`, supplierState(item.status, item.status === 'active' ? '生效' : item.status),
    ]), 920)}
  </section>`;
}

function supplierQualityMs(value) {
  return supplierNumber(value) === null ? '--' : `${Math.round(Number(value))} ms`;
}

function supplierQualityTab(detail) {
  const quality = detail.quality || {};
  const score = quality.score || {};
  const metrics = quality.metrics || {};
  const targets = quality.targets || [];
  const observations = quality.observations || [];
  const sourceLabel = {
    passive_usage: '被动用量',
    passive_monitor: '被动监控',
    active_probe: '主动探测',
  };
  return `<section class="detail-section supplier-detail-section supplier-quality-section">
    <div class="detail-section-header">
      <div><h3>供应商质量评分</h3><span>当前模式：${escapeHtml(supplierQualityModeLabel(detail.connection.qualityMonitorMode))}。评分使用最近 7 天价格、可用性、首字延迟和稳定性样本。</span></div>
      <button type="button" class="button primary" data-supplier-quality-add ${['active', 'hybrid'].includes(detail.connection.qualityMonitorMode) ? '' : 'disabled'}>${icon('plus')}添加主动目标</button>
    </div>
    <div class="detail-metrics supplier-quality-metrics">
      ${metric('综合评分', score.overallScore === null || score.overallScore === undefined ? '--' : Number(score.overallScore).toFixed(1), `可信度 ${score.confidence === null || score.confidence === undefined ? '--' : `${Number(score.confidence).toFixed(1)}%`}`, Number(score.overallScore || 0) >= 80 ? 'good' : Number(score.overallScore || 0) >= 60 ? 'warn' : 'bad')}
      ${metric('可用性', score.availabilityScore === null || score.availabilityScore === undefined ? '--' : `${Number(score.availabilityScore).toFixed(2)}%`, `${compact(metrics.successSamples || 0)} / ${compact(metrics.availabilitySamples || 0)} 成功`, Number(score.availabilityScore || 0) >= 99 ? 'good' : 'warn')}
      ${metric('TTFT P50', supplierQualityMs(metrics.ttftP50Ms), `P95 ${supplierQualityMs(metrics.ttftP95Ms)}`, Number(metrics.ttftP50Ms || 0) <= 3000 ? 'good' : 'warn')}
      ${metric('稳定性', score.stabilityScore === null || score.stabilityScore === undefined ? '--' : Number(score.stabilityScore).toFixed(1), `${compact(metrics.failureCount || 0)} 次失败`, Number(score.stabilityScore || 0) >= 85 ? 'good' : 'warn')}
      ${metric('价格评分', score.priceScore === null || score.priceScore === undefined ? '--' : Number(score.priceScore).toFixed(1), metrics.rateMultiplier === null || metrics.rateMultiplier === undefined ? '暂无倍率样本' : `样本倍率 ${Number(metrics.rateMultiplier).toFixed(4)}x`)}
      ${metric('被动样本', compact((metrics.passiveUsageSamples || 0) + (metrics.passiveMonitorSamples || 0)), `用量 ${compact(metrics.passiveUsageSamples || 0)} · 监控 ${compact(metrics.passiveMonitorSamples || 0)}`)}
      ${metric('主动样本', compact(metrics.activeProbeSamples || 0), targets.length ? `${compact(targets.filter((item) => item.enabled).length)} 个启用目标` : '尚未配置目标')}
      ${metric('最近采样', metrics.lastObservedAt ? dateTime(metrics.lastObservedAt) : '--', `总样本 ${compact(metrics.sampleCount || 0)}`)}
    </div>
    <div class="supplier-quality-block">
      <div class="panel-header"><div><h3>主动探测目标</h3><span>每个目标固定绑定一个供应商密钥和模型，最大输出 Token 用于控制费用。</span></div></div>
      ${targets.length ? table([
        { label: '密钥 / 模型' }, { label: '策略' }, { label: '最近结果' }, { label: '下次探测' }, { label: '操作' },
      ], targets.map((target) => [
        `<span class="primary-text">${escapeHtml(target.keyName || target.maskedKey || `密钥 #${target.keyId}`)}</span><div class="secondary-text">${escapeHtml(target.model)}</div>`,
        `<span class="primary-text">${target.enabled ? `每 ${compact(target.intervalSeconds)} 秒` : '已停用'}</span><div class="secondary-text">最多 ${compact(target.maxOutputTokens)} Token</div>`,
        `${supplierState(target.lastStatus || 'pending')}<div class="secondary-text">${target.lastProbeAt ? dateTime(target.lastProbeAt) : '尚未探测'}${target.lastError ? `<br>${escapeHtml(target.lastError)}` : ''}</div>`,
        target.enabled ? dateTime(target.nextProbeAt) : '--',
        `<div class="table-actions"><button type="button" class="icon-button table-icon" title="编辑目标" data-supplier-quality-edit="${target.id}">${icon('settings-2')}</button><button type="button" class="icon-button table-icon" title="立即探测" data-supplier-quality-run="${target.id}" ${target.enabled ? '' : 'disabled'}>${icon('activity')}</button><button type="button" class="icon-button table-icon" title="删除目标" data-supplier-quality-delete="${target.id}">${icon('trash-2')}</button></div>`,
      ]), 940) : '<div class="empty"><strong>尚未配置主动探测目标</strong><p>切换到“仅主动”或“混合”模式后，选择密钥和模型即可开始受控探测。</p></div>'}
    </div>
    <div class="supplier-quality-block">
      <div class="panel-header"><div><h3>最近质量样本</h3><span>仅保存脱敏指标，不保存供应商明文密钥或模型输出。</span></div></div>
      ${observations.length ? table([
        { label: '时间' }, { label: '来源' }, { label: '模型' }, { label: '状态' }, { label: 'TTFT' }, { label: '完整耗时' },
      ], observations.slice(0, 30).map((item) => [
        dateTime(item.observedAt), escapeHtml(sourceLabel[item.sourceKind] || item.sourceKind || '--'),
        escapeHtml(item.model || '--'), supplierState(item.status), supplierQualityMs(item.ttftMs), supplierQualityMs(item.durationMs),
      ]), 800) : '<div class="empty"><strong>暂无质量样本</strong><p>下一次供应商同步或主动探测完成后会显示数据。</p></div>'}
    </div>
  </section>`;
}

function openSupplierQualityTargetModal(detail, target = null) {
  const keys = (detail.keys || []).filter((item) => item.status === 'active' && !item.removedAt);
  if (!keys.length) return toast('当前连接没有可用于主动探测的供应商密钥');
  const selectedKeyId = Number(target?.keyId || keys[0].id);
  openContentModal(target ? '编辑主动探测目标' : '添加主动探测目标', `
    <div class="supplier-quality-target-form">
      <label class="field"><span>供应商密钥</span><select name="keyId">${keys.map((key) => (
        `<option value="${key.id}" ${Number(key.id) === selectedKeyId ? 'selected' : ''}>${escapeHtml(key.name || key.maskedKey || `密钥 #${key.id}`)} · ${escapeHtml(key.groupName || '未分组')}</option>`
      )).join('')}</select></label>
      <label class="field"><span>探测模型</span><select name="model" required><option value="">正在读取模型...</option></select><small class="field-hint">模型来自该密钥的 /v1/models 接口</small></label>
      <label class="field"><span>探测间隔（秒）</span><input name="intervalSeconds" type="number" min="60" max="86400" required value="${escapeHtml(target?.intervalSeconds || 1800)}"></label>
      <label class="field"><span>最大输出 Token</span><input name="maxOutputTokens" type="number" min="1" max="32" required value="${escapeHtml(target?.maxOutputTokens || 1)}"></label>
      <label class="supplier-form-toggle full"><input name="enabled" type="checkbox" ${target?.enabled === false ? '' : 'checked'}><span>启用此目标</span><small>到期后自动发起最小流式请求</small></label>
    </div>
    <div class="form-actions"><button type="button" class="button" data-supplier-quality-cancel>取消</button><button type="submit" class="button primary">保存目标</button></div>
  `, 'supplier-quality-target-modal');
  const form = document.querySelector('#modal-form');
  const keySelect = form.elements.keyId;
  const modelSelect = form.elements.model;
  const loadModels = async () => {
    modelSelect.disabled = true;
    modelSelect.innerHTML = '<option value="">正在读取模型...</option>';
    try {
      const result = await api(`/supplier-keys/${keySelect.value}/models`, { range: false });
      const models = result.models || [];
      modelSelect.innerHTML = models.length
        ? models.map((model) => `<option value="${escapeHtml(model)}" ${target?.model === model ? 'selected' : ''}>${escapeHtml(model)}</option>`).join('')
        : '<option value="">该密钥未返回可用模型</option>';
    } catch (error) {
      modelSelect.innerHTML = '<option value="">模型读取失败</option>';
      toast(error.message);
    } finally {
      modelSelect.disabled = false;
    }
  };
  keySelect.addEventListener('change', loadModels);
  form.querySelector('[data-supplier-quality-cancel]')?.addEventListener('click', () => renderSupplierConnectionDetails(detail));
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!modelSelect.value) return toast('请选择探测模型');
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const payload = {
        keyId: Number(keySelect.value), model: modelSelect.value,
        intervalSeconds: Number(form.elements.intervalSeconds.value),
        maxOutputTokens: Number(form.elements.maxOutputTokens.value),
        enabled: form.elements.enabled.checked,
      };
      await api(target ? `/supplier-quality-targets/${target.id}` : `/supplier-connections/${detail.connection.id}/quality-targets`, {
        method: target ? 'PATCH' : 'POST', range: false, body: JSON.stringify(payload),
      });
      toast('主动探测目标已保存');
      await loadSupplierConnectionDetails(detail.connection.id);
    } catch (error) {
      toast(error.message);
      submit.disabled = false;
    }
  };
  loadModels();
}

function supplierDetailContent(detail) {
  switch (state.supplierDetail?.tab) {
    case 'quality': return supplierQualityTab(detail);
    case 'balances': return supplierBalancesTab(detail);
    case 'checks': return supplierChecksTab(detail);
    case 'alerts': return supplierAlertsTab(detail);
    case 'purchases': return supplierPurchasesTab(detail);
    default: return supplierKeysTab(detail);
  }
}

function renderSupplierConnectionDetails(detail) {
  if (!state.supplierDetail || state.supplierDetail.id !== Number(detail.connection.id)) return;
  state.supplierDetail.data = detail;
  const connection = detail.connection;
  const keys = detail.keys || [];
  const activeKeys = keys.filter((item) => item.status === 'active' && !item.removedAt).length;
  const failedChecks = keys.filter((item) => item.lastCheckStatus === 'failed' && !item.removedAt).length;
  const openAlerts = (detail.alerts || []).filter((item) => item.status === 'open').length;
  openContentModal(`${connection.supplierName} · ${connection.name}`, `
    <div class="supplier-detail-header">
      <div class="supplier-detail-identity"><strong>${escapeHtml(connection.name)}</strong><span>${escapeHtml(connection.supplierName)} · ${escapeHtml(connection.baseUrl)} · ${escapeHtml(supplierAdapterLabel(connection.detectedAdapterType || connection.adapterType))} · ${escapeHtml(supplierAuthModeLabel(connection.authMode))}</span></div>
      <div class="supplier-detail-actions">
        <button type="button" class="button" data-supplier-detail-edit>${icon('settings-2')}编辑连接</button>
        <button type="button" class="button primary" data-supplier-detail-sync ${!connection.enabled ? 'disabled' : ''}>${icon('refresh-cw')}立即同步</button>
      </div>
    </div>
    <div class="supplier-detail-status-row">${supplierState(connection.connectionStatus)}<span>${escapeHtml(supplierConnectionStatusHint(connection))}</span>${connection.lastSyncAt ? `<span>最近尝试 ${escapeHtml(dateTime(connection.lastSyncAt))}</span>` : ''}</div>
    <div class="detail-metrics supplier-detail-metrics">
      ${metric('当前余额', supplierAmount(connection.balance, connection.balanceCurrency), connection.lowBalanceThreshold === null || connection.lowBalanceThreshold === undefined ? `币种 ${connection.balanceCurrency || '--'} · 未设阈值` : `告警阈值 ${supplierAmount(connection.lowBalanceThreshold, connection.balanceCurrency)}`, connection.connectionStatus === 'failed' ? 'bad' : 'good')}
      ${metric('可用密钥', `${compact(activeKeys)} / ${compact(keys.length)}`, failedChecks ? `${compact(failedChecks)} 个巡检失败` : '未发现巡检异常', failedChecks ? 'warn' : 'good')}
      ${metric('待处理告警', compact(openAlerts), openAlerts ? '请在告警页确认或排查' : '当前没有开放告警', openAlerts ? 'warn' : 'good')}
      ${metric('下次同步', connection.enabled ? dateTime(connection.nextSyncAt) : '已停用', connection.enabled ? `每 ${compact(connection.inventoryIntervalSeconds || (connection.inventoryIntervalMinutes || 10) * 60)} 秒读取一次` : '启用后恢复定时读取')}
    </div>
    ${supplierDetailTabs(detail)}
    ${supplierDetailContent(detail)}
  `, 'supplier-detail-modal');

  const form = document.querySelector('#modal-form');
  form.onclick = async (event) => {
    const tab = event.target.closest('[data-supplier-detail-tab]');
    const edit = event.target.closest('[data-supplier-detail-edit]');
    const sync = event.target.closest('[data-supplier-detail-sync]');
    const linkPicker = event.target.closest('[data-supplier-key-link-picker]');
    const unlink = event.target.closest('[data-supplier-key-unlink]');
    const acknowledge = event.target.closest('[data-supplier-alert-ack]');
    const cost = event.target.closest('[data-supplier-detail-cost]');
    const qualityAdd = event.target.closest('[data-supplier-quality-add]');
    const qualityEdit = event.target.closest('[data-supplier-quality-edit]');
    const qualityRun = event.target.closest('[data-supplier-quality-run]');
    const qualityDelete = event.target.closest('[data-supplier-quality-delete]');
    if (tab) {
      state.supplierDetail.tab = tab.dataset.supplierDetailTab;
      renderSupplierConnectionDetails(detail);
      return;
    }
    if (edit) {
      openSupplierConnectionModal(connection);
      return;
    }
    if (sync && !sync.disabled) {
      sync.disabled = true;
      try {
        const result = await api(`/supplier-connections/${connection.id}/sync`, { method: 'POST', range: false });
        toast(result.sync?.ok === false ? '同步未完成，请查看连接异常' : '供应商连接已同步');
        await loadSupplierConnectionDetails(connection.id);
        if (state.page === 'suppliers') await renderSuppliers();
      } catch (error) {
        toast(error.message);
        sync.disabled = false;
      }
      return;
    }
    if (linkPicker) {
      openSupplierKeyLinkPicker(Number(linkPicker.dataset.supplierKeyLinkPicker));
      return;
    }
    if (unlink) {
      const keyId = Number(unlink.dataset.supplierKeyUnlink);
      const accountId = Number(unlink.dataset.supplierAccountId);
      unlink.disabled = true;
      try {
        await api(`/supplier-keys/${keyId}/account-link`, {
          method: 'PATCH', range: false, body: JSON.stringify({ accountId, linked: false }),
        });
        toast('已解除本地账号关联');
        await loadSupplierConnectionDetails(connection.id);
      } catch (error) {
        toast(error.message);
        unlink.disabled = false;
      }
      return;
    }
    if (acknowledge) {
      acknowledge.disabled = true;
      try {
        await api(`/supplier-alerts/${acknowledge.dataset.supplierAlertAck}/acknowledge`, { method: 'POST', range: false });
        toast('告警已确认');
        await loadSupplierConnectionDetails(connection.id);
        if (state.page === 'suppliers') await renderSuppliers();
      } catch (error) {
        toast(error.message);
        acknowledge.disabled = false;
      }
      return;
    }
    if (qualityAdd) {
      openSupplierQualityTargetModal(detail);
      return;
    }
    if (qualityEdit) {
      const target = detail.quality?.targets?.find((item) => Number(item.id) === Number(qualityEdit.dataset.supplierQualityEdit));
      if (target) openSupplierQualityTargetModal(detail, target);
      return;
    }
    if (qualityRun && !qualityRun.disabled) {
      qualityRun.disabled = true;
      try {
        const result = await api(`/supplier-quality-targets/${qualityRun.dataset.supplierQualityRun}/run`, { method: 'POST', range: false });
        toast(result.ok === false ? '主动模型探测失败，已记录失败样本' : '主动模型探测已完成');
        await loadSupplierConnectionDetails(connection.id);
      } catch (error) {
        toast(error.message);
        qualityRun.disabled = false;
      }
      return;
    }
    if (qualityDelete) {
      if (!window.confirm('确定删除这个主动探测目标吗？历史质量样本也会一并删除。')) return;
      qualityDelete.disabled = true;
      try {
        await api(`/supplier-quality-targets/${qualityDelete.dataset.supplierQualityDelete}`, { method: 'DELETE', range: false });
        toast('主动探测目标已删除');
        await loadSupplierConnectionDetails(connection.id);
      } catch (error) {
        toast(error.message);
        qualityDelete.disabled = false;
      }
      return;
    }
    if (cost) openSupplierPurchaseCostModal(detail);
  };
}

function supplierAvailableAccounts(detail, keyId, search = '') {
  const linked = new Set((detail.keys || [])
    .filter((key) => Number(key.id) !== Number(keyId))
    .flatMap((key) => (key.accountLinks || []).map((link) => Number(link.accountId))));
  const needle = String(search || '').trim().toLowerCase();
  return (detail.accounts || []).filter((account) => (
    account.status === 'active'
      && !linked.has(Number(account.id))
      && (!needle || `${account.name} ${account.platform} ${account.id}`.toLowerCase().includes(needle))
  ));
}

function renderSupplierKeyLinkPickerResults(detail, keyId, search = '') {
  const host = document.querySelector('[data-supplier-link-results]');
  if (!host) return;
  const accounts = supplierAvailableAccounts(detail, keyId, search);
  const visible = accounts.slice(0, 50);
  host.innerHTML = visible.length ? `${table([
    { label: '本地账号' }, { label: '平台' }, { label: '状态' }, { label: '操作' },
  ], visible.map((account) => [
    `<span class="primary-text">${escapeHtml(account.name || `账号 #${account.id}`)}</span><div class="secondary-text">#${escapeHtml(account.id)}</div>`,
    escapeHtml(account.platform || '--'), supplierState(account.status, account.status === 'active' ? '可用' : account.status),
    `<button type="button" class="button" data-supplier-link-account="${account.id}">关联</button>`,
  ]), 650)}${accounts.length > visible.length ? `<p class="supplier-result-note">仅显示前 ${compact(visible.length)} 个结果，请继续缩小搜索范围。</p>` : ''}`
    : '<div class="empty"><strong>没有可关联的本地账号</strong><p>账号可能已关联到其他供应商密钥，或不在当前可用状态。</p></div>';
  host.querySelectorAll('[data-supplier-link-account]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await api(`/supplier-keys/${keyId}/account-link`, {
          method: 'PATCH', range: false,
          body: JSON.stringify({ accountId: Number(button.dataset.supplierLinkAccount), linked: true }),
        });
        toast(result.sync?.ok === false
          ? '账号已关联并切换为自动倍率，供应商同步暂未成功'
          : '账号已关联，成本将按该密钥的探测倍率自动计算');
        await loadSupplierConnectionDetails(detail.connection.id);
      } catch (error) {
        toast(error.message);
        button.disabled = false;
      }
    });
  });
}

function openSupplierKeyLinkPicker(keyId) {
  const detail = state.supplierDetail?.data;
  const key = detail?.keys?.find((item) => Number(item.id) === Number(keyId));
  if (!detail || !key) return;
  openContentModal('关联本地账号', `
    <div class="supplier-link-picker-heading"><strong>${escapeHtml(key.name || key.maskedKey || `密钥 #${key.id}`)}</strong><span>${escapeHtml(key.maskedKey || key.externalId || '--')} · ${escapeHtml(key.groupName || '未分组')}</span></div>
    <label class="whitelist-search supplier-link-search">${icon('search')}<input type="search" data-supplier-link-search placeholder="搜索本地账号、平台或 ID"></label>
    <div data-supplier-link-results></div>
    <div class="form-actions"><button type="button" class="button" data-supplier-link-back>返回详情</button></div>
  `, 'supplier-link-modal');
  const form = document.querySelector('#modal-form');
  const search = form.querySelector('[data-supplier-link-search]');
  let timer;
  search?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => renderSupplierKeyLinkPickerResults(detail, keyId, search.value), 180);
  });
  form.querySelector('[data-supplier-link-back]')?.addEventListener('click', () => renderSupplierConnectionDetails(detail));
  renderSupplierKeyLinkPickerResults(detail, keyId);
}

async function loadSupplierConnectionDetails(connectionId) {
  const current = state.supplierDetail;
  if (!current || current.id !== Number(connectionId)) return;
  const form = document.querySelector('#modal-form');
  if (form) form.innerHTML = '<div class="detail-loading"><span></span>正在读取供应商连接详情</div>';
  try {
    const [detail, quality] = await Promise.all([
      api(`/supplier-connections/${connectionId}/details`, { range: false }),
      api(`/supplier-connections/${connectionId}/quality`, { range: false }),
    ]);
    const overview = await api(`/suppliers?search=${encodeURIComponent(detail.connection.supplierName || '')}`);
    const supplierName = String(detail.connection.supplierName || '').trim().toLowerCase();
    const purchases = (overview.purchases || []).filter((item) => (
      String(item.supplier || '').trim().toLowerCase() === supplierName
    ));
    if (!state.supplierDetail || state.supplierDetail.id !== Number(connectionId)) return;
    renderSupplierConnectionDetails({ ...detail, quality, purchases });
  } catch (error) {
    if (!state.supplierDetail || state.supplierDetail.id !== Number(connectionId)) return;
    const currentForm = document.querySelector('#modal-form');
    if (currentForm) currentForm.innerHTML = `<div class="empty"><strong>供应商连接详情读取失败</strong><p>${escapeHtml(error.message)}</p><button type="button" class="button" data-supplier-detail-retry>重新加载</button></div>`;
    currentForm?.querySelector('[data-supplier-detail-retry]')?.addEventListener('click', () => loadSupplierConnectionDetails(connectionId));
  }
}

function openSupplierConnectionDetails(connectionId) {
  state.supplierDetail = { id: Number(connectionId), tab: 'keys', data: null };
  openContentModal('供应商连接详情', '<div class="detail-loading"><span></span>正在读取供应商连接详情</div>', 'supplier-detail-modal');
  loadSupplierConnectionDetails(Number(connectionId));
}

async function openSupplierPurchaseCostModal(detail) {
  try {
    const [profiles, catalog] = await Promise.all([
      api('/cost-profiles', { range: false }),
      loadPurchaseCatalog(),
    ]);
    const accounts = (detail.accounts || []).filter((item) => item.status === 'active');
    if (!accounts.length) return toast('没有可登记采购成本的本地账号');
    const picker = {
      options: accounts.map((item) => [item.id, `${item.name} · ${item.platform || '--'}`]),
      value: accounts[0].id,
      supplier: detail.connection.supplierName,
    };
    openModal(`登记采购成本 · ${detail.connection.supplierName}`, costFields(profiles, picker, { includeAccount: true, catalog }), (data) => api('/account-cost-periods', {
      method: 'POST', range: false, body: JSON.stringify(normalizeCostPayload(data)),
    }));
    bindPurchaseCatalogForm(document.querySelector('#modal-form'), catalog);
    document.querySelector('#form-cancel').onclick = () => renderSupplierConnectionDetails(detail);
  } catch (error) {
    toast(error.message);
  }
}

async function renderSuppliers(search = state.supplierSearch) {
  state.supplierSearch = search;
  const [source, connectionSource, profiles, accountData] = await Promise.all([
    api(`/suppliers?search=${encodeURIComponent(search)}`),
    api(`/supplier-connections?search=${encodeURIComponent(search)}`, { range: false }),
    api('/cost-profiles', { range: false }),
    api(`/accounts?${queryFor('supplierAccounts', search)}`),
  ]);
  const connections = localPage(connectionSource.items || [], 'supplierConnections');
  const suppliers = localPage(source.items || [], 'suppliersList');
  const purchases = localPage(source.purchases || [], 'purchasesList');
  const summary = source.summary || {};
  state.supplierConnectionItems = new Map((connectionSource.items || []).map((item) => [String(item.id), item]));
  state.lastExport = connections.items;
  content.innerHTML = `${section('供应商连接', '通过 FinOps 读取供应商门户的余额、密钥库存、巡检和告警；不等同于采购成本记录')}
    <section class="table-panel supplier-connection-panel">${searchTools('搜索供应商、连接、站点或采购批次', `<button type="button" class="button primary" id="supplier-connection-create">${icon('plus')}新建连接</button>`, search)}
      <div class="supplier-connection-note">连接凭据仅加密保存在 FinOps。同步和巡检均为读取操作，采购金额、生效期与成本分摊请在下方单独登记。</div>
      ${table([
        { label: '供应商连接' }, { label: '连接状态' }, { label: '余额' }, { label: '密钥 / 异常' }, { label: '告警' }, { label: '最近同步' }, { label: '操作' },
      ], connections.items.map((item) => [
        `<button type="button" class="supplier-connection-link" data-supplier-connection-detail="${item.id}"><span>${escapeHtml(item.supplierName || '未命名供应商')}</span><small>${escapeHtml(item.name || '默认连接')} · ${escapeHtml(supplierAdapterLabel(item.detectedAdapterType || item.adapterType))} · ${escapeHtml(supplierAuthModeLabel(item.authMode))}</small></button><div class="secondary-text supplier-url">${escapeHtml(item.baseUrl || '--')}</div>`,
        `${supplierState(item.connectionStatus)}<div class="secondary-text supplier-connection-status-hint">${escapeHtml(supplierConnectionStatusHint(item))}</div>`,
        `<span class="primary-text">${escapeHtml(supplierAmount(item.balance, item.balanceCurrency))}</span><div class="secondary-text">${item.lowBalanceThreshold === null || item.lowBalanceThreshold === undefined ? `币种 ${escapeHtml(item.balanceCurrency || '--')} · 未设阈值` : `阈值 ${escapeHtml(supplierAmount(item.lowBalanceThreshold, item.balanceCurrency))}`}</div>`,
        `<span class="primary-text">${compact(item.activeKeyCount)} / ${compact(item.keyCount)} 可用</span><div class="secondary-text">${item.failedKeyCount ? `${compact(item.failedKeyCount)} 个巡检失败` : '没有巡检失败'}</div>`,
        item.openAlertCount ? `<span class="supplier-alert-count">${compact(item.openAlertCount)} 待处理</span><div class="secondary-text">请查看告警详情</div>` : '<span class="secondary-text">没有开放告警</span>',
        `<span class="primary-text">${item.lastSuccessAt ? escapeHtml(dateTime(item.lastSuccessAt)) : '--'}</span><div class="secondary-text">${item.nextSyncAt ? `下次 ${escapeHtml(dateTime(item.nextSyncAt))}` : item.enabled ? '等待排程' : '连接已停用'}</div>`,
        `<div class="table-actions supplier-row-actions"><button type="button" class="icon-button table-icon" title="查看连接详情" data-supplier-connection-detail="${item.id}">${icon('receipt-text')}</button><button type="button" class="icon-button table-icon" title="编辑连接" data-supplier-connection-edit="${item.id}">${icon('settings-2')}</button><button type="button" class="icon-button table-icon" title="立即同步" data-supplier-connection-sync="${item.id}" ${!item.enabled ? 'disabled' : ''}>${icon('refresh-cw')}</button></div>`,
      ]), 1330)}${pager(connections, 'supplierConnections', '个供应商连接')}
    </section>
    ${section('采购成本核算', '采购批次和成本期独立于供应商连接，按实际人民币采购金额、税费和生效期核算')}
    <div class="metric-grid">
      ${metric('供应商', compact(summary.supplierCount), '按采购成本归集')}
      ${metric('关联账号', compact(summary.accountCount), '已归集到采购口径')}
      ${metric('期间采购', cny(summary.purchaseSpend), '含手续费与税费', 'warn')}
      ${metric('经营毛利', cny(summary.grossProfit), '实际消费减已登记成本', Number(summary.grossProfit) >= 0 ? 'good' : 'bad')}
      ${metric('待补成本账号', compact(summary.unbookedAccountCount), '有用量但无成本期间', Number(summary.unbookedAccountCount) ? 'warn' : 'good')}
    </div>
    <section class="table-panel"><div class="table-tools supplier-procurement-tools"><span class="supplier-filter-note">采购核算沿用上方搜索条件</span><div class="table-actions"><button type="button" class="button primary" id="supplier-cost-button">${icon('plus')}登记采购成本</button></div></div>${
      table([
        { label: '供应商' }, { label: '平台' }, { label: '账号', right: true }, { label: '实际消费 CNY', right: true },
        { label: '采购分摊 CNY', right: true }, { label: '已登记成本 CNY', right: true }, { label: '经营毛利 CNY', right: true }, { label: '成本覆盖' },
      ], suppliers.items.map((item) => [
        `<span class="primary-text">${escapeHtml(item.supplier)}</span><div class="secondary-text">${item.missingRuleCount ? `${item.missingRuleCount} 个账号缺成本规则` : '成本规则完整'}</div>`,
        tags(item.platforms), compact(item.accountCount), cny(item.userChargeCny), cny(item.purchaseAllocatedCostCny), cny(item.bookedCostCny),
        `<span class="${profitClass(item.bookedProfitCny)}">${cny(item.bookedProfitCny)}</span>`, costCoverage(item),
      ]), 1080)
    }${pager(suppliers, 'suppliersList', '个供应商')}</section>
    <section class="table-panel supplier-purchase-panel"><div class="panel-header"><div><h2>采购批次</h2><span>账号采购成本、生效期和供应商归属</span></div></div>${table([
      { label: '账号' }, { label: '供应商 / 批次' }, { label: '成本模板' }, { label: '含税费 CNY', right: true }, { label: '生效期' }, { label: '状态' },
    ], purchases.items.map((item) => [
      `<span class="primary-text">${escapeHtml(item.accountName)}</span><div class="secondary-text">#${item.accountId}</div>`,
      `<span class="primary-text">${escapeHtml(item.supplier)}</span><div class="secondary-text">${escapeHtml(item.purchaseBatch)}</div>`,
      `<span class="tag neutral">${escapeHtml(item.costProfile)}</span>`, cny(item.totalCost),
      `${dateOnly(item.effectiveFrom)} - ${dateOnly(item.effectiveTo)}`, supplierState(item.status, item.status === 'active' ? '生效' : item.status),
    ]), 920)}${pager(purchases, 'purchasesList', '个采购批次')}</section>`;
  bindSearch(renderSuppliers);
  document.querySelector('#supplier-connection-create')?.addEventListener('click', () => openSupplierConnectionModal());
  document.querySelectorAll('[data-supplier-connection-detail]').forEach((button) => {
    button.addEventListener('click', () => openSupplierConnectionDetails(Number(button.dataset.supplierConnectionDetail)));
  });
  document.querySelectorAll('[data-supplier-connection-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const connection = state.supplierConnectionItems.get(button.dataset.supplierConnectionEdit);
      if (connection) openSupplierConnectionModal(connection);
    });
  });
  document.querySelectorAll('[data-supplier-connection-sync]').forEach((button) => {
    button.addEventListener('click', async () => {
      const connection = state.supplierConnectionItems.get(button.dataset.supplierConnectionSync);
      if (!connection || button.disabled) return;
      button.disabled = true;
      try {
        const result = await api(`/supplier-connections/${connection.id}/sync`, { method: 'POST', range: false });
        toast(result.sync?.ok === false ? '同步未完成，请查看连接异常' : '供应商连接已同步');
        await renderSuppliers();
      } catch (error) {
        toast(error.message);
        button.disabled = false;
      }
    });
  });
  document.querySelector('#supplier-cost-button')?.addEventListener('click', () => {
    openSingleCostModal(accountData.items, profiles).catch((error) => toast(error.message));
  });
}

async function renderCosts(search = '') {
  const source = await api('/cost-profiles', { range: false });
  const needle = search.trim().toLowerCase();
  const filtered = needle ? source.filter((item) => `${item.name} ${item.costType} ${item.costMode} ${item.allocationMethod}`.toLowerCase().includes(needle)) : source;
  const data = localPage(filtered, 'costProfiles');
  state.lastExport = data.items;
  content.innerHTML = `${section('成本规则', '模板定义固定采购、探测倍率或手动倍率的成本口径')}
    <section class="table-panel">${searchTools('搜索模板、成本类型或分摊方法', `<button type="button" class="button primary" id="profile-button">${icon('plus')}新建成本模板</button>`, search)}${
      table([
        { label: '模板名称' }, { label: '核算模式' }, { label: '成本基础' }, { label: '倍率/基准' }, { label: '分摊方法' }, { label: '绑定账号', right: true },
      ], data.items.map((item) => [
        `<span class="primary-text">${escapeHtml(item.name)}</span><div class="secondary-text">v${item.version}</div>`,
        `<span class="tag neutral">${escapeHtml(costModeLabel(item.costMode))}</span>`,
        escapeHtml(item.basisMode === 'reference_cny' ? '目录价 CNY 基准' : '实际扣款回推'),
        item.costMode === 'manual_multiplier' ? `上游 ${multiplier(item.variableMultiplier)}`
          : item.basisMode === 'reference_cny' ? cny(item.cnyPerReferenceUnit) : '消费记录倍率',
        escapeHtml(item.allocationMethod), compact(item.accountCount),
      ]), 960)
    }${pager(data, 'costProfiles', '个模板')}</section>`;
  bindSearch(renderCosts);
  document.querySelector('#profile-button')?.addEventListener('click', openCostProfileModal);
}

async function renderRuntime() {
  const data = await api('/runtime?live=1', { range: false });
  const queue = data.queue || { available: false };
  const activeWorkers = Number(queue.activeWorkers || 0);
  const workerCount = Number(queue.workerCount || 0);
  const queueLength = Number(queue.queueLength || 0);
  const queueUsage = Number(queue.queueUsagePercent || 0);
  const queueUsageDisplay = queueUsage <= 1 ? queueUsage * 100 : queueUsage;
  state.lastExport = data.users || [];
  content.innerHTML = `${section('并发与排队', '只读展示 Sub2API 风控队列和用户当前并发；数据由 FinOps 定时快照保存，不会改变上游请求处理')}
    <div class="metric-grid">
      ${metric('队列状态', !queue.available ? '等待快照' : queue.enabled ? '已启用' : '未启用', queue.available ? `模式 ${queue.mode || '--'}` : '使用管理员登录后自动读取', queue.available && queue.enabled ? 'good' : 'warn')}
      ${metric('排队长度', queue.available ? compact(queueLength) : '--', queue.available ? `容量 ${compact(queue.queueSize || 0)} · 使用率 ${queueUsageDisplay.toFixed(1)}%` : '暂无上游快照', queueLength ? 'warn' : 'good')}
      ${metric('工作线程', queue.available ? `${activeWorkers} / ${workerCount}` : '--', queue.available ? `空闲 ${compact(queue.idleWorkers || 0)} 个` : '暂无上游快照', activeWorkers >= workerCount && workerCount ? 'warn' : 'good')}
      ${metric('累计处理', queue.available ? compact(queue.processed || 0) : '--', queue.available ? `错误 ${compact(queue.errors || 0)} 次` : '暂无上游快照', Number(queue.errors || 0) ? 'warn' : 'good')}
      ${metric('最近采样', queue.available ? dateTime(queue.observedAt) : '--', '默认随 FinOps 同步刷新')}
    </div>
    <section class="table-panel">
      <div class="panel-header"><h2>用户当前并发</h2><span>${compact((data.users || []).length)} 位活跃用户</span></div>
      ${table([
        { label: '用户' }, { label: '当前并发', right: true }, { label: '并发上限', right: true }, { label: '使用率', right: true }, { label: '采样时间' },
      ], (data.users || []).map((item) => [
        `<span class="primary-text">${escapeHtml(item.email || item.username || `用户 #${item.id}`)}</span><div class="secondary-text">ID ${item.id}${item.username && item.username !== item.email ? ` · ${escapeHtml(item.username)}` : ''}</div>`,
        compact(item.currentConcurrency), compact(item.maxConcurrency),
        item.usagePercent === null ? '--' : `<div>${Number(item.usagePercent).toFixed(1)}%</div><div class="progress"><span style="width:${Math.min(100, Math.max(0, Number(item.usagePercent)))}%"></span></div>`,
        dateTime(item.observedAt),
      ]), 880)}
    </section>`;
}

const renderers = {
  overview: renderOverview,
  users: renderUsersEnhanced,
  accounts: renderAccounts,
  usage: renderUsage,
  suppliers: renderSuppliers,
  costs: renderCosts,
  runtime: renderRuntime,
};

async function render() {
  clearTimeout(state.runtimeRefreshTimer);
  state.runtimeRefreshTimer = null;
  content.innerHTML = '<div class="loading"><span></span>正在读取经营数据</div>';
  const [pageTitle, pageSubtitle] = pageMeta[state.page];
  title.textContent = pageTitle;
  subtitle.textContent = pageSubtitle;
  document.querySelectorAll('.nav-item').forEach((item) => {
    const active = item.dataset.page === state.page;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  });
  try {
    await renderers[state.page]();
    scheduleRuntimeRefresh();
  } catch (error) {
    content.innerHTML = `<div class="empty"><strong>数据读取失败</strong><p>${escapeHtml(error.message)}</p><button class="button" id="retry">重新加载</button></div>`;
    document.querySelector('#retry')?.addEventListener('click', render);
  }
}

function scheduleRuntimeRefresh() {
  if (!['overview', 'runtime'].includes(state.page)) return;
  state.runtimeRefreshTimer = setTimeout(async () => {
    if (state.page === 'runtime') {
      render();
      return;
    }
    try {
      await refreshOverviewRuntimePanel();
    } catch (error) {
      console.warn('Unable to refresh overview runtime snapshot', error);
    }
    if (state.page === 'overview') scheduleRuntimeRefresh();
  }, RUNTIME_LIVE_REFRESH_MS);
}

function modalControl(field) {
  if (field.type === 'notice') {
    return `<div class="form-notice ${field.tone || ''}" ${field.hook ? `data-${escapeHtml(field.hook)}` : ''}>${escapeHtml(field.value || '')}</div>`;
  }
  const required = field.required === false ? '' : 'required';
  if (field.type === 'select') {
    return `<select name="${escapeHtml(field.name)}" ${required}>${selectOptions(field.options, field.value)}</select>`;
  }
  if (field.type === 'textarea') {
    return `<textarea name="${escapeHtml(field.name)}" ${required}>${escapeHtml(field.value ?? '')}</textarea>`;
  }
  return `<input type="${field.type || 'text'}" name="${escapeHtml(field.name)}" ${required} ${field.type === 'number' ? 'step="any"' : ''} value="${escapeHtml(field.value ?? '')}">`;
}

function selectOptions(options = [], value = '') {
  return options.map(([optionValue, label]) => (
    `<option value="${escapeHtml(optionValue)}" ${String(optionValue) === String(value ?? '') ? 'selected' : ''}>${escapeHtml(label)}</option>`
  )).join('');
}

function openModal(titleText, fields, onSubmit, { onSaved } = {}) {
  document.querySelector('.modal').className = 'modal';
  document.querySelector('#modal-title').textContent = titleText;
  const form = document.querySelector('#modal-form');
  form.className = '';
  form.innerHTML = `${fields.map((field) => field.type === 'notice'
    ? `<div class="field full">${modalControl(field)}</div>`
    : `<label class="field ${field.full ? 'full' : ''}"><span>${escapeHtml(field.label)}</span>${modalControl(field)}</label>`).join('')}
    <div class="form-actions"><button type="button" class="button" id="form-cancel">取消</button><button type="submit" class="button primary" data-form-save>保存</button></div>`;
  document.querySelector('#modal-backdrop').hidden = false;
  document.querySelector('#form-cancel').onclick = closeModal;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const save = form.querySelector('[data-form-save]');
    try {
      if (save) {
        save.disabled = true;
        save.textContent = '保存中...';
      }
      const result = await onSubmit(data);
      toast('已保存');
      if (onSaved) await onSaved(result);
      else {
        closeModal();
        await render();
      }
    } catch (error) {
      toast(error.message);
      if (save) {
        save.disabled = false;
        save.textContent = '保存';
      }
    }
  };
}

function openContentModal(titleText, contentHtml, modalClass = '') {
  const modal = document.querySelector('.modal');
  const form = document.querySelector('#modal-form');
  modal.className = `modal ${modalClass}`.trim();
  document.querySelector('#modal-title').textContent = titleText;
  form.className = 'modal-content';
  form.innerHTML = contentHtml;
  form.onsubmit = (event) => event.preventDefault();
  document.querySelector('#modal-backdrop').hidden = false;
}

function closeModal() {
  document.querySelector('#modal-backdrop').hidden = true;
  state.userDetail = null;
  state.overviewDetail = null;
  state.whitelistManager = null;
  state.supplierDetail = null;
}

function catalogSupplierOptions(catalog, selected = '') {
  const names = [...new Set((catalog?.suppliers || []).map((item) => String(item || '').trim()).filter(Boolean))];
  const options = [['', '不关联供应商（自有账号）'], ...names.map((item) => [item, item])];
  if (selected && !names.some((item) => item.toLowerCase() === String(selected).toLowerCase())) {
    options.splice(1, 0, [selected, `${selected}（历史记录）`]);
  }
  return options;
}

function catalogPurchaseBatchOptions(catalog, supplier, selected = '', { allowNew = true } = {}) {
  const supplierName = String(supplier || '').trim().toLowerCase();
  const names = [...new Set((catalog?.batches || [])
    .filter((item) => String(item.supplier || '').trim().toLowerCase() === supplierName)
    .map((item) => String(item.purchaseBatch || '').trim())
    .filter(Boolean))];
  const options = [['', '不关联采购批次']];
  if (selected && selected !== NEW_PURCHASE_BATCH_VALUE && !names.includes(selected)) {
    options.push([selected, `${selected}（历史记录）`]);
  }
  options.push(...names.map((item) => [item, item]));
  if (allowNew && supplierName) options.push([NEW_PURCHASE_BATCH_VALUE, '新建采购批次...']);
  return options;
}

function catalogSupplierKeyOptions(catalog, account) {
  const keys = new Map();
  for (const item of catalog?.supplierKeys || []) {
    if (!keys.has(String(item.id))) keys.set(String(item.id), item);
  }
  const options = [['', '请选择已接入的 Sub2API 供应商密钥']];
  for (const item of keys.values()) {
    const identity = item.name || item.maskedKey || `密钥 #${item.id}`;
    const group = item.groupName ? ` · ${item.groupName}` : '';
    const rate = item.rateMultiplier === null || item.rateMultiplier === undefined
      ? '' : ` · ${multiplier(item.rateMultiplier)}`;
    const linked = item.accountId && String(item.accountId) !== String(account?.id)
      ? ` · 已关联账号 #${item.accountId}` : '';
    options.push([item.id, `${item.supplier} · ${identity}${group}${rate}${linked}`]);
  }
  if (account?.supplierKeyId && !keys.has(String(account.supplierKeyId))) {
    options.splice(1, 0, [
      account.supplierKeyId,
      `${account.linkedSupplierName || account.supplier || '历史供应商'} · ${account.supplierKeyName || account.supplierKeyMasked || `密钥 #${account.supplierKeyId}`}（历史关联）`,
    ]);
  }
  return options;
}

function setFormFieldVisible(form, name, visible) {
  const control = form.elements[name];
  const field = control?.closest('.field');
  if (!control || !field) return;
  field.hidden = !visible;
  control.disabled = !visible;
  control.required = visible;
}

function setLedgerFieldVisible(form, name, visible) {
  const control = form.elements[name];
  const field = control?.closest('.field');
  if (!control || !field) return;
  field.hidden = !visible;
  control.disabled = !visible;
}

function syncPurchaseCatalogForm(form, catalog, { allowNewBatch = true } = {}) {
  const supplier = form.elements.supplier;
  const purchaseBatch = form.elements.purchaseBatch;
  if (!supplier || !purchaseBatch) return;
  const selected = purchaseBatch.value;
  const options = catalogPurchaseBatchOptions(catalog, supplier.value, selected, { allowNew: allowNewBatch });
  const nextValue = options.some(([value]) => String(value) === String(selected)) ? selected : '';
  purchaseBatch.innerHTML = selectOptions(options, nextValue);
  purchaseBatch.value = nextValue;
  setFormFieldVisible(form, 'newPurchaseBatch', allowNewBatch && nextValue === NEW_PURCHASE_BATCH_VALUE);
}

function bindPurchaseCatalogForm(form, catalog, { allowNewBatch = true } = {}) {
  syncPurchaseCatalogForm(form, catalog, { allowNewBatch });
  form.elements.supplier?.addEventListener('change', () => syncPurchaseCatalogForm(form, catalog, { allowNewBatch }));
  form.elements.purchaseBatch?.addEventListener('change', () => syncPurchaseCatalogForm(form, catalog, { allowNewBatch }));
}

function normalizePurchaseSelection(data) {
  const payload = { ...data };
  if (payload.purchaseBatch === NEW_PURCHASE_BATCH_VALUE) {
    payload.purchaseBatch = String(payload.newPurchaseBatch || '').trim();
    if (!payload.purchaseBatch) throw new Error('请填写新的采购批次编号');
  }
  delete payload.newPurchaseBatch;
  return payload;
}

async function loadPurchaseCatalog() {
  return api('/purchase-catalog', { range: false });
}

function costFields(profiles, account, {
  includeAccount = false, batch = false, correction = false, catalog = null,
} = {}) {
  const now = new Date();
  const end = new Date(now);
  end.setMonth(end.getMonth() + 1);
  const profileId = account?.currentCostProfileId || account?.costProfileId || '';
  const fixedProfiles = profiles.filter((item) => !item.costMode || item.costMode === 'fixed_purchase');
  return [
    ...(includeAccount ? [{ name: 'accountId', label: '账号', type: 'select', options: account.options, value: account.value }] : []),
    { name: 'costProfileId', label: '固定成本模板（可选）', type: 'select', required: false, value: profileId, options: [['', '不使用模板'], ...fixedProfiles.map((item) => [item.id, item.name])] },
    { name: 'originalAmount', label: batch ? '采购批次总成本 CNY' : '采购总成本 CNY', type: 'number', value: account?.currentOriginalAmount || '' },
    { name: 'feeAmount', label: '手续费 CNY', type: 'number', required: false, value: account?.currentFeeAmount ?? '0' },
    { name: 'taxAmount', label: '税费 CNY', type: 'number', required: false, value: account?.currentTaxAmount ?? '0' },
    ...(batch ? [{ name: 'allocationStrategy', label: '批次分摊方式', type: 'select', options: [['equal', '账号均分'], ['standard_cost_weight', '目录价权重'], ['token_weight', 'Token 权重']] }] : []),
    { name: 'effectiveFrom', label: '生效时间', type: 'datetime-local', value: dateTimeInputValue(account?.currentEffectiveFrom) || dateTimeInputValue(now) },
    { name: 'effectiveTo', label: '结束时间', type: 'datetime-local', value: dateTimeInputValue(account?.currentEffectiveTo) || dateTimeInputValue(end) },
    { name: 'supplier', label: '供应商', type: 'select', required: false, value: account?.supplier || '', options: catalogSupplierOptions(catalog, account?.supplier || '') },
    { name: 'purchaseBatch', label: '采购批次', type: 'select', required: false, value: account?.purchaseBatch || '', options: catalogPurchaseBatchOptions(catalog, account?.supplier || '', account?.purchaseBatch || '') },
    { name: 'newPurchaseBatch', label: '新采购批次编号', required: false, value: '' },
    { name: 'tags', label: '账号标签（逗号分隔）', required: false, value: account?.tags?.join(',') || '' },
    { name: 'notes', label: '备注', type: 'textarea', full: true, required: false, value: account?.currentCostNotes || '' },
    ...(correction ? [
      { type: 'notice', tone: 'warning', value: '该采购成本已经开始生效。保存会按填写的更正原因更新对应历史成本快照和利润。' },
      { name: 'correctionReason', label: '历史更正原因', type: 'textarea', full: true },
    ] : []),
  ];
}

function normalizeCostPayload(data) {
  const selected = normalizePurchaseSelection(data);
  return {
    ...selected,
    originalCurrency: 'CNY',
    fxRate: '1',
    baseAmount: selected.originalAmount,
    tags: selected.tags ? selected.tags.split(',').map((item) => item.trim()).filter(Boolean) : [],
  };
}

async function openSingleCostModal(accounts, profiles) {
  if (!accounts.length) return toast('当前筛选结果没有可登记成本的账号');
  const catalog = await loadPurchaseCatalog();
  const picker = { options: accounts.map((item) => [item.id, item.name]), value: accounts[0].id };
  openModal('登记单个账号成本', costFields(profiles, picker, { includeAccount: true, catalog }), (data) => api('/account-cost-periods', {
    method: 'POST', range: false, body: JSON.stringify(normalizeCostPayload(data)),
  }));
  bindPurchaseCatalogForm(document.querySelector('#modal-form'), catalog);
}

function accountCostHistoryPager(data) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return `<div class="pager">
    <span>共 ${compact(data.total)} 条成本记录</span>
    <label>每页<select data-cost-history-page-size>${[10, 20, 50, 100].map((size) => `<option value="${size}" ${size === data.pageSize ? 'selected' : ''}>${size}</option>`).join('')}</select></label>
    <div class="pager-nav">
      <button type="button" class="icon-button pager-button" data-cost-history-page="${Math.max(1, data.page - 1)}" ${data.page <= 1 ? 'disabled' : ''}>&lsaquo;</button>
      ${pageNumbers(data.page, pages).map((value) => value === 'ellipsis'
        ? '<span class="pager-ellipsis">…</span>'
        : `<button type="button" class="page-number ${value === data.page ? 'active' : ''}" data-cost-history-page="${value}" ${value === data.page ? 'aria-current="page"' : ''}>${value}</button>`).join('')}
      <button type="button" class="icon-button pager-button" data-cost-history-page="${Math.min(pages, data.page + 1)}" ${data.page >= pages ? 'disabled' : ''}>&rsaquo;</button>
    </div>
    <span>第 ${data.page} / ${pages} 页</span>
  </div>`;
}

function accountCostFormAccount(account, period) {
  return {
    ...account,
    currentCostPeriodId: period?.id || null,
    currentCostProfileId: period?.costProfileId || null,
    currentOriginalAmount: period?.originalAmount ?? '',
    currentFeeAmount: period?.feeAmount ?? '0',
    currentTaxAmount: period?.taxAmount ?? '0',
    currentEffectiveFrom: period?.effectiveFrom || null,
    currentEffectiveTo: period?.effectiveTo || null,
    currentCostNotes: period?.notes || '',
    supplier: period?.supplier || account.supplier || '',
    purchaseBatch: period?.purchaseBatch || account.purchaseBatch || '',
  };
}

async function openAccountCostHistory(account, profiles, page = 1, pageSize = 10) {
  openContentModal('账号成本明细', '<div class="detail-loading"><span></span>正在读取成本记录</div>', 'cost-history-modal');
  try {
    const data = await api(`/accounts/${account.id}/cost-periods?page=${page}&page_size=${pageSize}`, { range: false });
    const form = document.querySelector('#modal-form');
    form.innerHTML = `
      <div class="cost-history-summary">
        <div><strong>${escapeHtml(account.name)}</strong><span>#${account.id} · ${escapeHtml(account.supplier || '未标记供应商')}</span></div>
        <button type="button" class="button primary" data-cost-history-add>${icon('plus')}新增成本期</button>
      </div>
      ${table([
        { label: '生效期间' }, { label: '供应商/批次' }, { label: '成本模板' },
        { label: '成本 CNY', right: true }, { label: '状态' }, { label: '操作' },
      ], data.items.map((item) => [
        `${dateOnly(item.effectiveFrom)} - ${dateOnly(item.effectiveTo)}`,
        `<span class="primary-text">${escapeHtml(item.supplier)}</span><div class="secondary-text">${escapeHtml(item.purchaseBatch)}</div>`,
        `<span class="tag neutral">${escapeHtml(item.costProfile)}</span>`,
        cny(item.totalCost),
        `<span class="status ${item.status === 'active' ? '' : 'warning'}">${item.hasStarted ? '已生效' : '未生效'}</span>`,
        `<button type="button" class="icon-button table-icon" title="${item.hasStarted ? '更正已生效采购成本' : '编辑未生效采购成本'}" data-cost-history-edit="${item.id}">${icon('settings-2')}</button>`,
      ]), 780)}
      ${accountCostHistoryPager(data)}`;
    form.className = 'modal-content';
    form.querySelector('[data-cost-history-add]')?.addEventListener('click', () => {
      openAccountCostModal(account, profiles, { forceCreate: true }).catch((error) => toast(error.message));
    });
    form.querySelectorAll('[data-cost-history-edit]').forEach((button) => {
      const period = data.items.find((item) => String(item.id) === button.dataset.costHistoryEdit);
      button.addEventListener('click', () => {
        openAccountCostModal(account, profiles, { period }).catch((error) => toast(error.message));
      });
    });
    form.querySelectorAll('[data-cost-history-page]').forEach((button) => {
      button.addEventListener('click', () => openAccountCostHistory(account, profiles, Number(button.dataset.costHistoryPage), pageSize));
    });
    form.querySelector('[data-cost-history-page-size]')?.addEventListener('change', (event) => {
      openAccountCostHistory(account, profiles, 1, Number(event.target.value));
    });
  } catch (error) {
    const form = document.querySelector('#modal-form');
    form.innerHTML = `<div class="empty"><strong>成本记录读取失败</strong><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function ledgerFields(profiles, account, catalog) {
  const profileId = account.costProfileId || '';
  return [
    { name: 'costProfileId', label: '成本模板（可选）', type: 'select', required: false, value: profileId, options: [['', '不使用模板'], ...profiles.map((item) => [item.id, item.name])] },
    { name: 'costMode', label: '账号成本方式', type: 'select', value: ['probe_multiplier', 'manual_multiplier', 'fixed_purchase', 'free'].includes(account.costMode || account.costType) ? (account.costMode || account.costType) : 'fixed_purchase', options: [['fixed_purchase', '固定采购成本（自有账号）'], ['probe_multiplier', 'Sub2API 密钥自动倍率'], ['manual_multiplier', '手动填写上游倍率'], ['free', '免费资源']] },
    { type: 'notice', hook: 'account-cost-mode-hint' },
    { name: 'supplierKeyId', label: '采购批次（Sub2API 密钥）', type: 'select', required: false, value: account.supplierKeyId || '', options: catalogSupplierKeyOptions(catalog, account) },
    { name: 'basisMode', label: '倍率计价基础', type: 'select', value: account.basisMode || 'revenue_backsolve', options: [['revenue_backsolve', '按实际消费记录回推（推荐）'], ['reference_cny', '目录价乘 CNY 基准']] },
    { name: 'upstreamMultiplier', label: '上游进货倍率', type: 'number', required: false, value: (account.costMode || account.costType) === 'manual_multiplier' ? account.upstreamMultiplier || '' : '' },
    { name: 'cnyPerReferenceUnit', label: '每 USD 目录价 CNY 基准', type: 'number', required: false, value: account.cnyPerReferenceUnit || '' },
    { name: 'changeStrategy', label: '本次规则生效', type: 'select', value: 'future_only', options: [['future_only', '后续用量生效'], ['current_day', '从今天 0 点重算']] },
    { name: 'supplier', label: '供应商', type: 'select', required: false, value: account.supplier || '', options: catalogSupplierOptions(catalog, account.supplier || '') },
    { name: 'purchaseBatch', label: '采购批次', type: 'select', required: false, value: account.purchaseBatch || '', options: catalogPurchaseBatchOptions(catalog, account.supplier || '', account.purchaseBatch || '', { allowNew: false }) },
    { name: 'tags', label: '账号标签（逗号分隔）', required: false, full: true, value: account.tags?.join(',') || '' },
  ];
}

function accountCostModeHint(mode) {
  return ({
    fixed_purchase: '固定采购成本按已登记的采购金额和生效期分摊；金额不填在倍率字段里。',
    probe_multiplier: '选择已接入的 Sub2API 供应商密钥；该密钥会自动成为采购批次和供应商统计维度，FinOps 读取权威倍率并按每笔实际消费记录自动计算成本。',
    manual_multiplier: '填写实际进货倍率；销售倍率由 sub2api 每笔消费记录读取，无需在这里配置。',
    free: '该账号不计入上游成本。存在未结束固定成本期时不能切换为免费资源。',
  })[mode] || '请选择该账号实际采用的成本方式。';
}

function syncAccountLedgerForm(form, profiles, { applyProfile = false } = {}) {
  const profile = profiles.find((item) => String(item.id) === String(form.elements.costProfileId?.value || ''));
  if (profile && applyProfile) {
    form.elements.costMode.value = profile.costMode || 'fixed_purchase';
    form.elements.basisMode.value = profile.basisMode || 'revenue_backsolve';
    if (profile.variableMultiplier !== null && profile.variableMultiplier !== undefined) {
      form.elements.upstreamMultiplier.value = profile.variableMultiplier;
    }
    if (profile.cnyPerReferenceUnit !== null && profile.cnyPerReferenceUnit !== undefined) {
      form.elements.cnyPerReferenceUnit.value = profile.cnyPerReferenceUnit;
    }
  }
  const mode = form.elements.costMode.value;
  const multiplierMode = ['probe_multiplier', 'manual_multiplier'].includes(mode);
  const referenceBasis = multiplierMode && form.elements.basisMode.value === 'reference_cny';
  setLedgerFieldVisible(form, 'supplierKeyId', mode === 'probe_multiplier');
  setLedgerFieldVisible(form, 'basisMode', multiplierMode);
  setLedgerFieldVisible(form, 'upstreamMultiplier', mode === 'manual_multiplier');
  setLedgerFieldVisible(form, 'cnyPerReferenceUnit', referenceBasis);
  setLedgerFieldVisible(form, 'changeStrategy', multiplierMode);
  setLedgerFieldVisible(form, 'supplier', mode === 'fixed_purchase' || mode === 'manual_multiplier');
  setLedgerFieldVisible(form, 'purchaseBatch', mode === 'fixed_purchase');
  const hint = form.querySelector('[data-account-cost-mode-hint]');
  if (hint) hint.textContent = accountCostModeHint(mode);
}

function changeStrategyLabel(value) {
  return value === 'current_day' ? '从当天 0 点重算' : '后续用量生效';
}

function accountRuleText(account) {
  if (account.costMode === 'manual_multiplier' || account.costMode === 'probe_multiplier') {
    const upstream = account.upstreamMultiplier ? `上游 ${multiplier(account.upstreamMultiplier)}` : '上游待补';
    return `${costModeLabel(account.costMode)} · ${upstream}`;
  }
  return costModeLabel(account.costMode || account.costType);
}

function accountAutoPricingText(account) {
  if (account.costMode === 'manual_multiplier') return '手动倍率不会被自动探测覆盖';
  if (account.costMode !== 'probe_multiplier') return '当前规则不使用倍率计价';
  const status = probeStatusLabel(account.probeStatus);
  const key = account.supplierKeyName || account.supplierKeyMasked || '';
  if (!account.upstreamMultiplier) return `${status} · ${key || '未关联供应商密钥'} · 等待可用倍率`;
  return `${status} · ${key || multiplierSourceLabel(account.upstreamMultiplierSource)} · ${multiplier(account.upstreamMultiplier)}`;
}

function accountRuleContext(account) {
  return `<div class="cost-rule-context">
    <div><span>当前规则</span><strong>${escapeHtml(accountRuleText(account))}</strong></div>
    <div><span>自动探测 / 手动覆盖</span><strong>${escapeHtml(accountAutoPricingText(account))}</strong></div>
    <div><span>最后变更</span><strong>${dateTime(account.lastCostRuleChangedAt)}${account.lastCostRuleChangedBy ? ` · ${escapeHtml(account.lastCostRuleChangedBy)}` : ''}</strong></div>
    <div><span>已封存至</span><strong>${dateTime(account.archivedThrough)}</strong></div>
  </div>`;
}

function openAccountLedgerModal(account, profiles, catalog) {
  openModal('配置账号成本', ledgerFields(profiles, account, catalog), async (data) => {
    const payload = normalizePurchaseSelection(data);
    payload.tags = data.tags ? data.tags.split(',').map((item) => item.trim()).filter(Boolean) : [];
    if (payload.costMode === 'probe_multiplier') {
      if (!payload.supplierKeyId) throw new Error('请选择用于该账号成本核算的 Sub2API 供应商密钥');
      const selectedKey = (catalog.supplierKeys || []).find((item) => String(item.id) === String(payload.supplierKeyId));
      if (String(account.supplierKeyId || '') !== String(payload.supplierKeyId)) {
        await api(`/supplier-keys/${payload.supplierKeyId}/account-link`, {
          method: 'PATCH',
          range: false,
          body: JSON.stringify({ accountId: Number(account.id), linked: true }),
        });
      }
      payload.supplier = selectedKey?.supplier || account.linkedSupplierName || account.supplier || '';
      payload.purchaseBatch = selectedKey?.purchaseBatch || '';
      payload.basisMode = 'revenue_backsolve';
      payload.cnyPerReferenceUnit = '';
      payload.upstreamMultiplier = '';
    }
    const result = await api(`/accounts/${account.id}`, {
      method: 'PATCH',
      range: false,
      body: JSON.stringify(payload),
    });
    if (payload.costMode !== 'probe_multiplier' && account.supplierKeyId) {
      await api(`/supplier-keys/${account.supplierKeyId}/account-link`, {
        method: 'PATCH',
        range: false,
        body: JSON.stringify({ accountId: Number(account.id), linked: false }),
      });
    }
    return result;
  }, {
    onSaved: async () => {
      closeModal();
      await renderAccounts(state.accountSearch);
    },
  });
  const form = document.querySelector('#modal-form');
  form.insertAdjacentHTML('afterbegin', accountRuleContext(account));
  const actions = form.querySelector('.form-actions');
  actions.insertAdjacentHTML('afterbegin', `
    <button type="button" class="button" data-account-rule-history>${icon('receipt-text')}版本记录</button>
    <button type="button" class="button" data-account-cost-archive>${icon('shield-check')}封存计价</button>`);
  syncAccountLedgerForm(form, profiles);
  bindPurchaseCatalogForm(form, catalog, { allowNewBatch: false });
  form.elements.costMode?.addEventListener('change', () => syncAccountLedgerForm(form, profiles));
  form.elements.basisMode?.addEventListener('change', () => syncAccountLedgerForm(form, profiles));
  form.elements.costProfileId?.addEventListener('change', () => syncAccountLedgerForm(form, profiles, { applyProfile: true }));
  actions.querySelector('[data-account-rule-history]')?.addEventListener('click', () => openAccountCostRuleHistory(account, profiles));
  actions.querySelector('[data-account-cost-archive]')?.addEventListener('click', () => openAccountCostArchiveModal(account, profiles));
}

function accountCostRuleHistoryPager(data) {
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  return `<div class="pager">
    <span>共 ${compact(data.total)} 条版本与封存记录</span>
    <label>每页<select data-cost-rule-page-size>${[10, 20, 50, 100].map((size) => `<option value="${size}" ${size === data.pageSize ? 'selected' : ''}>${size}</option>`).join('')}</select></label>
    <div class="pager-nav">
      <button type="button" class="icon-button pager-button" data-cost-rule-page="${Math.max(1, data.page - 1)}" ${data.page <= 1 ? 'disabled' : ''}>&lsaquo;</button>
      ${pageNumbers(data.page, pages).map((value) => value === 'ellipsis'
        ? '<span class="pager-ellipsis">...</span>'
        : `<button type="button" class="page-number ${value === data.page ? 'active' : ''}" data-cost-rule-page="${value}" ${value === data.page ? 'aria-current="page"' : ''}>${value}</button>`).join('')}
      <button type="button" class="icon-button pager-button" data-cost-rule-page="${Math.min(pages, data.page + 1)}" ${data.page >= pages ? 'disabled' : ''}>&rsaquo;</button>
    </div>
    <span>第 ${data.page} / ${pages} 页</span>
  </div>`;
}

function ruleHistoryValue(item) {
  if (item.type === 'archive') {
    return `封存至 ${dateTime(item.cutoffAt)}<div class="secondary-text">冻结 ${compact(item.usageSnapshotCount)} 条用量快照 / ${compact(item.fixedCostSnapshotCount)} 条固定成本日快照</div>`;
  }
  if (item.type === 'reprice') {
    return `<span class="primary-text">历史更正</span><div class="secondary-text">${dateTime(item.rangeStart)} - ${dateTime(item.rangeEnd)} · ${cny(item.beforeCostCny)} -> ${cny(item.afterCostCny)}</div>`;
  }
  const upstream = item.upstreamMultiplier ? `上游 ${item.upstreamMultiplier}x` : '上游 --';
  return `<span class="primary-text">${escapeHtml(costModeLabel(item.costMode))}</span><div class="secondary-text">${upstream}</div>`;
}

async function openAccountCostRuleHistory(account, profiles, page = 1, pageSize = 10) {
  openContentModal('账号计价版本', '<div class="detail-loading"><span></span>正在读取计价版本</div>', 'cost-history-modal');
  try {
    const data = await api(`/accounts/${account.id}/cost-rules?page=${page}&page_size=${pageSize}`, { range: false });
    const form = document.querySelector('#modal-form');
    form.innerHTML = `
      <div class="cost-history-summary">
        <div><strong>${escapeHtml(account.name)}</strong><span>#${account.id} · ${escapeHtml(accountRuleText(account))}</span></div>
        <div class="table-actions">
          <button type="button" class="button" data-rule-history-edit>${icon('settings-2')}编辑规则</button>
          <button type="button" class="button" data-rule-history-reprice>${icon('refresh-cw')}历史更正</button>
          <button type="button" class="button primary" data-rule-history-archive>${icon('shield-check')}封存计价</button>
        </div>
      </div>
      ${table([
        { label: '时间' }, { label: '版本 / 封存' }, { label: '生效策略' }, { label: '状态' }, { label: '操作人' }, { label: '备注' },
      ], data.items.map((item) => [
        dateTime(item.type === 'archive' ? item.cutoffAt : item.occurredAt),
        ruleHistoryValue(item),
        item.type === 'archive' ? '<span class="secondary-text">已锁定历史快照</span>' : item.type === 'reprice' ? '<span class="secondary-text">显式审计更正</span>' : escapeHtml(changeStrategyLabel(item.changeStrategy)),
        `<span class="status ${item.type === 'archive' || item.type === 'reprice' || item.status === 'active' ? '' : 'warning'}">${item.type === 'archive' ? '已封存' : item.type === 'reprice' ? '已更正' : escapeHtml(item.status)}</span>`,
        escapeHtml(item.actor || '--'),
        escapeHtml(item.notes || '--'),
      ]), 980)}
      ${accountCostRuleHistoryPager(data)}`;
    form.className = 'modal-content';
    form.querySelector('[data-rule-history-edit]')?.addEventListener('click', () => {
      loadPurchaseCatalog()
        .then((catalog) => openAccountLedgerModal(account, profiles, catalog))
        .catch((error) => toast(error.message));
    });
    form.querySelector('[data-rule-history-reprice]')?.addEventListener('click', () => openAccountCostRepriceModal(account));
    form.querySelector('[data-rule-history-archive]')?.addEventListener('click', () => openAccountCostArchiveModal(account, profiles));
    form.querySelectorAll('[data-cost-rule-page]').forEach((button) => {
      button.addEventListener('click', () => openAccountCostRuleHistory(account, profiles, Number(button.dataset.costRulePage), pageSize));
    });
    form.querySelector('[data-cost-rule-page-size]')?.addEventListener('change', (event) => {
      openAccountCostRuleHistory(account, profiles, 1, Number(event.target.value));
    });
  } catch (error) {
    const form = document.querySelector('#modal-form');
    form.innerHTML = `<div class="empty"><strong>计价版本读取失败</strong><p>${escapeHtml(error.message)}</p></div>`;
  }
}

function openAccountCostArchiveModal(account) {
  openModal('封存账号计价', [
    { name: 'cutoffAt', label: '封存截止时间', type: 'datetime-local', value: dateTimeInputValue(new Date()) },
    { name: 'notes', label: '封存备注', type: 'textarea', full: true, required: false },
  ], (data) => api(`/accounts/${account.id}/cost-archive`, {
    method: 'POST',
    range: false,
    body: JSON.stringify(data),
  }));
}

function openAccountCostRepriceModal(account) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const costMode = ['manual_multiplier', 'probe_multiplier', 'free'].includes(account.costMode)
    ? account.costMode
    : 'manual_multiplier';
  openModal('历史成本更正', [
    { name: 'effectiveFrom', label: '更正开始时间', type: 'datetime-local', value: dateTimeInputValue(start) },
    { name: 'effectiveTo', label: '更正结束时间', type: 'datetime-local', value: dateTimeInputValue(new Date()) },
    { name: 'costMode', label: '核算模式', type: 'select', value: costMode, options: [['manual_multiplier', '手动上游倍率'], ['probe_multiplier', '使用已确认探测倍率'], ['free', '免费资源']] },
    { name: 'basisMode', label: '倍率成本基础', type: 'select', value: account.basisMode || 'revenue_backsolve', options: [['revenue_backsolve', '实际扣款按消费记录倍率回推'], ['reference_cny', '目录价乘 CNY 基准']] },
    { name: 'upstreamMultiplier', label: '确认上游倍率', type: 'number', required: false, value: account.upstreamMultiplier || '' },
    { name: 'cnyPerReferenceUnit', label: '每 USD 目录价 CNY 基准', type: 'number', required: false, value: account.cnyPerReferenceUnit || '' },
    { name: 'notes', label: '更正原因', type: 'textarea', full: true, required: true },
  ], (data) => api(`/accounts/${account.id}/cost-reprice`, {
    method: 'POST',
    range: false,
    body: JSON.stringify(data),
  }));
}

async function openAccountCostModal(account, profiles, { period = null, forceCreate = false } = {}) {
  const catalog = await loadPurchaseCatalog();
  const editing = Boolean(period);
  const formAccount = editing ? accountCostFormAccount(account, period) : forceCreate ? accountCostFormAccount(account, null) : account;
  openModal(editing ? (period.hasStarted ? '更正已生效采购成本' : '编辑未生效采购成本') : '登记账号成本',
    costFields(profiles, formAccount, { correction: Boolean(period?.hasStarted), catalog }), async (data) => {
    const payload = normalizeCostPayload(data);
    if (editing) {
      await api(`/account-cost-periods/${period.id}`, {
        method: 'PATCH', range: false, body: JSON.stringify(payload),
      });
    } else {
      await api('/account-cost-periods', {
        method: 'POST', range: false, body: JSON.stringify({ ...payload, accountId: account.id }),
      });
    }
  }, {
    onSaved: async () => {
      await openAccountCostHistory(account, profiles);
      void renderAccounts(state.accountSearch);
    },
  });
  bindPurchaseCatalogForm(document.querySelector('#modal-form'), catalog);
}

async function openBulkCostModal(profiles) {
  const accountIds = [...state.selectedAccounts];
  if (!accountIds.length) return toast('请先选择账号');
  const catalog = await loadPurchaseCatalog();
  openModal(`批量登记成本（${accountIds.length} 个账号）`, costFields(profiles, null, { batch: true, catalog }), (data) => api('/account-cost-periods/bulk', {
    method: 'POST', range: false, body: JSON.stringify({ ...normalizeCostPayload(data), accountIds }),
  }).then(() => { state.selectedAccounts.clear(); }));
  bindPurchaseCatalogForm(document.querySelector('#modal-form'), catalog);
}

function openCostProfileModal() {
  openModal('新建成本模板', [
    { name: 'name', label: '模板名称' },
    { name: 'costType', label: '成本类型', type: 'select', options: [['subscription', '固定订阅'], ['metered', '按量后付费'], ['prepaid', '预付余额'], ['one_time', '一次性购买'], ['free', '免费资源'], ['hybrid', '混合成本']] },
    { name: 'costMode', label: '核算模式', type: 'select', options: [['fixed_purchase', '固定采购成本'], ['probe_multiplier', '自动读取上游探测倍率'], ['manual_multiplier', '手动上游倍率'], ['free', '免费资源']] },
    { name: 'basisMode', label: '倍率成本基础', type: 'select', options: [['revenue_backsolve', '实际扣款按消费记录倍率回推'], ['reference_cny', '目录价乘 CNY 基准']] },
    { name: 'variableMultiplier', label: '默认手动上游倍率', type: 'number', required: false },
    { name: 'cnyPerReferenceUnit', label: '每 USD 目录价 CNY 基准', type: 'number', required: false },
    { name: 'allocationMethod', label: '分摊方法', type: 'select', options: [['standard_cost_weight', '标准目录价权重'], ['token_weight', 'Token 权重'], ['none', '不分摊']] },
    { name: 'notes', label: '备注', type: 'textarea', full: true, required: false },
  ], (data) => api('/cost-profiles', { method: 'POST', range: false, body: JSON.stringify({ ...data, currency: 'CNY' }) }));
}

function exportCsv() {
  if (!state.lastExport.length) return toast('当前页面没有可导出数据');
  const keys = Object.keys(state.lastExport[0]);
  const rows = [keys.join(','), ...state.lastExport.map((item) => keys.map((key) => `"${String(item[key] ?? '').replaceAll('"', '""')}"`).join(','))];
  const blob = new Blob([`\ufeff${rows.join('\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `finops-${state.page}-${dateInputValue()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function setRefreshState(active) {
  [refreshButton, sidebarRefresh].forEach((button) => {
    if (!button) return;
    button.disabled = active;
    button.classList.toggle('is-spinning', active);
  });
}

document.querySelector('#nav').addEventListener('click', (event) => {
  const button = event.target.closest('.nav-item');
  if (!button) return;
  state.page = button.dataset.page;
  document.querySelector('#sidebar').classList.remove('open');
  document.querySelector('#drawer-backdrop').classList.remove('show');
  render();
});

rangeSelect?.addEventListener('change', (event) => setRange(event.target.value));
rangeTabs?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-range]');
  if (button) setRange(button.dataset.range);
});
rangeApply?.addEventListener('click', applyCustomRange);

content.addEventListener('click', (event) => {
  const previous = event.target.closest('[data-page-prev]');
  const next = event.target.closest('[data-page-next]');
  const pageTarget = event.target.closest('[data-page-to]');
  const overviewDetails = event.target.closest('[data-open-overview-detail]');
  const usageView = event.target.closest('[data-usage-view]');
  const userDetails = event.target.closest('[data-user-details]');
  const userSort = event.target.closest('[data-user-sort]');
  const accountScope = event.target.closest('[data-account-scope]');
  const ledgerEdit = event.target.closest('[data-edit-ledger]');
  const accountRuleHistory = event.target.closest('[data-account-rule-history]');
  const accountCostHistory = event.target.closest('[data-account-cost-history]');
  if (overviewDetails) {
    openOverviewDetails(overviewDetails.dataset.openOverviewDetail);
    return;
  }
  if (usageView) {
    const view = usageView.dataset.usageView === 'models' ? 'models' : 'events';
    if (view !== state.usageView) {
      state.usageView = view;
      state.usageSearch = '';
      window.localStorage.setItem('finops.usage-view', view);
      tableState('usageEvents').page = 1;
      tableState('usageModels').page = 1;
      renderUsage();
    }
    return;
  }
  if (userDetails) {
    openUserDetails(userDetails.dataset.userDetails);
    return;
  }
  if (userSort) {
    const sort = userSort.dataset.userSort;
    if (state.userSort === sort) state.userSortDirection = state.userSortDirection === 'desc' ? 'asc' : 'desc';
    else {
      state.userSort = sort;
      state.userSortDirection = 'desc';
    }
    tableState('usersSearch').page = 1;
    renderUsersEnhanced();
    return;
  }
  if (accountScope) {
    state.accountScope = accountScope.dataset.accountScope;
    state.selectedAccounts.clear();
    tableState('accountsSearch').page = 1;
    renderAccounts();
    return;
  }
  if (previous || next || pageTarget) {
    const key = previous?.dataset.pagePrev || next?.dataset.pageNext || pageTarget?.dataset.pageTo;
    const current = tableState(key);
    current.page = pageTarget
      ? Number(pageTarget.dataset.pageNumber)
      : Math.max(1, current.page + (next ? 1 : -1));
    render();
    return;
  }
  if (ledgerEdit || accountRuleHistory || accountCostHistory) {
    const accountId = ledgerEdit?.dataset.editLedger
      || accountRuleHistory?.dataset.accountRuleHistory
      || accountCostHistory?.dataset.accountCostHistory;
    const account = state.accountItems.get(accountId);
    if (!account) return;
    Promise.all([api('/cost-profiles', { range: false }), loadPurchaseCatalog()]).then(([profiles, catalog]) => {
      if (ledgerEdit) openAccountLedgerModal(account, profiles, catalog);
      else if (accountRuleHistory) openAccountCostRuleHistory(account, profiles);
      else openAccountCostHistory(account, profiles);
    }).catch((error) => toast(error.message));
  }
});

content.addEventListener('change', (event) => {
  const sizeSelect = event.target.closest('[data-page-size]');
  const accountSelect = event.target.closest('[data-account-select]');
  const overviewMask = event.target.closest('[data-overview-mask]');
  if (overviewMask) {
    state.overviewAccountMasked = overviewMask.checked;
    window.localStorage.setItem('finops.overview-account-masked', String(state.overviewAccountMasked));
    renderOverview();
    return;
  }
  if (sizeSelect) {
    const current = tableState(sizeSelect.dataset.pageSize);
    current.pageSize = Number(sizeSelect.value);
    current.page = 1;
    render();
    return;
  }
  if (accountSelect) {
    const accountId = Number(accountSelect.dataset.accountSelect);
    if (accountSelect.checked) state.selectedAccounts.add(accountId); else state.selectedAccounts.delete(accountId);
    const count = document.querySelector('#selection-count');
    const button = document.querySelector('#batch-cost-button');
    if (count) count.textContent = `已选择 ${state.selectedAccounts.size} 个`;
    if (button) button.disabled = !state.selectedAccounts.size;
  }
});

const refresh = async () => {
  setRefreshState(true);
  try {
    await render();
    applySyncState(await api('/sync-state', { range: false }));
  } finally {
    setRefreshState(false);
  }
};

refreshButton?.addEventListener('click', refresh);
sidebarRefresh?.addEventListener('click', refresh);
document.querySelector('#export-button').addEventListener('click', exportCsv);
document.querySelector('#modal-close').addEventListener('click', closeModal);
document.querySelector('#modal-backdrop').addEventListener('click', (event) => {
  if (event.target.id === 'modal-backdrop') closeModal();
});
document.querySelector('#menu-button').addEventListener('click', () => {
  document.querySelector('#sidebar').classList.add('open');
  document.querySelector('#drawer-backdrop').classList.add('show');
});
document.querySelector('#drawer-backdrop').addEventListener('click', () => {
  document.querySelector('#sidebar').classList.remove('open');
  document.querySelector('#drawer-backdrop').classList.remove('show');
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  closeModal();
  document.querySelector('#sidebar').classList.remove('open');
  document.querySelector('#drawer-backdrop').classList.remove('show');
});
window.addEventListener('resize', () => {
  if (state.page === 'overview' && state.overviewTrend) {
    drawTrendWithTooltip(
      document.querySelector('#trend-chart'),
      state.overviewTrend.items.map((item) => ({ ...item, consumptionCny: item.userChargeCny })),
      { rechargeEvents: state.overviewTrend.rechargeEvents, title: '经营趋势' },
    );
  }
  if (state.userDetail?.data) drawUserDetailTrend(state.userDetail.data.trend);
});

async function bootstrap() {
  state.bootstrap = await api('/bootstrap', { range: false });
  const badge = document.querySelector('#mode-badge');
  badge.textContent = state.bootstrap.mode === 'demo' ? '演示数据' : '实时数据';
  badge.className = `mode-badge ${state.bootstrap.mode}`;
  applySyncState(await api('/sync-state', { range: false }));
  await render();
}

bootstrap().catch((error) => {
  content.innerHTML = `<div class="empty"><strong>无法启动工作台</strong><p>${escapeHtml(error.message)}</p></div>`;
});
