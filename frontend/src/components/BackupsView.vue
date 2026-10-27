<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { AlertTriangle, CheckCircle2, Cloud, Database, Download, HardDrive, Play, RefreshCw, Save, ShieldCheck, X } from 'lucide-vue-next';
import { get, send } from '../api';
import PaginationBar from './PaginationBar.vue';

type RecordValue = Record<string, any>;
const props = defineProps<{ refreshToken?: number }>();
const emit = defineEmits<{ toast: [message: string] }>();
const tab = ref('overview');
const settings = ref<RecordValue>({});
const jobs = ref<RecordValue[]>([]);
const page = ref(1);
const pageSize = ref(20);
const total = ref(0);
const activeJob = ref<RecordValue | null>(null);
const lastSuccess = ref<RecordValue | null>(null);
const historyLoading = ref(false);
const snapshots = ref<RecordValue[]>([]);
const source = ref<RecordValue | null>(null);
const snapshotLoaded = ref(false);
const loading = ref(true);
const working = ref('');
const errorMessage = ref('');
const confirmation = ref<{ title: string; message: string; action: () => Promise<void> } | null>(null);
const form = ref<RecordValue>({
  enabled: false, endpoint: 'https://s3.cn-east-1.qiniucs.com', region: 'cn-east-1', bucket: '', prefix: 'sub2api-backup',
  intervalMinutes: 60, timeoutMinutes: 30, uploadLimitKiB: 2048, keepHourly: 48, keepDaily: 30, keepWeekly: 8,
  autoPrune: false, accessKey: '', secretKey: '', password: '',
});
let timer: ReturnType<typeof setInterval>;
let requestVersion = 0;
let formLoaded = false;
let disposed = false;
const disabled = computed(() => Boolean(working.value || activeJob.value));
const ready = computed(() => settings.value.workerConfigured && settings.value.encryptionReady
  && settings.value.bucket && settings.value.passwordConfigured && settings.value.accessKeyConfigured && settings.value.secretKeyConfigured);
