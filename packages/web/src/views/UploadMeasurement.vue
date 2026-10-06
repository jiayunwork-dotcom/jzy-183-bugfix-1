<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { parseMeasurementText, type DatumReason } from '@incli/shared';
import { api, ApiError, type ProbeItem } from '../api';

const props = defineProps<{ code: string }>();
const router = useRouter();
const probes = ref<ProbeItem[]>([]);

const measuredAt = ref(new Date().toISOString().slice(0, 10));
const probeCode = ref('');
const datumReset = ref(false);
const datumReason = ref<DatumReason>('probe_change');
const text = ref('');
const previewCount = ref(0);
const parseErrors = ref<{ field: string; message: string }[]>([]);
const serverErrors = ref<string[]>([]);
const submitting = ref(false);

function onText() {
  const parsed = parseMeasurementText(text.value);
  parseErrors.value = parsed.errors;
  previewCount.value = parsed.readings.length;
}

async function submit() {
  serverErrors.value = [];
  submitting.value = true;
  try {
    await api.addMeasurement(props.code, {
      text: text.value,
      measuredAt: measuredAt.value,
      probeCode: probeCode.value,
      datumReset: datumReset.value,
      datumReason: datumReset.value ? datumReason.value : undefined,
    });
    await router.push(`/boreholes/${props.code}`);
  } catch (e) {
    if (e instanceof ApiError) serverErrors.value = e.fields.map((f) => `${f.field}：${f.message}`);
    else serverErrors.value = [(e as Error).message];
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  probes.value = (await api.probes()).items;
  probeCode.value = probes.value[0]?.probe.code ?? '';
});
</script>

<template>
  <div class="panel">
    <h2>上传测量 — {{ code }}</h2>
    <ul class="errors" v-if="parseErrors.length">
      <li v-for="(e, i) in parseErrors" :key="'p' + i">{{ e.message }}</li>
    </ul>
    <ul class="errors" v-if="serverErrors.length">
      <li v-for="(e, i) in serverErrors" :key="'s' + i">{{ e }}</li>
    </ul>

    <div class="row">
      <label class="field">测量日期
        <input type="datetime-local" v-model="measuredAt" />
      </label>
      <label class="field">缺省探头
        <select v-model="probeCode">
          <option v-for="p in probes" :key="p.probe.id" :value="p.probe.code">{{ p.probe.code }}</option>
        </select>
      </label>
      <label class="field" style="flex-direction: row; align-items: center; gap: 6px; margin-top: 14px">
        <input type="checkbox" v-model="datumReset" />
        本次为新基准段起点
      </label>
      <label class="field" v-if="datumReset">原因
        <select v-model="datumReason">
          <option value="tube_repair">测斜管受损修复</option>
          <option value="probe_change">更换探头</option>
          <option value="manual_reset">正式重设初始测量</option>
        </select>
      </label>
    </div>

    <p class="muted" style="margin-top: 14px">
      粘贴测斜仪导出文本或表格，每行一个深度：<br />
      <code>深度 正测 反测 [探头正测] [探头反测]</code>
      ，支持 Tab / 逗号 / 分号 / 空格分隔。表头行会自动跳过；缺省探头使用上方选择。
    </p>
    <textarea v-model="text" @input="onText" rows="14"
      placeholder="0.5&#10;1.0&#10;…&#10;或&#10;0.5  123.45  876.55&#10;1.0  124.10  875.90"></textarea>
    <p class="muted" v-if="previewCount">识别到 {{ previewCount }} 行读数。</p>

    <button :disabled="submitting || parseErrors.length > 0" @click="submit">提交并重算</button>
  </div>
</template>
