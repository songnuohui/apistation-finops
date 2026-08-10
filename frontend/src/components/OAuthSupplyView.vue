<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { CheckCircle2, CircleAlert, Eye, EyeOff, KeyRound, LockKeyhole, LogIn, RefreshCw, ShieldCheck } from 'lucide-vue-next';
import { get, send } from '../api';

type AnyRecord = Record<string, any>;

const props = defineProps<{ refreshToken?: number }>();
const emit = defineEmits<{ toast: [message: string] }>();

const settings = ref<AnyRecord>({});
const editor = ref<AnyRecord>(newEditor());
const loading = ref(false);
const saving = ref(false);
const testing = ref(false);
const showPassword = ref(false);

function newEditor() {
  return {
    enabled: false,
    baseUrl: 'https://sogouedu.cc',
    username: '',
    password: '',
    clearCredentials: false,
  };
}

const tokenStatus = computed(() => {
  if (!settings.value.enabled) return { label: '未启用', className: 'warning', icon: CircleAlert };
  if (settings.value.authenticated) return { label: 'Token 有效', className: 'success', icon: CheckCircle2 };
  if (settings.value.tokenConfigured) return { label: 'Token 已保存但需要刷新', className: 'warning', icon: RefreshCw };
  return { label: '尚未登录', className: 'danger', icon: CircleAlert };
});

function dateTime(value: any) {
  if (!value) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

function notify(message: string) {
  emit('toast', message);
}

function syncEditor() {
  editor.value = {
    enabled: Boolean(settings.value.enabled),
    baseUrl: settings.value.baseUrl || 'https://sogouedu.cc',
    username: settings.value.username || '',
    password: '',
    clearCredentials: false,
  };
}

async function load() {
  loading.value = true;
  try {
    settings.value = await get('/oauth-supply-auth');
    syncEditor();
  } catch (error: any) {
    notify(error.message);
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    settings.value = await send('/oauth-supply-auth', 'PATCH', editor.value);
    syncEditor();
    notify(settings.value.authenticated ? 'OAuth Supply 登录成功，Token 已安全保存' : 'OAuth Supply 配置已保存');
  } catch (error: any) {
    notify(error.message);
  } finally {
    saving.value = false;
  }
}

async function testLogin() {
  testing.value = true;
  try {
    settings.value = await send('/oauth-supply-auth/test', 'POST', {});
    syncEditor();
    notify('OAuth Supply 登录测试成功，Token 已刷新');
  } catch (error: any) {
    await load();
    notify(error.message);
  } finally {
    testing.value = false;
  }
}

function clearPassword() {
  editor.value.password = '';
  editor.value.clearCredentials = true;
  notify('已标记清除已保存的账号密码，点击保存后生效');
}

watch(() => props.refreshToken, load);
onMounted(load);
</script>

<template>
  <div class="page-view oauth-supply-view">
    <section class="oauth-supply-hero">
      <div class="oauth-supply-hero-copy">
        <div class="oauth-supply-eyebrow"><KeyRound :size="15" />独立采购接口</div>
        <h2>OAuth Supply 接入</h2>
        <p>先完成客户账号登录，FinOps 会在服务端安全保存 Token，后续库存、报价和自动下单都从这里接入。</p>
      </div>
      <div class="oauth-supply-hero-status">
        <component :is="tokenStatus.icon" :size="19" />
        <div><strong>{{ tokenStatus.label }}</strong><small>{{ settings.tokenExpiresAt ? `有效至 ${dateTime(settings.tokenExpiresAt)}` : 'Token 不会显示在页面上' }}</small></div>
      </div>
    </section>

    <div class="oauth-supply-grid">
      <section class="panel oauth-supply-form-panel">
        <div class="panel-head">
          <div><h2>登录配置</h2><p>账号密码只用于服务端调用 OAuth Supply 登录接口。</p></div>
          <LockKeyhole :size="20" class="head-icon" />
        </div>
        <div class="form-grid">
          <label class="full-field">Base URL
            <input v-model="editor.baseUrl" type="url" placeholder="https://sogouedu.cc" />
            <small class="field-hint">默认使用 https://sogouedu.cc，不能填写 URL 中的账号、密码或查询参数。</small>
          </label>
          <label>客户账号
            <input v-model="editor.username" autocomplete="username" placeholder="OAuth Supply 客户账号" />
          </label>
          <label>客户密码
            <div class="password-field">
              <input v-model="editor.password" :type="showPassword ? 'text' : 'password'" autocomplete="new-password" :placeholder="settings.credentialsConfigured ? '已保存，留空表示不修改' : '请输入密码'" />
              <button class="icon-button mini" type="button" :title="showPassword ? '隐藏密码' : '显示密码'" :aria-label="showPassword ? '隐藏密码' : '显示密码'" @click="showPassword = !showPassword"><Eye v-if="showPassword" :size="16" /><EyeOff v-else :size="16" /></button>
            </div>
          </label>
          <label class="toggle-field full-field">
            <input v-model="editor.enabled" type="checkbox" />
            <span><strong>启用 OAuth Supply 接入</strong><small>保存时会立即调用 POST /api/customer/login 验证账号，并取得 Token。</small></span>
          </label>
        </div>
        <div class="form-note"><ShieldCheck :size="16" /> Token 和密码都不会返回给浏览器，也不会写入 Sub2API 的数据库或 Redis。</div>
        <div class="oauth-supply-actions">
          <button class="secondary-button" type="button" :disabled="!settings.credentialsConfigured" @click="clearPassword"><LockKeyhole :size="16" />清除已保存凭据</button>
          <button class="primary-button" type="button" :disabled="saving || loading" @click="save"><LogIn :size="16" :class="{ spin: saving }" />{{ saving ? '保存并登录中' : '保存并登录' }}</button>
        </div>
      </section>

      <section class="panel oauth-supply-status-panel">
        <div class="panel-head">
          <div><h2>连接状态</h2><p>所有状态均来自 FinOps 自己的认证记录。</p></div>
          <button class="icon-button" type="button" title="刷新状态" aria-label="刷新状态" :disabled="loading" @click="load"><RefreshCw :size="17" :class="{ spin: loading }" /></button>
        </div>
        <dl class="oauth-supply-status-list">
          <div><dt>服务地址</dt><dd>{{ settings.baseUrl || '--' }}</dd></div>
          <div><dt>客户账号</dt><dd>{{ settings.username || '--' }}</dd></div>
          <div><dt>登录接口</dt><dd><code>POST /api/customer/login</code></dd></div>
          <div><dt>凭据状态</dt><dd><span class="status-pill" :class="settings.credentialsConfigured ? 'success' : 'warning'">{{ settings.credentialsConfigured ? '已加密保存' : '未配置' }}</span></dd></div>
          <div><dt>Token 状态</dt><dd><span class="status-pill" :class="tokenStatus.className">{{ tokenStatus.label }}</span></dd></div>
          <div><dt>最近登录</dt><dd>{{ dateTime(settings.lastAuthenticatedAt) }}</dd></div>
          <div v-if="settings.lastError" class="oauth-supply-error"><dt>最近错误</dt><dd>{{ settings.lastError }}</dd></div>
        </dl>
        <button class="secondary-button full" type="button" :disabled="testing || !settings.enabled" @click="testLogin"><RefreshCw :size="16" :class="{ spin: testing }" />{{ testing ? '刷新 Token 中' : '测试登录并刷新 Token' }}</button>
      </section>
    </div>
  </div>
</template>
