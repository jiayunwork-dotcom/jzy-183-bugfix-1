import type {
  BoreholeInput,
  CalibrationInput,
  FieldError,
  MeasurementInput,
  ProbeInput,
  ReadingInput,
  ThresholdEntry,
} from '@incli/shared';
import { validateDepthGrid } from '../engine/index.js';

/** ISO 8601 或 yyyy-mm-dd（按 UTC 当日 00:00）。 */
export function parseTimestamp(value: string): number {
  if (typeof value !== 'string' || value.trim() === '') return Number.NaN;
  let s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s = `${s}T00:00:00.000Z`;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? Number.NaN : ms;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function validateThresholds(thresholds: ThresholdEntry[]): FieldError[] {
  const errors: FieldError[] = [];
  if (!Array.isArray(thresholds) || thresholds.length === 0) {
    errors.push({ field: 'thresholds', message: '至少需要一条阈值（蓝/黄/红）' });
    return errors;
  }
  thresholds.forEach((th, i) => {
    if (!isFiniteNumber(th.depth) || th.depth <= 0) {
      errors.push({ field: `thresholds[${i}].depth`, message: '阈值深度必须为正数', value: th.depth });
    }
    for (const k of ['blue', 'yellow', 'red'] as const) {
      if (!isFiniteNumber(th[k]) || th[k] < 0) {
        errors.push({ field: `thresholds[${i}].${k}`, message: `${k} 阈值必须为非负有限数`, value: th[k] });
      }
    }
    if (isFiniteNumber(th.blue) && isFiniteNumber(th.yellow) && isFiniteNumber(th.red)) {
      // 拒收：阈值不是递增（蓝 < 黄 < 红）
      if (!(th.blue < th.yellow && th.yellow < th.red)) {
        errors.push({
          field: `thresholds[${i}]`,
          message: `阈值必须严格递增 蓝(${th.blue}) < 黄(${th.yellow}) < 红(${th.red})`,
        });
      }
    }
  });
  const depths = thresholds.map((t) => t.depth);
  const sorted = [...depths].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) {
      errors.push({ field: 'thresholds', message: `阈值深度 ${sorted[i]} m 重复` });
    }
  }
  return errors;
}

export function validateBoreholeInput(input: Partial<BoreholeInput>): FieldError[] {
  const errors: FieldError[] = [];
  if (!input.code || typeof input.code !== 'string' || input.code.trim() === '') {
    errors.push({ field: 'code', message: '测孔编号必填' });
  }
  if (!isFiniteNumber(input.depth) || input.depth <= 0) {
    errors.push({ field: 'depth', message: '孔深必须为正数（m）', value: input.depth });
  }
  if (!isFiniteNumber(input.spacing) || input.spacing <= 0) {
    errors.push({ field: 'spacing', message: '测点间距必须为正数（m）', value: input.spacing });
  }
  if (isFiniteNumber(input.depth) && isFiniteNumber(input.spacing) && input.spacing > 0) {
    if (Math.abs(Math.round(input.depth / input.spacing) * input.spacing - input.depth) > 1e-6) {
      errors.push({ field: 'spacing', message: `孔深 ${input.depth} 不是间距 ${input.spacing} 的整数倍` });
    }
  }
  if (!input.positiveDirection || String(input.positiveDirection).trim() === '') {
    errors.push({ field: 'positiveDirection', message: '正方向朝向必填' });
  }
  if (!isFiniteNumber(input.checksumTolerance) || input.checksumTolerance < 0) {
    errors.push({ field: 'checksumTolerance', message: '校核和容差必须为非负数', value: input.checksumTolerance });
  }
  errors.push(...validateThresholds(input.thresholds ?? []));
  return errors;
}

/**
 * 逐读数校验（不含需要存储的跨实体校验：探头登记、日期早于初始——由 service 做）。
 * 拒收：同一深度两次、读数不是有限数、深度不等间距或与孔深不符。
 */
export function validateReadings(readings: ReadingInput[], depth: number, spacing: number): FieldError[] {
  const errors: FieldError[] = [];
  if (!Array.isArray(readings) || readings.length === 0) {
    errors.push({ field: 'readings', message: '至少需要一行读数' });
    return errors;
  }
  readings.forEach((r, i) => {
    if (!isFiniteNumber(r.depth) || r.depth <= 0) {
      errors.push({ field: `readings[${i}].depth`, message: '深度必须为正数', value: r.depth });
    }
    if (!isFiniteNumber(r.forward)) {
      errors.push({ field: `readings[${i}].forward`, message: '正测读数不是有限数', value: r.forward });
    }
    if (!isFiniteNumber(r.reverse)) {
      errors.push({ field: `readings[${i}].reverse`, message: '反测读数不是有限数', value: r.reverse });
    }
  });
  if (errors.some((e) => e.field.endsWith('.depth'))) return errors;

  const { errors: gridErrors } = validateDepthGrid(
    readings.map((r) => r.depth),
    depth,
    spacing,
  );
  for (const msg of gridErrors) {
    errors.push({ field: 'readings', message: msg });
  }
  return errors;
}

export function validateMeasurementShape(input: Partial<MeasurementInput>, depth: number, spacing: number): FieldError[] {
  const errors: FieldError[] = [];
  if (!input.measuredAt || Number.isNaN(parseTimestamp(String(input.measuredAt)))) {
    errors.push({ field: 'measuredAt', message: '测量日期无法解析（需要 ISO 8601 或 yyyy-mm-dd）', value: input.measuredAt });
  }
  if (!input.probeCode || String(input.probeCode).trim() === '') {
    errors.push({ field: 'probeCode', message: '缺省探头编号必填' });
  }
  if (input.datumReset === true && !input.datumReason) {
    errors.push({ field: 'datumReason', message: '标记新基准时必须给出原因（tube_repair/probe_change/manual_reset）' });
  }
  if (input.datumReason && !['tube_repair', 'probe_change', 'manual_reset', 'initial'].includes(input.datumReason)) {
    errors.push({ field: 'datumReason', message: '基准原因不合法', value: input.datumReason });
  }
  errors.push(...validateReadings(input.readings ?? [], depth, spacing));
  return errors;
}

export function validateProbeInput(input: Partial<ProbeInput>): FieldError[] {
  if (!input.code || String(input.code).trim() === '') {
    return [{ field: 'code', message: '探头编号必填' }];
  }
  return [];
}

export function validateCalibrationInput(input: Partial<CalibrationInput>): FieldError[] {
  const errors: FieldError[] = [];
  if (!input.probeCode || String(input.probeCode).trim() === '') {
    errors.push({ field: 'probeCode', message: '探头编号必填' });
  }
  if (!input.effectiveAt || Number.isNaN(parseTimestamp(String(input.effectiveAt)))) {
    errors.push({ field: 'effectiveAt', message: '生效时间无法解析', value: input.effectiveAt });
  }
  if (!isFiniteNumber(input.factor) || (input.factor as number) <= 0) {
    errors.push({ field: 'factor', message: '标定系数必须为正的有限数', value: input.factor });
  }
  return errors;
}
