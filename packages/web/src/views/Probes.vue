<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, ApiError, type ProbeItem } from '../api';
import { fmtDateTime } from '../format';

const items = ref<ProbeItem[]>([]);
const error = ref('');
const newCode = ref('');
const newNote = ref('');

const calDraft = new Map<string, { effectiveAt: string; factor: number; note: string }>();
function draftFor(code: string) {
  if (!calDraft.has(code)) calDraft.set(code, { effectiveAt: new Date().toISOString().slice(0, 10), factor: 1, note: '' });
  return calDraft.get(code)!;
}
const correctingId = ref<string | null>(null);
const correction = ref({ baseRevision: 0, effectiveAt: '', factor: 1, note: '' });
const formErrors = ref<string[]>([]);

async function load() {
  items.value = (await api.probes()).items;
}

async function registerProbe() {
  formErrors.value = [];
  try {
    await api.createProbe({ code: newCode.value.trim(), note: newNote.value });
    newCode.value = '';
    newNote.value = '';
    await load();
  } catch (e) {
    collectErr(e);
  }
}

async function addCal(code: string) {
  formErrors.value = [];
  const d = draftFor(code);
  try {
    await api.addCalibration({ probeCode: code, effectiveAt: d.effectiveAt, factor: Number(d.factor), note: d.note });
    await load();
  } catch (e) {
    collectErr(e);
  }
}

function startCorrect(id: string, rev: number, effectiveAt: string, factor: number, note: string | null) {
  correctingId.value = id;
  correction.value = { baseRevision: rev, effectiveAt: effectiveAt.slice(0, 10), factor, note: note ?? '' };
}

async function submitCorrect() {
  formErrors.value = [];
  try {
    await api.correctCalibration(correctingId.value!, {
      baseRevision: correction.value.baseRevision,
      effectiveAt: new Date(correction.value.effectiveAt).toISOString(),
      factor: Number(correction.value.factor),
      note: correction.value.note,
    });
    correctingId.value = null;
    await load();
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) formErrors.value = ['并发冲突：该标定已被他人更正，请刷新后重试。'];
    else collectErr(e);
  }
}

function collectErr(e: unknown) {
  if (e instanceof ApiError) formErrors.value = e.fields.map((f) => `${f.field}：${f.message}`);
  else formErrors.value = [(e as Error).message];
}

onMounted(load);
</script>

<template>
  <div class="panel">
    <h2>探头登记与标定版本</h2>
    <ul class="errors" v-if="formErrors.length"><li v-for="(e, i) in formErrors" :key="i">{{ e }}</li></ul>

    <div class="row">
      <label class="field">新探头编号<input v-model="newCode" placeholder="如 P-03" /></label>
      <label class="field">备注<input v-model="newNote" /></label>
      <button @click="registerProbe">登记探头</button>
    </div>
  </div>

  <div class="panel" v-for="p in items" :key="p.probe.id">
    <h2>{{ p.probe.code }} <span class="muted" style="font-weight: 400">{{ p.probe.note ?? '' }}</span></h2>
    <table class="grid">
      <thead>
        <tr><th>生效时间</th><th>标定系数</th><th>版本</th><th>备注</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="c in p.calibrations" :key="c.id">
          <td>{{ fmtDateTime(c.effective_at) }}</td>
          <td>{{ c.factor }}</td>
          <td>v{{ c.revision }}</td>
          <td>{{ c.note ?? '' }}</td>
          <td>
            <button class="secondary" @click="startCorrect(c.id, c.revision, c.effective_at, c.factor, c.note)">更正</button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="correctingId && p.calibrations.some((c) => c.id === correctingId)" class="row" style="margin-top: 10px">
      <label class="field">新生效时间<input type="date" v-model="correction.effectiveAt" /></label>
      <label class="field">新系数<input type="number" step="0.0001" v-model.number="correction.factor" /></label>
      <label class="field">备注<input v-model="correction.note" /></label>
      <button @click="submitCorrect">提交更正（CAS）</button>
      <button class="secondary" @click="correctingId = null">取消</button>
    </div>

    <div class="row" style="margin-top: 10px">
      <label class="field">新生效时间<input type="date" v-model="draftFor(p.probe.code).effectiveAt" /></label>
      <label class="field">系数<input type="number" step="0.0001" v-model.number="draftFor(p.probe.code).factor" /></label>
      <label class="field">备注<input v-model="draftFor(p.probe.code).note" /></label>
      <button class="secondary" @click="addCal(p.probe.code)">增加标定版本</button>
    </div>
    <p class="muted" style="margin-top: 6px">
      解析测量时取测量时刻之前最近生效的版本；补录早期标定或更正标定后，使用该探头的全部测孔会自动重算。
    </p>
  </div>
</template>
