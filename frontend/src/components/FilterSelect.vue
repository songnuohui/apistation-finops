<script setup lang="ts">
import { Check, ChevronDown, Search } from 'lucide-vue-next';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

type SelectOption = { value: string; label: string };

const props = withDefaults(defineProps<{
  modelValue: string;
  options: SelectOption[];
  ariaLabel: string;
  searchable?: boolean;
  searchPlaceholder?: string;
}>(), {
  searchable: true,
  searchPlaceholder: '搜索选项...',
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
  change: [value: string];
}>();

const container = ref<HTMLElement | null>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const open = ref(false);
const query = ref('');
const focusedIndex = ref(-1);

const selected = computed(() => (
  props.options.find((option) => option.value === props.modelValue) || props.options[0]
));
const filteredOptions = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase();
  if (!keyword) return props.options;
  return props.options.filter((option) => option.label.toLocaleLowerCase().includes(keyword));
});

function toggle() {
  open.value = !open.value;
}

function close() {
  open.value = false;
}

function selectOption(option: SelectOption) {
  emit('update:modelValue', option.value);
  emit('change', option.value);
  close();
}

function moveFocus(offset: number) {
  if (!open.value) {
    open.value = true;
    return;
  }
  if (!filteredOptions.value.length) return;
  focusedIndex.value = (
    focusedIndex.value + offset + filteredOptions.value.length
  ) % filteredOptions.value.length;
}

function selectFocused() {
  if (!open.value) {
    open.value = true;
    return;
  }
  const option = filteredOptions.value[focusedIndex.value];
  if (option) selectOption(option);
}

function handleOutside(event: PointerEvent) {
  if (!container.value?.contains(event.target as Node)) close();
}

watch(open, async (isOpen) => {
  if (!isOpen) {
    query.value = '';
    focusedIndex.value = -1;
    return;
  }
  focusedIndex.value = Math.max(0, filteredOptions.value.findIndex(
    (option) => option.value === props.modelValue,
  ));
  if (props.searchable) {
    await nextTick();
    searchInput.value?.focus();
  }
});

watch(filteredOptions, () => {
  focusedIndex.value = filteredOptions.value.length ? 0 : -1;
});

onMounted(() => document.addEventListener('pointerdown', handleOutside));
onUnmounted(() => document.removeEventListener('pointerdown', handleOutside));
</script>

<template>
  <div ref="container" class="filter-select">
    <button
      type="button"
      class="filter-select-trigger"
      :class="{ open }"
      :aria-label="ariaLabel"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="toggle"
      @keydown.down.prevent="moveFocus(1)"
      @keydown.up.prevent="moveFocus(-1)"
      @keydown.enter.prevent="selectFocused"
      @keydown.esc.prevent="close"
    >
      <span>{{ selected?.label }}</span>
      <ChevronDown :size="17" :class="{ rotated: open }" />
    </button>

    <div v-if="open" class="filter-select-menu" role="listbox" @keydown.esc.prevent="close">
      <div v-if="searchable" class="filter-select-search">
        <Search :size="15" />
        <input
          ref="searchInput"
          v-model="query"
          :placeholder="searchPlaceholder"
          :aria-label="searchPlaceholder"
          @keydown.down.prevent="moveFocus(1)"
          @keydown.up.prevent="moveFocus(-1)"
          @keydown.enter.prevent="selectFocused"
        />
      </div>
      <div class="filter-select-options">
        <button
          v-for="(option, index) in filteredOptions"
          :key="option.value"
          type="button"
          class="filter-select-option"
          :class="{ selected: option.value === modelValue, focused: index === focusedIndex }"
          role="option"
          :aria-selected="option.value === modelValue"
          @mouseenter="focusedIndex = index"
          @click="selectOption(option)"
        >
          <span>{{ option.label }}</span>
          <Check v-if="option.value === modelValue" :size="16" />
        </button>
        <div v-if="!filteredOptions.length" class="filter-select-empty">没有匹配选项</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.filter-select{position:relative;min-width:0}
.filter-select-trigger{
  width:100%;height:42px;display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:0 14px;border:1px solid #d7e2ed;border-radius:8px;background:#fff;color:#31445d;
  font-size:12px;text-align:left;transition:border-color .16s ease,box-shadow .16s ease;
}
.filter-select-trigger:hover{border-color:#bdcad8}
.filter-select-trigger.open{border-color:#4c9cde;box-shadow:0 0 0 3px rgba(35,145,201,.12)}
.filter-select-trigger span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.filter-select-trigger svg{flex:0 0 auto;color:#8392a7;transition:transform .16s ease}
.filter-select-trigger svg.rotated{transform:rotate(180deg)}
.filter-select-menu{
  position:absolute;z-index:75;top:calc(100% + 5px);left:0;width:max(100%,220px);overflow:hidden;
  border:1px solid #dbe3ec;border-radius:8px;background:#fff;box-shadow:0 12px 30px rgba(30,52,80,.16);
}
.filter-select-search{
  height:40px;display:flex;align-items:center;gap:8px;padding:0 11px;border-bottom:1px solid #edf1f6;
  color:#8a98aa;
}
.filter-select-search input{
  width:100%;height:38px;padding:0;border:0;background:transparent;color:#31445d;font-size:12px;outline:0;
}
.filter-select-options{max-height:280px;overflow-y:auto;padding:5px}
.filter-select-option{
  width:100%;min-height:37px;display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:8px 10px;border:0;border-radius:6px;background:transparent;color:#42536a;font-size:12px;text-align:left;
}
.filter-select-option:hover,.filter-select-option.focused{background:#f3f6fa}
.filter-select-option.selected{color:#1763cc;background:#edf5ff}
.filter-select-option span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.filter-select-option svg{flex:0 0 auto}
.filter-select-empty{padding:24px 12px;color:#8a98aa;font-size:12px;text-align:center}
</style>
