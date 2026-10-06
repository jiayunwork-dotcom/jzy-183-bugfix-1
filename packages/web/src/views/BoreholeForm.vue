<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, ApiError } from '../api';
import type { ThresholdEntry } from '@incli/shared';

const router = useRouter();
const code = ref('');
const depth = ref(20);
const spacing = ref(0.5);
const positiveDirection = ref('');
const checksumTolerance = ref(0.05);
const thresholds = ref<ThresholdEntry[]>([
  { depth: 0.5, blue: 1, yellow: 2, red: 4 },
  { depth: 20, blue: 1, yellow: 2, red: 4 },
]);
const errors = ref<string[]>([]);
const submitting = ref(false);

function addThreshold() {
  thresholds.value.push({ depth: depth.value / 2, blue: 1, yellow: 2, red: 4 });
}
function removeThreshold(i: number) {
  thresholds.value.splice(i, 1);
}

async function submit() {
  errors.value = [];
  submitting.value = true;
  try {
    await api.createBorehole({
      code: code.value.trim(),
      depth: Number(depth.value),
      spacing: Number(spacing.value),
      positiveDirection: positiveDirection.value.trim(),
      checksumTolerance: Number(checksumTolerance.value),
      thresholds: thresholds.value.map((t) => ({
        depth: Number(t.depth),
        blue: Number(t.blue),
        yellow: Number(t.yellow),
        red: Number(t.red),
      })),
    });
    await router.push(`/boreholes/${code.value.trim()}`);
  } catch (e) {
    if (e instanceof ApiError) errors.value = e.fields.map((f) => `${f.field}：${f.message}`);
    else errors.value = [(e as Error).message];
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="panel">
    <h2>录入测孔</h2>
    <ul class="errors" v-if="errors.length">
      <li v-for="(e, i) in errors" :key="i">{{ e }}</li>
    </ul>
    <div class="row">
      <label class="field">编号
        <input v-model="code" placeholder="如 ZQT-03" />
      </label>
      <label class="field">孔深 (m)
        <input v-model.number="depth" type="number" step="0.5" min="0" />
      </label>
      <label class="field">测点间距 (m)
        <input v-model.number="spacing" type="number" step="0.1" min="0" />
      </label>
      <label class="field">正方向朝向
        <input v-model="positiveDirection" placeholder="如 N23°E" />
      </label>
      <label class="field">校核和容差（读数单位）
        <input v-model.number="checksumTolerance" type="number" step="0.01" min="0" />
      </label>
    </div>

    <h2 style="margin-top: 18px">速率报警分级阈值 (mm/d)</h2>
    <p class="muted">
      按深度给出代表值，中间深度线性插值。每一行必须满足 蓝 &lt; 黄 &lt; 红。
    </p>
    <table class="grid">
      <thead>
        <tr>
          <th style="width: 120px">深度 (m)</th>
          <th>蓝</th>
          <th>黄</th>
          <th>红</th>
          <th style="width: 80px"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(t, i) in thresholds" :key="i">
          <td><input v-model.number="t.depth" type="number" step="0.5" /></td>
          <td><input v-model.number="t.blue" type="number" step="0.1" min="0" /></td>
          <td><input v-model.number="t.yellow" type="number" step="0.1" min="0" /></td>
          <td><input v-model.number="t.red" type="number" step="0.1" min="0" /></td>
          <td><button class="secondary" @click="removeThreshold(i)">删除</button></td>
        </tr>
      </tbody>
    </table>
    <p><button class="secondary" @click="addThreshold">+ 增加一条深度阈值</button></p>

    <button :disabled="submitting" @click="submit">保存</button>
  </div>
</template>