const stages: Record<string, string> = { queued: '等待执行', exporting: '只读导出', uploading: '加密去重上传', checking: '仓库完整性检查', completed: '已完成', failed: '失败' };
const states: Record<string, string> = { queued: '排队中', running: '执行中', completed: '已完成', failed: '失败' };
const dateTime = (value: any) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) : '—';
function bytes(value: any) {
  if (value === undefined || value === null) return '—';
  const number = Number(value);
  const unit = number >= 1073741824 ? 1073741824 : number >= 1048576 ? 1048576 : number >= 1024 ? 1024 : 1;
  return `${(number / unit).toFixed(unit === 1 ? 0 : 1)} ${{ 1: 'B', 1024: 'KiB', 1048576: 'MiB', 1073741824: 'GiB' }[unit]}`;
}
function copySettings() {
  for (const key of Object.keys(form.value)) {
    if (!['accessKey', 'secretKey', 'password'].includes(key) && settings.value[key] !== undefined) form.value[key] = settings.value[key];
  }
  form.value.accessKey = form.value.secretKey = form.value.password = '';
}
async function perform(name: string, action: () => Promise<void>) {
  if (working.value) return;
  working.value = name;
  errorMessage.value = '';
  try { await action(); } catch (error: any) { errorMessage.value = error.message || '操作失败'; emit('toast', errorMessage.value); }
  finally { working.value = ''; }
}
async function load() {
  if (disposed || working.value === 'save') return;
  const version = ++requestVersion;
  historyLoading.value = true;
  try {
    const [value, history] = await Promise.all([get('/backups/settings'), get(`/backups/jobs?page=${page.value}&page_size=${pageSize.value}`)]);
    if (disposed || version !== requestVersion) return;
    settings.value = value;
    jobs.value = history.items || [];
    total.value = history.total;
    activeJob.value = history.activeJob || null;
    lastSuccess.value = history.lastSuccess || null;
    if (!formLoaded) { copySettings(); formLoaded = true; }
    const lastPage = Math.max(1, Math.ceil(total.value / pageSize.value));
    if (page.value > lastPage) page.value = lastPage;
  } catch (error: any) { if (!disposed && version === requestVersion) errorMessage.value = error.message; }
  finally {
    if (!disposed && version === requestVersion) { loading.value = false; historyLoading.value = false; }
  }
}
async function save(confirmRepositoryChange = false) {
  const repositoryChanged = settings.value.bucket && ['endpoint', 'bucket', 'prefix'].some((key) => form.value[key] !== settings.value[key]);
  if (repositoryChanged && !confirmRepositoryChange) {
    confirmation.value = { title: '更换备份仓库', message: '保存后将使用新仓库。旧仓库及其恢复点不会被删除，但需要使用原配置和原密码访问。', action: () => save(true) };
    return;
  }
  await perform('save', async () => {
    requestVersion++;
    historyLoading.value = false;
    loading.value = false;
    settings.value = await send('/backups/settings', 'PATCH', { ...form.value, confirmRepositoryChange });
    copySettings();
    formLoaded = true;
    snapshots.value = [];
    snapshotLoaded.value = false;
    emit('toast', settings.value.enabled ? '配置已保存，自动备份已启用' : '配置已保存，自动备份保持关闭');
  });
  await load();
}
async function action(name: string) {
  await perform(name, async () => {
    const value = await send(`/backups/${name}`, 'POST', name === 'init' ? { confirm: true } : {});
    if (name === 'source') source.value = value;
    else if (name === 'snapshots') { snapshots.value = value.items || []; snapshotLoaded.value = true; }
    else emit('toast', value.message || '操作完成');
  });
}
function initialize() {
  confirmation.value = { title: '初始化七牛专用仓库', message: '请先保存配置，并确认空间与目录专供此备份使用。此操作在七牛创建加密仓库，不修改 Sub2API。已有仓库应使用“测试仓库”，不要重新初始化。', action: () => action('init') };
}
function run() {
  confirmation.value = { title: '立即备份 Sub2API 业务数据', message: '备份只读取选定的 PostgreSQL 数据，不修改数据库或 Redis。每轮仍需扫描业务表，可能产生 CPU 和磁盘读取负载；运行期间不可修改配置。', action: () => perform('run', async () => { await send('/backups/run', 'POST', {}); await load(); emit('toast', '备份任务已提交'); }) };
}
function download(item: RecordValue) {
  confirmation.value = { title: '导出完整恢复数据包', message: '将汇集该恢复点所需的全部数据，不是只下载增量块。下载的 TAR 文件含用户资料及账户密钥，不再受云端仓库加密保护，请妥善保管。请在隔离空库中自行测试，严禁导入生产原库。', action: async () => {
    const link = document.createElement('a');
    link.href = `/api/backups/snapshots/${item.id}/download`;
    link.download = `sub2api-${item.id.slice(0, 12)}.tar`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    emit('toast', '已请求导出，请确认浏览器下载完成，并校验包内 SHA256SUMS');
  } };
}
async function confirm() {
  const value = confirmation.value;
  confirmation.value = null;
  await value?.action();
}
onMounted(() => {
  void load();
  timer = setInterval(() => {
    if (!historyLoading.value && !working.value) void load();
  }, 5000);
});
onUnmounted(() => { disposed = true; requestVersion++; clearInterval(timer); });
watch(pageSize, () => { page.value = 1; });
watch([page, pageSize], () => void load());
watch(() => props.refreshToken, () => void load());
</script>

