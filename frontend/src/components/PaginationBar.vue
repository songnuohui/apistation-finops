<script setup lang="ts">
import { ChevronLeft, ChevronRight } from 'lucide-vue-next';
import { computed } from 'vue';

const props = withDefaults(defineProps<{
  page: number;
  pageSize: number;
  total: number;
  pageSizes?: number[];
}>(), {
  pageSizes: () => [10, 20, 50, 100],
});

const emit = defineEmits<{
  'update:page': [value: number];
  'update:pageSize': [value: number];
}>();

const pages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));
const rangeStart = computed(() => props.total ? (props.page - 1) * props.pageSize + 1 : 0);
const rangeEnd = computed(() => Math.min(props.page * props.pageSize, props.total));

const pageItems = computed<(number | 'ellipsis')[]>(() => {
  const last = pages.value;
  if (last <= 7) return Array.from({ length: last }, (_, index) => index + 1);
  if (props.page <= 4) return [1, 2, 3, 4, 5, 'ellipsis', last];
  if (props.page >= last - 3) return [1, 'ellipsis', last - 4, last - 3, last - 2, last - 1, last];
  return [1, 'ellipsis', props.page - 1, props.page, props.page + 1, 'ellipsis', last];
});

function goTo(page: number) {
  emit('update:page', Math.min(Math.max(1, page), pages.value));
}

function changePageSize(value: string) {
  emit('update:pageSize', Number(value));
}
</script>

<template>
  <div class="pagination-bar">
    <div class="pagination-summary">
      <span>显示 {{ rangeStart }} 至 {{ rangeEnd }} 条，共 {{ total }} 条结果</span>
      <label>每页
        <select :value="pageSize" @change="changePageSize(($event.target as HTMLSelectElement).value)">
          <option v-for="size in pageSizes" :key="size" :value="size">{{ size }}</option>
        </select>
        条
      </label>
    </div>
    <div class="pagination-controls" aria-label="分页">
      <button
        class="pagination-button"
        type="button"
        title="上一页"
        aria-label="上一页"
        :disabled="page <= 1"
        @click="goTo(page - 1)"
      >
        <ChevronLeft :size="16" />
      </button>
      <template v-for="(item, index) in pageItems" :key="`${item}-${index}`">
        <span v-if="item === 'ellipsis'" class="pagination-ellipsis">...</span>
        <button
          v-else
          class="pagination-button pagination-number"
          :class="{ active: item === page }"
          type="button"
          :aria-current="item === page ? 'page' : undefined"
          @click="goTo(item)"
        >
          {{ item }}
        </button>
      </template>
      <button
        class="pagination-button"
        type="button"
        title="下一页"
        aria-label="下一页"
        :disabled="page >= pages"
        @click="goTo(page + 1)"
      >
        <ChevronRight :size="16" />
      </button>
    </div>
  </div>
</template>
