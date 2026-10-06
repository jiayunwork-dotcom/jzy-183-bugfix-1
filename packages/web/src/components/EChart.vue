<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import * as echarts from 'echarts';

const props = defineProps<{ option: echarts.EChartsOption }>();
const el = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

function render() {
  if (!el.value) return;
  if (!chart) chart = echarts.init(el.value);
  chart.setOption(props.option, true);
}

onMounted(() => {
  render();
  window.addEventListener('resize', resize);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', resize);
  chart?.dispose();
  chart = null;
});
function resize() {
  chart?.resize();
}
watch(() => props.option, render, { deep: true });
</script>

<template>
  <div ref="el" class="chart-host"></div>
</template>

<style scoped>
.chart-host {
  width: 100%;
  height: 100%;
}
</style>
