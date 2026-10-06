<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import * as echarts from 'echarts';
import { api, ApiError, type HistoryResp, type MeasurementDetailResp } from '../api';
import EChart from '../components/EChart.vue';
import { fmtDateTime, levelColor, levelLabel } from '../format';
import { parseMeasurementText } from '@incli/shared';

const props = defineProps<{ id: string }>();
const detail = ref<MeasurementDetailResp | null>(null);
const history = ref<HistoryResp | null>(null);
const asOf = ref('');
const error = ref('');

// 更正表单
const correcting = ref(false);
const measuredAt = ref('');
const probeCode = ref('');
const text = ref('');
const datumReset = ref(false);
const datumReason = ref<'tube_repair' | 'probe_change' | 'manual_reset'>('probe_change');
const parseErrors = ref<string[]>([]);
const serverErrors = ref<string[]>([]);

async function load() {
  detail.value = await api.measurement(props.id);
  history.value = await api.history(props.id);
  measuredAt.value = detail.value.measurement.measuredAt.slice(0, 16);
  probeCode.value = detail.value.measurement.probeCode;
  datumReset.value = detail.value.measurement.datumReset;
}

async function queryAsOf() {
  if (!asOf.value) {
    history.value = await api.history(props.id);
  } else {
    history.value = await api.history(props.id, new Date(asOf.value).toISOString());
  }
}

function startCorrect() {
  correcting.value = true;
  // 预填原始读数（按 深度 正测 反测 输出）
  text.value = detail.value!.readings
    .map((r) => `${r.depth}\t${r.forward}\t${r.reverse}\t${r.probe_code_forward}\t${r.probe_code_reverse}`)
    .join('\n');
}

function onText() {
  parseErrors.value = parseMeasurementText(text.value).errors.map((e) => e.message);
}

async function submitCorrect() {
  serverErrors.value = [];
  const parsed = parseMeasurementText(text.value);
  if (parsed.errors.length) {
    parseErrors.value = parsed.errors.map((e) => e.message);
    return;
  }
  try {
    await api.correctMeasurement(props.id, {
      baseRevision: detail.value!.measurement.revision,
      measuredAt: new Date(measuredAt.value).toISOString(),
      probeCode: probeCode.value,
      datumReset: datumReset.value,
      datumReason: datumReset.value ? datumReason.value : undefined,
      readings: parsed.readings,
    });
    correcting.value = false;
    await load();
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      serverErrors.value = [`并发冲突：${e.fields.length ? '' : e.message}。请刷新取最新版本后重试。`];
    } else if (e instanceof ApiError) {
      serverErrors.value = e.fields.map((f) => `${f.field}：${f.message}`);
    } else {
      serverErrors.value = [(e as Error).message];
    }
  }
}

const checksumOption = computed<echarts.EChartsOption | null>(() => {
  if (!detail.value?.result) return null;
  const pts = detail.value.result.points;
  const med = [...pts.map((p) => p.checksum)].sort((a, b) => a - b)[Math.floor(pts.length / 2)]!;
  return {
    title: { text: '正反测校核和 forward + reverse（中位数横线，可疑点红色）', textStyle: { fontSize: 13 } },
    tooltip: { trigger: 'axis' },
    grid: { left: 70, right: 30, top: 50, bottom: 40 },
    xAxis: { type: 'value', name: '校核和' },
    yAxis: { type: 'value', name: '深度 (m)', inverse: true },
    series: [
      {
        type: 'scatter',
        data: pts.map((p) => ({
          value: [p.checksum, p.depth],
          itemStyle: { color: p.suspicious ? '#ef4444' : '#2563eb' },
        })),
        symbolSize: 9,
        markLine: {
          symbol: 'none',
          data: [{ xAxis: med, lineStyle: { color: '#9ca3af', type: 'dashed' }, label: { formatter: '中位数' } }],
        },
      },
    ],
  };
});

onMounted(load).catch((e) => (error.value = (e as Error).message));
</script>