<template>
  <div class="page-view backup-view" :aria-busy="loading">
    <div class="backup-toolbar">
      <nav class="backup-tabs" aria-label="数据备份">
        <button v-for="item in [{ id: 'overview', label: '概览与记录' }, { id: 'settings', label: '备份配置' }, { id: 'snapshots', label: '云端恢复点' }]" :key="item.id" :class="{ active: tab === item.id }" @click="tab = item.id">{{ item.label }}</button>
      </nav>
      <button class="primary-button" :disabled="disabled || !ready" @click="run"><Play :size="15" />立即备份</button>
    </div>

    <div v-if="errorMessage" class="backup-notice error" role="alert"><AlertTriangle :size="18" /><span>{{ errorMessage }}</span><button class="icon-button mini" aria-label="关闭提示" @click="errorMessage = ''"><X :size="15" /></button></div>
    <div v-if="!loading && (!settings.workerConfigured || !settings.encryptionReady)" class="backup-notice"><ShieldCheck :size="18" /><span>{{ !settings.workerConfigured ? '备份执行器未配置。' : '' }}{{ !settings.encryptionReady ? '配置加密密钥未部署。' : '' }} 当前不能启动备份，生产数据未受影响。</span></div>

    <template v-if="tab === 'overview'">
      <div class="backup-metrics">
        <article class="metric-card"><span>自动备份</span><strong>{{ settings.enabled ? '已启用' : '已关闭' }}</strong><small>间隔 {{ settings.intervalMinutes || 60 }} 分钟 · 上海时间</small></article>
        <article class="metric-card"><span>最近成功的源快照</span><strong class="backup-time">{{ dateTime(lastSuccess?.progress?.sourceAt) }}</strong><small>不是上传完成时间</small></article>
        <article class="metric-card"><span>下次计划执行</span><strong class="backup-time">{{ dateTime(settings.nextRunAt) }}</strong><small>已有任务运行时不重叠执行</small></article>
        <article class="metric-card"><span>最近压缩后新增量</span><strong>{{ bytes(lastSuccess?.progress?.addedPackedBytes) }}</strong><small>新增原始量 {{ bytes(lastSuccess?.progress?.addedBytes) }}</small></article>
      </div>
      <section v-if="activeJob" class="backup-running" aria-live="polite"><RefreshCw class="spin" :size="20" /><div><strong>{{ stages[activeJob.progress?.phase] || '任务已提交' }}</strong><p>已读取 {{ bytes(activeJob.progress?.readBytes) }}<template v-if="activeJob.progress?.totalBytes"> · 已处理 {{ bytes(activeJob.progress.bytesDone) }} / {{ bytes(activeJob.progress.totalBytes) }}</template></p></div></section>
      <section class="panel">
        <header class="panel-head"><div><h2>备份任务</h2><p>仓库检查不代表已完成数据库恢复验证。</p></div><button class="icon-button" title="刷新记录" aria-label="刷新记录" @click="load()"><RefreshCw :size="17" /></button></header>
        <div class="backup-table-wrap" :aria-busy="historyLoading"><table class="backup-table backup-history-table"><thead><tr><th>开始时间</th><th>触发方式</th><th>状态</th><th>源快照时间</th><th>读取量</th><th>新增原始量</th><th>压缩后新增量</th><th>结果</th></tr></thead><tbody>
          <tr v-for="item in jobs" :key="item.id"><td>{{ dateTime(item.createdAt) }}</td><td>{{ item.kind === 'scheduled' ? '定时' : '手动' }}</td><td><span class="status-pill" :class="item.status === 'completed' ? 'success' : item.status === 'failed' ? 'danger' : 'warning'">{{ states[item.status] }}</span></td><td>{{ dateTime(item.progress?.sourceAt) }}</td><td>{{ bytes(item.progress?.readBytes) }}</td><td>{{ bytes(item.progress?.addedBytes) }}</td><td>{{ bytes(item.progress?.addedPackedBytes) }}</td><td class="backup-result"><span v-if="item.error" class="backup-danger">{{ item.error }}</span><span v-else-if="item.progress?.warning">{{ item.progress.warning }}</span><code v-else-if="item.progress?.snapshotId" :title="item.progress.snapshotId">{{ item.progress.snapshotId.slice(0, 12) }}</code><span v-else>{{ stages[item.progress?.phase] || '等待执行' }}</span></td></tr>
          <tr v-if="!jobs.length"><td colspan="8" class="backup-empty">{{ historyLoading ? '正在读取任务记录…' : '尚无备份记录。请先保存存储配置、初始化专用仓库，再手动执行首份备份。' }}</td></tr>
        </tbody></table></div>
        <PaginationBar v-model:page="page" v-model:page-size="pageSize" :total="total" />
      </section>
      <div class="backup-notice"><Database :size="18" /><span>每次读取业务表的一致性快照，云端按变化块去重存储。不支持任意时刻恢复；实际数据损失窗口还包含导出和上传耗时。备份不包含 FinOps、Redis、建表语句或索引。</span></div>
    </template>

    <template v-if="tab === 'settings'">
      <form class="panel" @submit.prevent="save()">
        <header class="panel-head"><div><h2>七牛加密仓库</h2><p>敏感值不回显；留空保持原值。仓库密码必须在 FinOps 之外独立保存。</p></div><Cloud :size="22" class="head-icon" /></header>
        <div class="form-grid">
          <label>区域<select v-model="form.region" :disabled="disabled" @change="form.endpoint = `https://s3.${form.region}.qiniucs.com`"><option value="cn-east-1">华东 cn-east-1</option><option value="cn-east-2">华东 cn-east-2</option><option value="cn-north-1">华北 cn-north-1</option><option value="cn-south-1">华南 cn-south-1</option><option value="us-north-1">北美 us-north-1</option><option value="ap-southeast-1">新加坡 ap-southeast-1</option></select></label>
          <label>区域 S3 HTTPS 接口（不含空间名）<input v-model="form.endpoint" type="url" required :disabled="disabled" :placeholder="`https://s3.${form.region}.qiniucs.com`" /></label>
          <label>私有空间名称<input v-model="form.bucket" maxlength="63" required :disabled="disabled" autocomplete="off" /></label>
          <label>专用仓库目录<input v-model="form.prefix" required :disabled="disabled" autocomplete="off" /></label>
          <label>Access Key<input v-model="form.accessKey" name="qiniu-access-key" type="password" :placeholder="settings.accessKeyConfigured ? '已配置，留空保持' : '请输入访问密钥'" :disabled="disabled" autocomplete="off" autocapitalize="none" :spellcheck="false" /></label>
          <label>Secret Key<input v-model="form.secretKey" name="qiniu-secret-key" type="password" :placeholder="settings.secretKeyConfigured ? '已配置，留空保持' : '请输入密钥'" :disabled="disabled" autocomplete="off" autocapitalize="none" :spellcheck="false" /></label>
          <label>仓库加密密码<input v-model="form.password" name="restic-repository-password" type="password" minlength="16" :placeholder="settings.passwordConfigured ? '已配置，请保留原密码' : '至少 16 个字符，请独立保管'" :disabled="disabled" autocomplete="off" /></label>
        </div>
        <h3 class="backup-subheading">计划与保留策略</h3>
        <div class="form-grid">
          <label>备份间隔（分钟）<input v-model.number="form.intervalMinutes" type="number" min="15" max="10080" required :disabled="disabled" /></label>
          <label>任务超时（分钟）<input v-model.number="form.timeoutMinutes" type="number" min="5" max="120" required :disabled="disabled" /></label>
          <label>上传限速（KiB/s）<input v-model.number="form.uploadLimitKiB" type="number" min="128" max="102400" required :disabled="disabled" /></label>
          <label>按小时保留（小时桶数）<input v-model.number="form.keepHourly" type="number" min="1" max="720" required :disabled="disabled" /></label>
          <label>按天保留（天桶数）<input v-model.number="form.keepDaily" type="number" min="1" max="365" required :disabled="disabled" /></label>
          <label>按周保留（周桶数）<input v-model.number="form.keepWeekly" type="number" min="1" max="104" required :disabled="disabled" /></label>
        </div>
        <div class="backup-checks"><label><input v-model="form.autoPrune" type="checkbox" :disabled="disabled" />自动清理不再被保留恢复点引用的数据块</label><label><input v-model="form.enabled" type="checkbox" :disabled="disabled" />启用自动备份</label></div>
        <div v-if="form.autoPrune" class="backup-notice"><AlertTriangle :size="17" /><span>清理会删除不在保留策略中的历史恢复点及无引用数据块。七牛空间不能另设按对象年龄自动删除的生命周期规则。</span></div>
        <div class="backup-actions"><button class="primary-button" type="submit" :disabled="disabled || !settings.encryptionReady"><Save :size="16" />{{ working === 'save' ? '保存中…' : '保存配置' }}</button><button class="secondary-button" type="button" :disabled="disabled || !ready" @click="action('test')"><CheckCircle2 :size="16" />测试已保存的仓库</button><button class="secondary-button" type="button" :disabled="disabled || !ready" @click="initialize"><HardDrive :size="16" />初始化专用空仓库</button></div>
      </form>
      <section class="panel"><header class="panel-head"><div><h2>生产源与固定备份范围</h2><p>Sub2API 仅只读导出；源数据库连接、SQL 和生产管理凭据不通过此页面修改。</p></div><button class="secondary-button" :disabled="disabled || !settings.workerConfigured" @click="action('source')"><ShieldCheck :size="16" />只读检查</button></header>
        <p v-if="!source" class="backup-muted">尚未检查。保留核心业务与账务去重数据，排除运行日志；必要的账务关联请求记录单独保留。</p>
        <template v-else><div class="backup-source-state"><span class="status-pill" :class="source.allowed ? 'success' : 'danger'">{{ source.allowed ? '范围检查通过' : '需要人工检查，禁止备份' }}</span><span>{{ source.database }} · PostgreSQL {{ source.version }} · 选定表物理占用 {{ bytes(source.physicalBytes) }}（包含索引，不是上传量）</span></div><p v-if="source.unknown?.length" class="backup-danger">未审核的新表：{{ source.unknown.join('、') }}</p><p v-for="message in source.errors" :key="message" class="backup-danger">{{ message }}</p><details><summary>包含的业务表（{{ source.included?.length }}）</summary><p class="backup-table-names">{{ source.included?.join('、') }}</p></details><details><summary>排除的日志与运行数据（{{ source.excluded?.length }}）</summary><p class="backup-table-names">{{ source.excluded?.join('、') }}</p></details><p class="backup-muted">usage_logs 仅包含被账务等已选业务表引用的行。数据库结构指纹会随恢复点保存；自行恢复时必须使用对应版本的建表 SQL。</p></template>
      </section>
    </template>

    <section v-if="tab === 'snapshots'" class="panel"><header class="panel-head"><div><h2>当前七牛仓库的恢复点</h2><p>导出 TAR 包包含完整数据、清单、SHA-256 校验、外键验证 SQL 和恢复说明；没有自动恢复操作。</p></div><button class="secondary-button" :disabled="disabled || !ready" @click="action('snapshots')"><RefreshCw :size="16" />{{ working === 'snapshots' ? '读取中…' : '读取云端恢复点' }}</button></header>
      <div class="backup-table-wrap"><table class="backup-table"><thead><tr><th>源快照时间</th><th>上传快照时间</th><th>恢复点 ID</th><th>结构指纹</th><th>操作</th></tr></thead><tbody><tr v-for="item in snapshots" :key="item.id"><td>{{ dateTime(item.sourceAt) }}</td><td>{{ dateTime(item.time) }}</td><td><code :title="item.id">{{ item.id.slice(0, 12) }}</code></td><td><code :title="item.schemaFingerprint">{{ item.schemaFingerprint.slice(0, 12) || '—' }}</code></td><td><button class="secondary-button" :disabled="disabled" @click="download(item)"><Download :size="15" />导出完整数据包</button></td></tr><tr v-if="!snapshots.length"><td colspan="5" class="backup-empty">{{ snapshotLoaded ? '当前仓库尚无本系统生成的恢复点。' : '点击“读取云端恢复点”查询已保存配置对应的七牛仓库。' }}</td></tr></tbody></table></div>
    </section>
    <div v-if="confirmation" class="modal-layer" @click.self="confirmation = null"><section class="modal backup-confirm" role="dialog" aria-modal="true" aria-labelledby="backup-confirm-title"><header><h2 id="backup-confirm-title">{{ confirmation.title }}</h2><button class="icon-button" aria-label="关闭确认窗口" @click="confirmation = null"><X :size="18" /></button></header><p>{{ confirmation.message }}</p><footer><button class="secondary-button" @click="confirmation = null">取消</button><button class="primary-button" @click="confirm">确认</button></footer></section></div>
  </div>
