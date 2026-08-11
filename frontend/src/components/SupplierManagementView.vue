<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { Activity, KeyRound, RefreshCw, ServerCog, ShieldCheck } from 'lucide-vue-next';
import { useRoute, useRouter } from 'vue-router';
import SupplierConnectionsView from './SupplierConnectionsView.vue';
import SupplierKeysView from './SupplierKeysView.vue';
import SupplierQualityView from './SupplierQualityView.vue';

type TabId = 'connections' | 'keys' | 'quality';

const props = defineProps<{
  refreshToken?: number;
  range?: string;
  rangeStart?: string;
  rangeEnd?: string;
}>();
const emit = defineEmits<{ toast: [message: string] }>();
const route = useRoute();
const router = useRouter();

const tabItems: Array<{ id: TabId; label: string; description: string; icon: any }> = [
  { id: 'connections', label: '连接概览', description: '余额、密钥库存、同步和告警', icon: ServerCog },
  { id: 'keys', label: '密钥与分组', description: '密钥、账号、分组和利润策略', icon: KeyRound },
  { id: 'quality', label: '质量评分', description: '价格、可用性、延迟和稳定性', icon: ShieldCheck },
];

const activeTab = computed<TabId>(() => {
  const value = String(route.query.tab || '');
  return ['connections', 'keys', 'quality'].includes(value) ? value as TabId : 'connections';
});
const tabIndex = computed(() => tabItems.findIndex((item) => item.id === activeTab.value));
const localRefreshToken = ref(0);

function selectTab(tab: TabId) {
  const query: Record<string, string | string[]> = { ...route.query, tab };
  if (tab !== 'connections') delete query.connection;
  router.push({ path: '/suppliers', query });
}

function refreshActiveTab() {
  localRefreshToken.value += 1;
}

watch(() => props.refreshToken, refreshActiveTab);
onMounted(() => {
  if (!route.query.tab) {
    router.replace({ path: '/suppliers', query: { ...route.query, tab: 'connections' } });
  }
});
</script>

<template>
  <div class="supplier-management-view">
    <section class="supplier-tabs-shell">
      <div class="supplier-tabs-head">
        <div>
          <span class="eyebrow">供应商资源中心</span>
          <h2>供应商管理</h2>
          <p>统一查看连接、密钥、账号分组和供应商质量，详情按需加载。</p>
        </div>
        <button class="icon-button" title="刷新当前页签" aria-label="刷新当前页签" @click="refreshActiveTab">
          <RefreshCw :size="17" />
        </button>
      </div>
      <div class="supplier-tabs" role="tablist" aria-label="供应商管理页签">
        <button
          v-for="(item, index) in tabItems"
          :key="item.id"
          class="supplier-tab"
          :class="{ active: activeTab === item.id }"
          role="tab"
          :aria-selected="activeTab === item.id"
          @click="selectTab(item.id)"
        >
          <span class="supplier-tab-icon"><component :is="item.icon" :size="17" /></span>
          <span class="supplier-tab-copy"><strong>{{ item.label }}</strong><small>{{ item.description }}</small></span>
          <span class="supplier-tab-index">{{ String(index + 1).padStart(2, '0') }}</span>
        </button>
      </div>
      <div class="supplier-tab-progress" aria-hidden="true"><i :style="{ width: `${((tabIndex + 1) / tabItems.length) * 100}%` }"></i></div>
    </section>

    <SupplierConnectionsView
      v-if="activeTab === 'connections'"
      :refresh-token="localRefreshToken"
      :range="props.range"
      :range-start="props.rangeStart"
      :range-end="props.rangeEnd"
      @toast="emit('toast', $event)"
    />
    <SupplierKeysView
      v-else-if="activeTab === 'keys'"
      :refresh-token="localRefreshToken"
      @toast="emit('toast', $event)"
    />
    <SupplierQualityView
      v-else
      :refresh-token="localRefreshToken"
      :range="props.range"
      :range-start="props.rangeStart"
      :range-end="props.rangeEnd"
      @toast="emit('toast', $event)"
    />
  </div>
</template>
