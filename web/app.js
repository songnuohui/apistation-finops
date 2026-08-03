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
  overviewTrend: null,
  overviewMetrics: null,
  overviewAccountMasked: window.localStorage.getItem('finops.overview-account-masked') === 'true',
  userDetail: null,
  overviewDetail: null,
  runtimeRefreshTimer: null,
};

const pageMeta = {
  overview: ['经营总览', '实收现金、用户实际消费、账号成本与经营毛利'],
  users: ['用户账务与利润', '充值、人工调账、实际消费和用户贡献'],
  accounts: ['账号台账与成本', '账号采购、成本归属、实际消费与毛利'],
  usage: ['用量与扣费', '按 sub2api 实际扣费口径查看模型消费'],
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

function dashboardRankList(items, { value, detail }) {
  if (!items.length) return '<div class="dashboard-rank-empty">当前周期暂无数据</div>';
  return items.map((item, index) => {
    const secondary = item.username && item.username !== item.email
      ? `<small>${escapeHtml(state.overviewAccountMasked ? maskedIdentity(item.username) : item.username)}</small>`
      : '';
    return `<div class="dashboard-rank-item">
      <span class="dashboard-rank-index">${index + 1}</span>
      <div class="dashboard-rank-user"><strong>${escapeHtml(overviewIdentity(item))}</strong>${secondary}</div>
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

async function renderOverview() {
  const [dashboard, trendData, modelData] = await Promise.all([
    api('/overview-dashboard'), api('/trend'), api(`/usage/models?${queryFor('overviewModels')}`),
  ]);
  const summary = dashboard.summary;
  const operations = summary.operations;
  const cash = summary.cash;
  const netRecharge = Number(cash.rechargeReceived || 0) - Number(cash.refunds || 0);
  const totalTokens = Number(summary.usage.inputTokens || 0)
    + Number(summary.usage.outputTokens || 0)
    + Number(summary.usage.cacheTokens || 0);
  state.overviewMetrics = {
    consumptionCny: Number(operations.consumptionCny ?? operations.userChargeCny ?? 0),
    requests: Number(summary.usage.requests || 0),
    totalTokens,
    balanceCny: Number(dashboard.totals.balanceCny || 0),
    balanceUserCount: Number(dashboard.totals.balanceUserCount || 0),
  };
  state.lastExport = [
    ...dashboard.rankings.requestActivity.map((item) => ({ ranking: '请求活跃度', ...item })),
    ...dashboard.rankings.tokenUsage.map((item) => ({ ranking: 'Token 使用排行', ...item })),
    ...dashboard.rankings.cashRecharge.map((item) => ({ ranking: '用户充值排行', ...item })),
  ];
  content.innerHTML = `<div class="dashboard-meta"><span>运营看板</span><small>更新于 ${dateTime(dashboard.generatedAt)}</small></div>
    <div class="dashboard-metric-grid">
      ${metricAction('充值净额', cny(netRecharge), `充值实收 ${cny(cash.rechargeReceived)} · 已退款 ${cny(cash.refunds)} · 查看明细`, netRecharge >= 0 ? 'good' : 'bad', 'data-open-overview-detail="recharge"')}
      ${metricAction('非现金余额入账', cny(dashboard.totals.nonCashBalanceCreditCny), `${compact(dashboard.totals.nonCashBalanceCreditCount)} 笔管理员加款、兑换等入账 · 查看明细`, '', 'data-open-overview-detail="non-cash"')}
      ${metricAction('总消耗', cny(operations.consumptionCny ?? operations.userChargeCny), `${compact(summary.usage.requests)} 次请求 · 查看明细`, 'good', 'data-open-overview-detail="consumption"')}
      ${metricAction('剩余余额', cny(dashboard.totals.balanceCny), `${compact(dashboard.totals.balanceUserCount)} 位余额用户 · 查看明细`, '', 'data-open-overview-detail="balance"')}
      ${metricAction('总 Token', compact(totalTokens), '输入、输出与缓存合计 · 查看明细', '', 'data-open-overview-detail="tokens"')}
    </div>
    <div class="overview-ranking-grid">
      <section class="panel dashboard-rank-panel">
        <div class="panel-header"><h2>请求活跃度</h2><span>${compact(summary.usage.activeUsers)} 位活跃用户</span></div>
        <div class="dashboard-rank-list">${
          dashboardRankList(dashboard.rankings.requestActivity, {
            value: (item) => `${compact(item.requests)} 次`,
            detail: (item) => `${compact(item.tokens)} Token`,
          })
        }</div>
      </section>
      <section class="panel dashboard-rank-panel">
        <div class="panel-header">
          <h2>Token 使用排行</h2>
          <label class="visibility-toggle"><input type="checkbox" data-overview-mask ${state.overviewAccountMasked ? 'checked' : ''}><span>隐藏账号</span></label>
        </div>
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
      <section class="panel"><div class="panel-header"><h2>待处理事项</h2><span>${summary.alerts.length} 项</span></div><div class="alert-list">${
        summary.alerts.length ? summary.alerts.map((alert) => `<div class="alert ${alert.severity}"><span class="alert-dot"></span><div><strong>${escapeHtml(alert.title)}</strong><p>${escapeHtml(alert.detail)}</p></div></div>`).join('') : '<div class="empty">没有待处理事项</div>'
      }</div></section>
    </div>
    <section class="table-panel"><div class="panel-header"><h2>模型单位经济性</h2><span>实际消费与已登记成本</span></div>${
      table([
        { label: '模型' }, { label: '请求', right: true }, { label: 'Token', right: true }, { label: '标准牌价 USD', right: true },
        { label: '用户实际消费 CNY', right: true }, { label: '已登记成本 CNY', right: true }, { label: '经营毛利 CNY', right: true }, { label: '成本覆盖' },
      ], modelData.items.map((item) => [
        `<span class="primary-text">${escapeHtml(item.name)}</span>`, compact(item.requests), compact(item.tokens), usd(item.tokenListValueUsd),
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
  'non-cash': { title: '非现金余额入账明细', loading: '正在读取非现金余额入账', error: '非现金余额入账读取失败', label: '笔余额入账' },
  consumption: { title: '总消耗明细', loading: '正在读取模型消耗明细', error: '模型消耗明细读取失败', label: '个模型' },
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

function bindOverviewDetailControls() {
  const form = document.querySelector('#modal-form');
  form.onclick = async (event) => {
    const button = event.target.closest('[data-overview-detail-page]');
    if (!button || button.disabled || !state.overviewDetail) return;
    state.overviewDetail.page = Number(button.dataset.overviewDetailPage);
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

function renderNonCashBalanceCreditDetailModal(data) {
  const summary = data.summary || {};
  openContentModal('非现金余额入账明细', `
    <div class="detail-filter">
      <span class="detail-range-note">包含管理员加款、兑换等实际余额入账；不包含邀请返利额度等不进入用户余额的额度记录。</span>
    </div>
    <div class="detail-metrics">
      ${metric('非现金余额入账', cny(summary.amountCny), `${compact(summary.events)} 笔实际余额入账`, 'good')}
    </div>
    <section class="detail-section">
      <div class="detail-section-header"><h3>非现金余额入账记录</h3><span>按发生时间倒序</span></div>
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
      ${overviewDetailPager(data, overviewDetailMeta['non-cash'].label)}
    </section>
  `, 'cash-detail-modal overview-detail-modal');
  bindOverviewDetailControls();
}

function renderUsageOverviewDetailModal(data) {
  const detail = state.overviewDetail;
  const metrics = detail?.metrics || {};
  const isTokenDetail = detail?.type === 'tokens';
  const titleText = isTokenDetail ? '总 Token 明细' : '总消耗明细';
  openContentModal(titleText, `
    <div class="detail-filter">
      <span class="detail-range-note">按模型汇总 sub2api 实际扣费记录；Token 包含输入、输出与缓存 Token。</span>
    </div>
    <div class="detail-metrics">
      ${metric('总消耗', cny(metrics.consumptionCny), `${compact(metrics.requests)} 次请求`, 'good')}
      ${metric('总 Token', compact(metrics.totalTokens), '输入、输出与缓存合计')}
      ${metric('模型数', compact(data.total), '当前统计周期内有调用的模型')}
    </div>
    <section class="detail-section">
      <div class="detail-section-header"><h3>${isTokenDetail ? '模型 Token 汇总' : '模型消耗汇总'}</h3><span>按实际消费金额倒序</span></div>
      ${table([
        { label: '模型' }, { label: '请求', right: true }, { label: 'Token', right: true }, { label: '实际消费 CNY', right: true },
        { label: '已登记成本 CNY', right: true }, { label: '经营毛利 CNY', right: true }, { label: '成本覆盖' },
      ], data.items.map((item) => [
        `<span class="primary-text">${escapeHtml(item.name)}</span>`, compact(item.requests), compact(item.tokens), cny(item.userChargeCny),
        cny(item.bookedCostCny), `<span class="${profitClass(item.bookedProfitCny)}">${cny(item.bookedProfitCny)}</span>`, costCoverage(item),
      ]), 1080)}
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
  else if (type === 'non-cash') renderNonCashBalanceCreditDetailModal(data);
  else if (type === 'consumption' || type === 'tokens') renderUsageOverviewDetailModal(data);
  else if (type === 'balance') renderBalanceDetailModal(data);
}

function overviewDetailPath(detail) {
  const paging = `page=${detail.page}&page_size=${detail.pageSize}`;
  if (detail.type === 'recharge') return `/funds?scope=recharge&${paging}`;
  if (detail.type === 'non-cash') return `/non-cash-balance-credits?${paging}`;
  if (detail.type === 'consumption' || detail.type === 'tokens') return `/usage/models?${paging}`;
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
  document.querySelector('#user-exclude-balance')?.addEventListener('click', () => updateWhitelist(true));
  document.querySelector('#user-include-balance')?.addEventListener('click', () => updateWhitelist(false));
}

function accountActionButtons(item) {
  return `<div class="table-actions table-row-actions">
    <button type="button" class="icon-button table-icon" title="编辑账号台账" data-edit-ledger="${item.id}">${icon('settings-2')}</button>
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
        { label: '核算规则' }, { label: '固定成本期/倍率' }, { label: '实际消费 CNY', right: true }, { label: '已登记成本 CNY', right: true },
        { label: '经营毛利 CNY', right: true }, { label: '成本覆盖' }, { label: '编辑' },
      ], data.items.map((item) => [
        `<input type="checkbox" data-account-select="${item.id}" ${state.selectedAccounts.has(Number(item.id)) ? 'checked' : ''}>`,
        `<span class="primary-text">${escapeHtml(item.name)}</span><div class="secondary-text">#${item.id} · ${tags(item.tags)} ${accountLifecycle(item)}</div>`,
        `<span class="primary-text">${escapeHtml(item.platform)}</span><div class="secondary-text">${escapeHtml(item.supplier || '未标记供应商')}</div>`,
        `<span class="tag neutral">${escapeHtml(costModeLabel(item.costMode || item.costType))}</span><div class="secondary-text">${
          item.probeStatus ? `探测 ${escapeHtml(item.probeStatus)}` : item.upstreamMultiplier ? `上游 ${item.upstreamMultiplier}x` : ''
        }</div>`,
        item.currentCostPeriodId ? `${dateOnly(item.currentEffectiveFrom)}<div class="secondary-text">${cny(item.currentOriginalAmount)} + 费税 ${cny(Number(item.currentFeeAmount) + Number(item.currentTaxAmount))}</div>`
          : item.upstreamMultiplier ? `<span class="primary-text">上游 ${item.upstreamMultiplier}x</span><div class="secondary-text">销售 ${item.sellingMultiplier || '--'}x</div>`
          : '<span class="secondary-text">未登记</span>',
        cny(item.userChargeCny), cny(item.bookedCostCny), `<span class="${profitClass(item.bookedProfitCny)}">${cny(item.bookedProfitCny)}</span>`, costCoverage(item), accountActionButtons(item),
      ]), 1330)
    }${pager(data, 'accountsSearch', '个账号')}</section>`;
  bindSearch(renderAccounts);
  document.querySelector('#account-cost-button')?.addEventListener('click', () => openSingleCostModal(data.items, profiles));
  document.querySelector('#batch-cost-button')?.addEventListener('click', () => openBulkCostModal(profiles));
  document.querySelector('#select-current-accounts')?.addEventListener('change', (event) => {
    data.items.forEach((item) => {
      if (event.target.checked) state.selectedAccounts.add(Number(item.id));
      else state.selectedAccounts.delete(Number(item.id));
    });
    renderAccounts(search);
  });
}

async function renderUsage() {
  const data = await api(`/usage/models?${queryFor('usageModels')}`);
  state.lastExport = data.items;
  content.innerHTML = `${section('模型与 Token', '标准牌价 USD 仅作上游参考，经营收入使用实际扣费 CNY')}
    <section class="table-panel">${table([
      { label: '模型' }, { label: '请求', right: true }, { label: 'Token', right: true }, { label: '标准牌价 USD', right: true },
      { label: '实际消费 CNY', right: true }, { label: '已登记成本 CNY', right: true }, { label: '经营毛利 CNY', right: true }, { label: '成本覆盖' },
    ], data.items.map((item) => [
      `<span class="primary-text">${escapeHtml(item.name)}</span>`, compact(item.requests), compact(item.tokens), usd(item.tokenListValueUsd),
      cny(item.userChargeCny), cny(item.bookedCostCny), `<span class="${profitClass(item.bookedProfitCny)}">${cny(item.bookedProfitCny)}</span>`, costCoverage(item),
    ]), 1190)}${pager(data, 'usageModels', '个模型')}</section>`;
}

async function renderSuppliers(search = '') {
  const [source, profiles, accountData] = await Promise.all([
    api(`/suppliers?search=${encodeURIComponent(search)}`),
    api('/cost-profiles', { range: false }),
    api(`/accounts?${queryFor('supplierAccounts', search)}`),
  ]);
  const suppliers = localPage(source.items, 'suppliersList');
  const purchases = localPage(source.purchases, 'purchasesList');
  const summary = source.summary || {};
  state.lastExport = suppliers.items;
  content.innerHTML = `${section('供应商经营概览', '供应商成本按照账号采购记录汇总')}
    <div class="metric-grid">
      ${metric('供应商', compact(summary.supplierCount), '当前筛选范围')}
      ${metric('关联账号', compact(summary.accountCount), '已归集账号')}
      ${metric('期间采购', cny(summary.purchaseSpend), '含手续费与税费', 'warn')}
      ${metric('经营毛利', cny(summary.grossProfit), '实际消费减已登记成本', Number(summary.grossProfit) >= 0 ? 'good' : 'bad')}
      ${metric('待补成本账号', compact(summary.unbookedAccountCount), '有用量但无成本期间', Number(summary.unbookedAccountCount) ? 'warn' : 'good')}
    </div>
    ${section('供应商核算', '按供应商归集用量、成本和毛利')}
    <section class="table-panel">${searchTools('搜索供应商、平台、账号或采购批次', `<button type="button" class="button primary" id="supplier-cost-button">${icon('plus')}登记成本</button>`, search)}${
      table([
        { label: '供应商' }, { label: '平台' }, { label: '账号', right: true }, { label: '实际消费 CNY', right: true },
        { label: '采购分摊 CNY', right: true }, { label: '已登记成本 CNY', right: true }, { label: '经营毛利 CNY', right: true }, { label: '成本覆盖' },
      ], suppliers.items.map((item) => [
        `<span class="primary-text">${escapeHtml(item.supplier)}</span><div class="secondary-text">${item.missingRuleCount ? `${item.missingRuleCount} 个账号缺成本规则` : '成本规则完整'}</div>`,
        tags(item.platforms), compact(item.accountCount), cny(item.userChargeCny), cny(item.purchaseAllocatedCostCny), cny(item.bookedCostCny),
        `<span class="${profitClass(item.bookedProfitCny)}">${cny(item.bookedProfitCny)}</span>`, costCoverage(item),
      ]), 1080)
    }${pager(suppliers, 'suppliersList', '个供应商')}</section>
    ${section('采购批次', '账号采购成本、生效期和供应商归属')}
    <section class="table-panel">${table([
      { label: '账号' }, { label: '供应商/批次' }, { label: '成本模板' }, { label: '含税费 CNY', right: true }, { label: '生效期' }, { label: '状态' },
    ], purchases.items.map((item) => [
      `<span class="primary-text">${escapeHtml(item.accountName)}</span><div class="secondary-text">#${item.accountId}</div>`,
      `<span class="primary-text">${escapeHtml(item.supplier)}</span><div class="secondary-text">${escapeHtml(item.purchaseBatch)}</div>`,
      `<span class="tag neutral">${escapeHtml(item.costProfile)}</span>`, cny(item.totalCost),
      `${dateOnly(item.effectiveFrom)} - ${dateOnly(item.effectiveTo)}`, `<span class="status ${item.status === 'active' ? '' : 'warning'}">${escapeHtml(item.status)}</span>`,
    ]), 920)}${pager(purchases, 'purchasesList', '个采购批次')}</section>`;
  bindSearch(renderSuppliers);
  document.querySelector('#supplier-cost-button')?.addEventListener('click', () => openSingleCostModal(accountData.items, profiles));
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
        item.costMode === 'manual_multiplier' ? `${item.variableMultiplier || '--'}x`
          : item.basisMode === 'reference_cny' ? cny(item.cnyPerReferenceUnit) : item.defaultSellingMultiplier ? `销售 ${item.defaultSellingMultiplier}x` : '--',
        escapeHtml(item.allocationMethod), compact(item.accountCount),
      ]), 960)
    }${pager(data, 'costProfiles', '个模板')}</section>`;
  bindSearch(renderCosts);
  document.querySelector('#profile-button')?.addEventListener('click', openCostProfileModal);
}

async function renderRuntime() {
  const data = await api('/runtime?refresh=1', { range: false });
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
    if (state.page === 'runtime') {
      state.runtimeRefreshTimer = setTimeout(() => {
        if (state.page === 'runtime') render();
      }, 10_000);
    }
  } catch (error) {
    content.innerHTML = `<div class="empty"><strong>数据读取失败</strong><p>${escapeHtml(error.message)}</p><button class="button" id="retry">重新加载</button></div>`;
    document.querySelector('#retry')?.addEventListener('click', render);
  }
}

function modalControl(field) {
  const required = field.required === false ? '' : 'required';
  if (field.type === 'select') {
    return `<select name="${escapeHtml(field.name)}" ${required}>${field.options.map(([value, label]) => `<option value="${escapeHtml(value)}" ${String(value) === String(field.value ?? '') ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>`;
  }
  if (field.type === 'textarea') {
    return `<textarea name="${escapeHtml(field.name)}" ${required}>${escapeHtml(field.value ?? '')}</textarea>`;
  }
  return `<input type="${field.type || 'text'}" name="${escapeHtml(field.name)}" ${required} ${field.type === 'number' ? 'step="any"' : ''} value="${escapeHtml(field.value ?? '')}">`;
}

function openModal(titleText, fields, onSubmit) {
  document.querySelector('.modal').className = 'modal';
  document.querySelector('#modal-title').textContent = titleText;
  const form = document.querySelector('#modal-form');
  form.className = '';
  form.innerHTML = `${fields.map((field) => `<label class="field ${field.full ? 'full' : ''}"><span>${escapeHtml(field.label)}</span>${modalControl(field)}</label>`).join('')}
    <div class="form-actions"><button type="button" class="button" id="form-cancel">取消</button><button type="submit" class="button primary">保存</button></div>`;
  document.querySelector('#modal-backdrop').hidden = false;
  document.querySelector('#form-cancel').onclick = closeModal;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      await onSubmit(data);
      closeModal();
      toast('已保存');
      await render();
    } catch (error) {
      toast(error.message);
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
}

function costFields(profiles, account, { includeAccount = false, batch = false } = {}) {
  const now = new Date();
  const end = new Date(now);
  end.setMonth(end.getMonth() + 1);
  const profileId = account?.currentCostProfileId || account?.costProfileId || '';
  const fixedProfiles = profiles.filter((item) => !item.costMode || item.costMode === 'fixed_purchase');
  return [
    ...(includeAccount ? [{ name: 'accountId', label: '账号', type: 'select', options: account.options, value: account.value }] : []),
    { name: 'costProfileId', label: '固定成本模板', type: 'select', required: false, value: profileId, options: [['', '不使用模板'], ...fixedProfiles.map((item) => [item.id, item.name])] },
    { name: 'originalAmount', label: batch ? '采购批次总成本 CNY' : '成本金额 CNY', type: 'number', value: account?.currentOriginalAmount || '' },
    { name: 'feeAmount', label: '手续费 CNY', type: 'number', required: false, value: account?.currentFeeAmount ?? '0' },
    { name: 'taxAmount', label: '税费 CNY', type: 'number', required: false, value: account?.currentTaxAmount ?? '0' },
    ...(batch ? [{ name: 'allocationStrategy', label: '批次分摊方式', type: 'select', options: [['equal', '账号均分'], ['standard_cost_weight', '目录价权重'], ['token_weight', 'Token 权重']] }] : []),
    { name: 'effectiveFrom', label: '生效时间', type: 'datetime-local', value: dateTimeInputValue(account?.currentEffectiveFrom) || dateTimeInputValue(now) },
    { name: 'effectiveTo', label: '结束时间', type: 'datetime-local', value: dateTimeInputValue(account?.currentEffectiveTo) || dateTimeInputValue(end) },
    { name: 'supplier', label: '供应商', required: false, value: account?.supplier || '' },
    { name: 'purchaseBatch', label: '采购批次', required: false, value: account?.purchaseBatch || '' },
    { name: 'tags', label: '账号标签（逗号分隔）', required: false, value: account?.tags?.join(',') || '' },
    { name: 'notes', label: '备注', type: 'textarea', full: true, required: false, value: account?.currentCostNotes || '' },
  ];
}

function normalizeCostPayload(data) {
  return {
    ...data,
    originalCurrency: 'CNY',
    fxRate: '1',
    baseAmount: data.originalAmount,
    tags: data.tags ? data.tags.split(',').map((item) => item.trim()).filter(Boolean) : [],
  };
}

function openSingleCostModal(accounts, profiles) {
  if (!accounts.length) return toast('当前筛选结果没有可登记成本的账号');
  const picker = { options: accounts.map((item) => [item.id, item.name]), value: accounts[0].id };
  openModal('登记单个账号成本', costFields(profiles, picker, { includeAccount: true }), (data) => api('/account-cost-periods', {
    method: 'POST', range: false, body: JSON.stringify(normalizeCostPayload(data)),
  }));
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
        `<span class="status ${item.status === 'active' ? '' : 'warning'}">${escapeHtml(item.status)}</span>`,
        `<button type="button" class="icon-button table-icon" title="编辑成本期" data-cost-history-edit="${item.id}">${icon('settings-2')}</button>`,
      ]), 780)}
      ${accountCostHistoryPager(data)}`;
    form.className = 'modal-content';
    form.querySelector('[data-cost-history-add]')?.addEventListener('click', () => openAccountCostModal(account, profiles, { forceCreate: true }));
    form.querySelectorAll('[data-cost-history-edit]').forEach((button) => {
      const period = data.items.find((item) => String(item.id) === button.dataset.costHistoryEdit);
      button.addEventListener('click', () => openAccountCostModal(account, profiles, { period }));
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

function ledgerFields(profiles, account) {
  const profileId = account.costProfileId || '';
  return [
    { name: 'costProfileId', label: '成本模板', type: 'select', required: false, value: profileId, options: [['', '不使用模板'], ...profiles.map((item) => [item.id, item.name])] },
    { name: 'costMode', label: '核算模式', type: 'select', value: ['probe_multiplier', 'manual_multiplier', 'fixed_purchase', 'free'].includes(account.costMode || account.costType) ? (account.costMode || account.costType) : 'fixed_purchase', options: [['probe_multiplier', '探测上游倍率'], ['manual_multiplier', '手动上游倍率'], ['fixed_purchase', '固定采购成本'], ['free', '免费资源']] },
    { name: 'basisMode', label: '倍率成本基础', type: 'select', value: account.basisMode || 'revenue_backsolve', options: [['revenue_backsolve', '实际扣款按销售倍率回推'], ['reference_cny', '目录价乘 CNY 基准']] },
    { name: 'upstreamMultiplier', label: '手动上游倍率', type: 'number', required: false, value: (account.costMode || account.costType) === 'manual_multiplier' ? account.upstreamMultiplier || '' : '' },
    { name: 'sellingMultiplier', label: '销售倍率覆盖', type: 'number', required: false, value: account.sellingMultiplier || '' },
    { name: 'cnyPerReferenceUnit', label: '每 USD 目录价 CNY 基准', type: 'number', required: false, value: account.cnyPerReferenceUnit || '' },
    { name: 'changeStrategy', label: '本次计价变更', type: 'select', value: 'future_only', options: [['future_only', '后续用量生效'], ['current_day', '从今天 0 点重算']] },
    { name: 'supplier', label: '供应商', required: false, value: account.supplier || '' },
    { name: 'purchaseBatch', label: '采购批次', required: false, value: account.purchaseBatch || '' },
    { name: 'tags', label: '账号标签（逗号分隔）', required: false, full: true, value: account.tags?.join(',') || '' },
  ];
}

function changeStrategyLabel(value) {
  return value === 'current_day' ? '从当天 0 点重算' : '后续用量生效';
}

function accountRuleText(account) {
  if (account.costMode === 'manual_multiplier' || account.costMode === 'probe_multiplier') {
    const upstream = account.upstreamMultiplier ? `上游 ${account.upstreamMultiplier}x` : '上游待补';
    const selling = account.sellingMultiplier ? `销售 ${account.sellingMultiplier}x` : '销售待补';
    return `${costModeLabel(account.costMode)} · ${upstream} / ${selling}`;
  }
  return costModeLabel(account.costMode || account.costType);
}

function accountRuleContext(account) {
  return `<div class="cost-rule-context">
    <div><span>当前规则</span><strong>${escapeHtml(accountRuleText(account))}</strong></div>
    <div><span>最后变更</span><strong>${dateTime(account.lastCostRuleChangedAt)}${account.lastCostRuleChangedBy ? ` · ${escapeHtml(account.lastCostRuleChangedBy)}` : ''}</strong></div>
    <div><span>已封存至</span><strong>${dateTime(account.archivedThrough)}</strong></div>
  </div>`;
}

function openAccountLedgerModal(account, profiles) {
  openModal('编辑账号台账', ledgerFields(profiles, account), (data) => api(`/accounts/${account.id}`, {
    method: 'PATCH',
    range: false,
    body: JSON.stringify({
      ...data,
      tags: data.tags ? data.tags.split(',').map((item) => item.trim()).filter(Boolean) : [],
    }),
  }));
  const form = document.querySelector('#modal-form');
  form.insertAdjacentHTML('afterbegin', accountRuleContext(account));
  const actions = form.querySelector('.form-actions');
  actions.insertAdjacentHTML('afterbegin', `
    <button type="button" class="button" data-account-rule-history>${icon('receipt-text')}版本记录</button>
    <button type="button" class="button" data-account-cost-archive>${icon('shield-check')}封存计价</button>`);
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
  const selling = item.sellingMultiplier ? `销售 ${item.sellingMultiplier}x` : '销售 --';
  return `<span class="primary-text">${escapeHtml(costModeLabel(item.costMode))}</span><div class="secondary-text">${upstream} · ${selling}</div>`;
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
    form.querySelector('[data-rule-history-edit]')?.addEventListener('click', () => openAccountLedgerModal(account, profiles));
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
    { name: 'costMode', label: '核算模式', type: 'select', value: costMode, options: [['manual_multiplier', '手动上游倍率'], ['probe_multiplier', '已确认探测倍率'], ['free', '免费资源']] },
    { name: 'basisMode', label: '倍率成本基础', type: 'select', value: account.basisMode || 'revenue_backsolve', options: [['revenue_backsolve', '实际扣款按销售倍率回推'], ['reference_cny', '目录价乘 CNY 基准']] },
    { name: 'upstreamMultiplier', label: '确认上游倍率', type: 'number', required: false, value: account.upstreamMultiplier || '' },
    { name: 'sellingMultiplier', label: '确认销售倍率', type: 'number', required: false, value: account.sellingMultiplier || '' },
    { name: 'cnyPerReferenceUnit', label: '每 USD 目录价 CNY 基准', type: 'number', required: false, value: account.cnyPerReferenceUnit || '' },
    { name: 'notes', label: '更正原因', type: 'textarea', full: true, required: true },
  ], (data) => api(`/accounts/${account.id}/cost-reprice`, {
    method: 'POST',
    range: false,
    body: JSON.stringify(data),
  }));
}

function openAccountCostModal(account, profiles, { period = null, forceCreate = false } = {}) {
  const editing = Boolean(period);
  const formAccount = editing ? accountCostFormAccount(account, period) : forceCreate ? accountCostFormAccount(account, null) : account;
  openModal(editing ? '编辑账号成本期' : '登记账号成本', costFields(profiles, formAccount), async (data) => {
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
  });
}

function openBulkCostModal(profiles) {
  const accountIds = [...state.selectedAccounts];
  if (!accountIds.length) return toast('请先选择账号');
  openModal(`批量登记成本（${accountIds.length} 个账号）`, costFields(profiles, null, { batch: true }), (data) => api('/account-cost-periods/bulk', {
    method: 'POST', range: false, body: JSON.stringify({ ...normalizeCostPayload(data), accountIds }),
  }).then(() => { state.selectedAccounts.clear(); }));
}

function openCostProfileModal() {
  openModal('新建成本模板', [
    { name: 'name', label: '模板名称' },
    { name: 'costType', label: '成本类型', type: 'select', options: [['subscription', '固定订阅'], ['metered', '按量后付费'], ['prepaid', '预付余额'], ['one_time', '一次性购买'], ['free', '免费资源'], ['hybrid', '混合成本']] },
    { name: 'costMode', label: '核算模式', type: 'select', options: [['fixed_purchase', '固定采购成本'], ['probe_multiplier', '探测上游倍率'], ['manual_multiplier', '手动上游倍率'], ['free', '免费资源']] },
    { name: 'basisMode', label: '倍率成本基础', type: 'select', options: [['revenue_backsolve', '实际扣款按销售倍率回推'], ['reference_cny', '目录价乘 CNY 基准']] },
    { name: 'variableMultiplier', label: '默认手动上游倍率', type: 'number', required: false },
    { name: 'defaultSellingMultiplier', label: '默认销售倍率覆盖', type: 'number', required: false },
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
    api('/cost-profiles', { range: false }).then((profiles) => {
      if (ledgerEdit) openAccountLedgerModal(account, profiles);
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