</template>

<style scoped>
.backup-toolbar,.backup-actions,.backup-source-state{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.backup-tabs{display:flex;gap:18px;border-bottom:1px solid var(--line)}
.backup-tabs button{border:0;border-bottom:2px solid transparent;background:none;padding:12px 2px;color:var(--muted);font-weight:600}
.backup-tabs button.active{border-bottom-color:var(--primary);color:var(--primary)}
.backup-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.backup-time{font-size:15px!important;line-height:26px!important;white-space:normal;overflow:visible!important}
.backup-notice{display:flex;align-items:flex-start;gap:10px;padding:13px 15px;border-left:3px solid var(--amber);background:#fff9eb;color:#795923;font-size:12px;line-height:1.8}
.backup-notice svg{flex-shrink:0;margin-top:2px}.backup-notice span{flex:1;overflow-wrap:anywhere}.backup-notice.error{border-color:var(--red);background:#fff1f3;color:#a32a40}
.backup-running{display:flex;align-items:center;gap:15px;padding:15px 0;color:var(--primary)}.backup-running p{margin:6px 0 0;font-size:12px;color:var(--muted)}
.backup-table-wrap{overflow:auto}.backup-table{border-collapse:collapse;width:100%;min-width:850px;font-size:12px}.backup-table th{text-align:left;color:var(--muted);font-weight:600;background:var(--surface-soft);padding:12px}.backup-table td{padding:14px 12px;border-bottom:1px solid var(--line);vertical-align:top}.backup-table code{font-size:11px}.backup-result{max-width:300px;overflow-wrap:anywhere}.backup-empty{text-align:center!important;color:var(--muted);padding:35px 16px!important;white-space:normal}
.backup-history-table{min-width:1050px}
.backup-subheading{margin:25px 0 15px;font-size:14px;padding-top:20px;border-top:1px solid var(--line)}
.backup-actions{justify-content:flex-start;margin-top:20px}.backup-actions button,.backup-toolbar>button{display:inline-flex;align-items:center;gap:7px}.backup-checks{display:flex;flex-wrap:wrap;gap:20px;margin:20px 0}.backup-checks label{display:flex;align-items:center;gap:8px;font-size:13px}.backup-checks input{width:16px;height:16px;accent-color:var(--primary)}
.backup-danger{color:var(--red)}.backup-muted,.backup-table-names{font-size:12px;line-height:1.9;color:var(--muted);overflow-wrap:anywhere}.backup-source-state{justify-content:flex-start;font-size:12px;margin-bottom:15px}.backup-view details{border-top:1px solid var(--line);padding:12px 0}.backup-view summary{cursor:pointer;font-size:13px}.backup-confirm{max-width:550px}.backup-confirm p{font-size:14px;line-height:1.9;color:var(--muted)}.backup-confirm header,.backup-confirm footer{display:flex;justify-content:space-between;gap:12px;align-items:center}.backup-confirm h2{font-size:17px;margin:0}.backup-confirm footer{justify-content:flex-end;margin-top:20px}
@media(max-width:1000px){.backup-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){.backup-tabs{gap:14px}.backup-tabs button{font-size:12px}.backup-toolbar{align-items:stretch}.backup-metrics{grid-template-columns:1fr}.backup-actions{align-items:stretch;flex-direction:column}.backup-view .form-grid{grid-template-columns:1fr}.backup-toolbar>button{justify-content:center}.backup-checks{flex-direction:column;gap:12px}.backup-view .panel-head{flex-wrap:wrap}}
</style>
