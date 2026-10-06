<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api, type OverviewItem } from '../api';
import { fmtDate, levelLabel } from '../format';

const items = ref<OverviewItem[]>([]);
const loading = ref(true);
const error = ref('');

async function load() {
  loading.value = true;
  try {
    items.value = (await api.overview()).items;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>

<template>
  <div class="panel">
    <div class="row" style="justify-content: space-between">
      <h2 style="margin: 0">全部测孔当前预警等级</h2>
      <button class="secondary" @click="load">刷新</button>
    </div>
    <p class="muted" v-if="!loading">
      每孔取最近一次测量“按当前数据”的判级；点击编号查看剖面与历史。
    </p>
    <p v-if="error" class="errors">{{ error }}</p>
    <table class="grid">
      <thead>
        <tr>
          <th>孔号</th>
          <th>最近测量</th>
          <th>当前等级</th>
          <th>最大速率 (mm/d)</th>
          <th>基准段数</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="it in items" :key="it.boreholeId">
          <td>
            <RouterLink :to="`/boreholes/${it.code}`">{{ it.code }}</RouterLink>
          </td>
          <td>{{ fmtDate(it.lastMeasuredAt) }}</td>
          <td><span class="badge" :class="it.level">{{ levelLabel(it.level) }}</span></td>
          <td>{{ it.maxAbsRate === null ? '—' : it.maxAbsRate.toFixed(2) }}</td>
          <td>{{ it.datumGroups }}</td>
          <td>
            <RouterLink :to="`/boreholes/${it.code}/upload`">
              <button class="secondary">上传测量</button>
            </RouterLink>
          </td>
        </tr>
        <tr v-if="!loading && items.length === 0">
          <td colspan="6" class="muted">还没有测孔，先<RouterLink to="/boreholes/new">录入一个</RouterLink>。</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