<template>
  <div v-if="error" class="errors">{{ error }}</div>
  <template v-if="detail">
    <div class="panel">
      <div class="row" style="justify-content: space-between">
        <h2 style="margin: 0">
          测量详情
          <span class="muted" style="font-weight: 400">
            {{ detail.boreholeCode }} · {{ fmtDateTime(detail.measurement.measuredAt) }} · v{{ detail.measurement.revision }}
          </span>
        </h2>
        <button class="secondary" @click="startCorrect">更正本次测量</button>
      </div>
      <p v-if="detail.measurement.datumReset">
        <span class="badge red">基准段起点：{{ detail.measurement.datumReason }}</span>
      </p>
    </div>

    <div class="panel" v-if="history">
      <h2>历史判级：按当时 vs 按现在</h2>
      <table class="grid">
        <thead>
          <tr><th></th><th>等级</th><th>最大速率 (mm/d)</th><th>基于的测量版本</th><th>计算时间</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>按现在数据</td>
            <td><span class="badge" :class="history.current.level">{{ levelLabel(history.current.level) }}</span></td>
            <td>{{ history.current.maxAbsRate?.toFixed(2) }}</td>
            <td>v{{ history.current.revision }}</td>
            <td>{{ fmtDateTime(history.current.computedAt) }}</td>
          </tr>
          <tr :style="{ background: history.changed ? '#fffbeb' : undefined }">
            <td>按当时数据</td>
            <td><span class="badge" :class="history.asOf.level">{{ levelLabel(history.asOf.level) }}</span></td>
            <td>{{ history.asOf.maxAbsRate?.toFixed(2) }}</td>
            <td>v{{ history.asOf.revision }}</td>
            <td>{{ fmtDateTime(history.asOf.computedAt) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="row" style="margin-top: 10px">
        <label class="field" style="flex-direction: row; align-items: center; gap: 6px">
          查询某时刻（as-of）：
          <input type="datetime-local" v-model="asOf" />
        </label>
        <button class="secondary" @click="queryAsOf">查询</button>
        <span v-if="history.changed" class="badge yellow">两者不同：更正后等级已变化，旧判级保留可查</span>
      </div>
    </div>

    <div class="panel" v-if="correcting">
      <h2>更正（乐观锁：基于 v{{ detail.measurement.revision }}）</h2>
      <ul class="errors" v-if="parseErrors.length"><li v-for="(e, i) in parseErrors" :key="i">{{ e }}</li></ul>
      <ul class="errors" v-if="serverErrors.length"><li v-for="(e, i) in serverErrors" :key="'s' + i">{{ e }}</li></ul>
      <div class="row">
        <label class="field">测量时间
          <input type="datetime-local" v-model="measuredAt" />
        </label>
        <label class="field">缺省探头
          <input v-model="probeCode" />
        </label>
        <label class="field" style="flex-direction: row; align-items: center; gap: 6px; margin-top: 14px">
          <input type="checkbox" v-model="datumReset" /> 新基准段起点
        </label>
        <label class="field" v-if="datumReset">原因
          <select v-model="datumReason">
            <option value="tube_repair">测斜管受损修复</option>
            <option value="probe_change">更换探头</option>
            <option value="manual_reset">正式重设初始测量</option>
          </select>
        </label>
      </div>
      <p class="muted" style="margin-top: 10px">直接编辑下方读数（已预填），保存后受影响的剖面/速率/判级全部重算。</p>
      <textarea rows="14" v-model="text" @input="onText"></textarea>
      <div class="row" style="margin-top: 10px">
        <button @click="submitCorrect">提交更正</button>
        <button class="secondary" @click="correcting = false">取消</button>
      </div>
    </div>

    <div class="panel">
      <h2>校核和与可疑点</h2>
      <div class="chart"><EChart v-if="checksumOption" :option="checksumOption" /></div>
      <table class="grid" style="margin-top: 12px">
        <thead>
          <tr>
            <th>深度 (m)</th>
            <th>正测</th>
            <th>反测</th>
            <th>校核和</th>
            <th>正测探头/系数</th>
            <th>反测探头/系数</th>
            <th>累计位移 (mm)</th>
            <th>速率 (mm/d)</th>
            <th>可疑</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(p, i) in detail.result?.points ?? []" :key="i" :class="{ suspicious: p.suspicious }">
            <td>{{ p.depth }}</td>
            <td>{{ detail.readings[i]?.forward }}</td>
            <td>{{ detail.readings[i]?.reverse }}</td>
            <td>{{ p.checksum.toFixed(4) }}</td>
            <td>{{ p.usedProbeForward }} / {{ p.factorForward }}</td>
            <td>{{ p.usedProbeReverse }} / {{ p.factorReverse }}</td>
            <td>{{ p.relativeDisplacement.toFixed(2) }} <span class="muted">(拼 {{ p.connectedDisplacement.toFixed(2) }})</span></td>
            <td :style="{ color: levelColor(p.level) }">{{ p.rate === null ? '—' : p.rate.toFixed(2) }} {{ p.crossDatum ? '⚠跨基准' : '' }}</td>
            <td>{{ p.suspicious ? '⚠ 可疑（不剔除）' : '' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h2>计算结果版本（每次结果内容变化新增一条）</h2>
      <table class="grid">
        <thead><tr><th>计算时间</th><th>测量版本</th><th>内容指纹</th><th>等级</th><th>最大速率</th></tr></thead>
        <tbody>
          <tr v-for="s in detail.snapshotHistory" :key="s.contentHash + s.computedAt">
            <td>{{ fmtDateTime(s.computedAt) }}</td>
            <td>v{{ s.revision }}</td>
            <td class="muted">{{ s.contentHash }}</td>
            <td><span class="badge" :class="s.level">{{ levelLabel(s.level) }}</span></td>
            <td>{{ s.maxAbsRate?.toFixed(2) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </template>
</template>
