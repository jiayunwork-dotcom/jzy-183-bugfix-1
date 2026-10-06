/**
 * Shared domain types used by both backend and frontend.
 *
 * Depth units: metres (m) at the API / UI boundary.
 * Displacement: millimetres (mm). Rate: mm/day.
 */

export type Direction = 'A' | 'B';
/** 正测 = forward run, 反测 = reverse run. */
export type RunKind = 'forward' | 'reverse';
export type AlarmLevel = 'none' | 'blue' | 'yellow' | 'red';
export type DatumReason = 'initial' | 'tube_repair' | 'probe_change' | 'manual_reset';

/** 速率报警分级阈值（蓝 / 黄 / 红，mm/d），按深度给出。 */
export interface ThresholdEntry {
  /** 该阈值适用的深度（m，从孔口起算）。 */
  depth: number;
  blue: number;
  yellow: number;
  red: number;
}

export interface BoreholeInput {
  code: string;
  /** 孔深（m）。 */
  depth: number;
  /** 测点间距（m），通常 0.5。 */
  spacing: number;
  /** 正方向朝向描述，如 "N23°E"。 */
  positiveDirection: string;
  thresholds: ThresholdEntry[];
  /** 校核和可疑判定的容差（读数单位）。 */
  checksumTolerance: number;
}

/** 一次上传/更正中的单个深度读数行。 */
export interface ReadingInput {
  /** 深度（m，从孔口起算，必须按测点间距等间距）。 */
  depth: number;
  forward: number;
  reverse: number;
  /** 本行正测所用探头；缺省用整次测量的探头。 */
  probeCodeForward?: string;
  probeCodeReverse?: string;
}

export interface MeasurementInput {
  boreholeCode?: string;
  /** 测量时刻（ISO 8601，或 yyyy-mm-dd，按 UTC 当日 00:00）。 */
  measuredAt: string;
  /** 整次测量缺省探头编号。 */
  probeCode: string;
  /** 标记为新基准段起点（测斜管修复 / 换探头 / 正式重设初始）。 */
  datumReset?: boolean;
  datumReason?: DatumReason;
  readings: ReadingInput[];
}

export interface ProbeInput {
  code: string;
  note?: string;
}

export interface CalibrationInput {
  probeCode: string;
  /** 生效时间；解析测量时取 measuredAt 之前最近生效的版本。 */
  effectiveAt: string;
  /** 组合标定系数：tilt = (forward - reverse) * factor。 */
  factor: number;
  note?: string;
}

/** 逐深度计算点。 */
export interface ProfilePoint {
  depth: number;
  /** 相对本基准段初始测量的累计位移（mm）。 */
  relativeDisplacement: number;
  /** 跨基准段拼接后的连续位移（mm）。 */
  connectedDisplacement: number;
  /** 原始累计（相对孔底，读数*系数*段长累加，mm），诊断用。 */
  cumulativeRaw: number;
  /** 正反测校核和 forward + reverse（原始读数单位）。 */
  checksum: number;
  suspicious: boolean;
  /** 相对前一次测量的位移速率（mm/d）。 */
  rate: number | null;
  /** 该深度按速率命中的等级。 */
  level: AlarmLevel;
  usedProbeForward: string;
  usedProbeReverse: string;
  factorForward: number;
  factorReverse: number;
}

export interface RatePoint {
  depth: number;
  rate: number;
  level: AlarmLevel;
  /** 该速率跨越了基准切换，标记供展示。 */
  crossDatum: boolean;
}

export interface MeasurementResult {
  measurementId: string;
  boreholeId: string;
  revision: number;
  datumIndex: number;
  /** 在本基准段内的序号（0 = 段内基准）。 */
  ordinalInDatum: number;
  maxAbsRate: number | null;
  level: AlarmLevel;
  relativeBaseMeasurementId: string | null;
  /** 与上一段拼接使用的标量偏移（mm），段内基准以外为 0。 */
  datumAnchor: number;
  crossDatumRate: boolean;
  points: ProfilePoint[];
}

export interface DatumBoundary {
  measurementId: string;
  measuredAt: string;
  datumIndex: number;
  reason: DatumReason;
  anchor: number;
}

export interface ComputeBoreholeResult {
  boreholeId: string;
  results: MeasurementResult[];
  boundaries: DatumBoundary[];
  computedAt: string;
}

/** 存储层中一次测量的计算结果（含原始行）。 */
export interface StoredMeasurementResult extends MeasurementResult {
  measuredAt: string;
  boreholeCode: string;
  /** 速率只到点级 level；整体 level 单独存。 */
}

export interface FieldError {
  field: string;
  message: string;
  value?: unknown;
}

export interface ValidationFailure {
  errors: FieldError[];
}
