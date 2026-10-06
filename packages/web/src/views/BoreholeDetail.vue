<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import * as echarts from 'echarts';
import { api, type BoreholeDetail, type OverlayResp } from '../api';
import EChart from '../components/EChart.vue';
import { fmtDate, fmtDateTime, levelColor, levelLabel } from '../format';

const props = defineProps<{ code: string }>();
const detail = ref<BoreholeDetail | null>(null);
const overlay = ref<OverlayResp | null>(null);
const selected = ref<Set<string>>(new Set());
const connected = ref(true);
const depth = ref<number | null>(null);
const depthHistory = ref<Awaited<ReturnType<typeof api.depthHistory>> | null>(null);
const error = ref('');

async function load() {
  error.value = '';
  try {
    detail.value = await api.borehole(props.code);
    if (selected.value.size === 0) {
      // 默认选最近 5 次
      detail.value.measurements.slice(-5).forEach((m) => selected.value.add(m.id));
    }
    depth.value = detail.value.borehole.spacing;
    await loadOverlay();
    await loadDepthHistory();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function loadOverlay() {
  const ids = detail.value ? [...selected.value].filter((id) => selected.value.has(id)) : [];
  overlay.value = await api.overlay(props.code, ids.length ? ids : [], connected.value);
}

async function loadDepthHistory() {
  if (depth.value === null) return;
  depthHistory.value = await api.depthHistory(props.code, depth.value, connected.value);
}

function toggle(id: string) {
  if (selected.value.has(id)) selected.value.delete(id);
  else selected.value.add(id);
  void loadOverlay();
}

const profileOption = computed<echarts.EChartsOption | null>(() => {
  if (!overlay.value) return null;
  const series: echarts.SeriesOption[] = overlay.value.series.map((s) => ({
    name: fmtDate(s.measuredAt) + (s.datumReset ? ' ★基准切换' : ''),
    type: 'line',
    data: s.values.map((v, i) => [v, s.depths[i]]),
    symbol: 'none',
    lineStyle: { width: s.datumReset ? 3 : 1.5 },
    emphasis: { focus: 'series' },
  }));
  // 基准切换竖线：标注在每条边界测量的连接位移起点（取中位数位置）
  const markLines = overlay.value.boundaries.map((b) => {
    const s = overlay.value!.series.find((x) => x.measurementId === b.measurementId);
    const x = s ? s.values[Math.floor(s.values.length / 2)] : 0;
    return {
      xAxis: x ?? 0,
      label: { formatter: `基准#${b.datumIndex} ${fmtDate(b.measuredAt)}`, position: 'insideEndTop' },
      lineStyle: { color: '#ef4444', type: 'dashed' as const, width: 2 },
    };
  });
  if (series[0]) (series[0] as echarts.LineSeriesOption).markLine = { symbol: 'none', data: markLines, silent: true };

  return {
    title: { text: `位移剖面叠加（${connected.value ? '跨基准拼接' : '段内相对'}）`, textStyle: { fontSize: 14 } },
    tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
    legend: { type: 'scroll', top: 24, textStyle: { fontSize: 11 } },
    grid: { left: 60, right: 30, top: 70, bottom: 40 },
    xAxis: { type: 'value', name: '位移 (mm)', nameLocation: 'middle', nameGap: 26 },
    yAxis: { type: 'value', name: '深度 (m)', inverse: true },
    series,
  };
});

const historyOption = computed<echarts.EChartsOption | null>(() => {
  if (!depthHistory.value) return null;
  const pts = depthHistory.value.points;
  return {
    title: { text: `深度 ${depthHistory.value.depth} m：位移与速率随时间`, textStyle: { fontSize: 14 } },
    tooltip: { trigger: 'axis' },
    legend: { top: 24 },
    grid: { left: 60, right: 70, top: 70, bottom: 40 },
    xAxis: { type: 'category', data: pts.map((p) => fmtDate(p.measuredAt)) },
    yAxis: [
      { type: 'value', name: '位移 (mm)' },
      { type: 'value', name: '速率 (mm/d)' },
    ],
    series: [
      {
        name: '位移',
        type: 'line',
        data: pts.map((p) => Number(p.displacement.toFixed(3))),
        yAxisIndex: 0,
        itemStyle: { color: '#2563eb' },
      },
      {
        name: '速率',
        type: 'bar',
        data: pts.map((p) => (p.rate === null ? null : Number(p.rate.toFixed(3)))),
        yAxisIndex: 1,
        itemStyle: { color: (p) => levelColor(pts[p.dataIndex]!.level) },
        markPoint: {
          symbol: 'circle',
          data: pts
            .map((p, i) => (p.level !== 'none' ? { coord: [i, p.rate], itemStyle: { color: levelColor(p.level) } } : null))
            .filter(Boolean) as never,
        },
      },
    ],
  };
});

onMounted(load);
watch(connected, () => {
  void loadOverlay();
  void loadDepthHistory();
});
watch(depth, () => void loadDepthHistory());
</script>

<template>
  <div v-if="error" class="errors">{{ error }}</div>
  <template v-if="detail">
    <div class="panel">
      <div class="row" style="justify-content: space-between">
        <h2 style="margin: 0">
          {{ detail.borehole.code }}
          <span class="muted" style="font-weight: 400; font-size: 13px">
            孔深 {{ detail.borehole.depth }} m · 间距 {{ detail.borehole.spacing }} m · 正方向 {{ detail.borehole.positiveDirection }}
          </span>
        </h2>
        <RouterLink :to="`/boreholes/${detail.borehole.code}/upload`">
          <button>上传一次测量</button>
        </RouterLink>
      </div>
      <table class="grid" style="margin-top: 10px">
        <thead>
          <tr><th>深度(m)</th><th>蓝</th><th>黄</th><th>红</th></tr>
        </thead>
        <tbody>
          <tr v-for="t in detail.borehole.thresholds" :key="t.depth">
            <td>{{ t.depth }}</td><td>{{ t.blue }}</td><td>{{ t.yellow }}</td><td>{{ t.red }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h2>测量记录</h2>
      <table class="grid">
        <thead>
          <tr>
            <th style="width: 40px">叠加</th>
            <th>测量时间</th>
            <th>探头</th>
            <th>基准</th>
            <th>版本</th>
            <th>当前等级</th>
            <th>最大速率</th>
            <th>校核可疑点</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in detail.measurements" :key="m.id">
            <td><input type="checkbox" :checked="selected.has(m.id)" @change="toggle(m.id)" /></td>
            <td>{{ fmtDateTime(m.measuredAt) }}</td>
            <td>{{ m.probeCode }}</td>
            <td>
              <span v-if="m.datumReset" class="badge red">基准 #{{ m.result?.datumIndex }}（{{ m.datumReason }}）</span>
              <span v-else class="muted">段 #{{ m.result?.datumIndex }}</span>
            </td>
            <td>v{{ m.revision }}</td>
            <td>
              <span class="badge" :class="m.result?.level ?? 'none'">
                {{ levelLabel(m.result?.level ?? 'none') }}
              </span>
            </td>
            <td>{{ m.result?.maxAbsRate === null || m.result?.maxAbsRate === undefined ? '—' : m.result.maxAbsRate.toFixed(2) }}</td>
            <td>{{ m.result ? m.result.points.filter((p) => p.suspicious).length : 0 }}</td>
            <td>
              <RouterLink :to="`/measurements/${m.id}`"><button class="secondary">详情</button></RouterLink>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="panel">
      <div class="row" style="justify-content: space-between; margin-bottom: 8px">
        <h2 style="margin: 0">位移剖面（勾选上方测量叠加，红色虚线为基准切换位置）</h2>
        <label class="field" style="flex-direction: row; align-items: center; gap: 6px">
          <input type="checkbox" v-model="connected" />
          跨基准拼接位移（取消则显示段内相对位移）
        </label>
      </div>
      <div class="chart tall"><EChart v-if="profileOption" :option="profileOption" /></div>
    </div>

    <div class="panel">
      <div class="row" style="align-items: center; gap: 10px; margin-bottom: 8px">
        <h2 style="margin: 0">某深度随时间的位移与速率</h2>
        <label class="field" style="flex-direction: row; align-items: center; gap: 6px">
          深度
          <select v-model.number="depth">
            <option v-for="d in detail.borehole.thresholds" :key="d.depth" :value="d.depth" hidden></option>
          </select>
          <input type="number" v-model.number="depth" :step="detail.borehole.spacing" :min="detail.borehole.spacing" :max="detail.borehole.depth" style="width: 90px" />
          m
        </label>
      </div>
      <div class="chart"><EChart v-if="historyOption" :option="historyOption" /></div>
    </div>
  </template>
</template>
