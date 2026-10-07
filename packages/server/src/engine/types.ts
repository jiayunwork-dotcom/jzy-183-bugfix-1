import type { AlarmLevel, DatumReason, RatePoint, ThresholdEntry } from '@incli/shared';

/** 计算引擎看到的孔（已持久化形态）。 */
export interface EngineBorehole {
  id: string;
  code: string;
  /** 孔深（m）。 */
  depth: number;
  /** 测点间距（m）。 */
  spacing: number;
  thresholds: ThresholdEntry[];
  checksumTolerance: number;
}

export interface EngineCalibration {
  id: string;
  probeId: string;
  effectiveAtMs: number;
  factor: number;
}

export interface EngineProbe {
  id: string;
  code: string;
  calibrations: EngineCalibration[];
}

export interface EngineRow {
  depth: number;
  forward: number;
  reverse: number;
  probeCodeForward: string;
  probeCodeReverse: string;
}

export interface EngineMeasurement {
  id: string;
  measuredAtMs: number;
  /** 缺省探头编号（逐行探头缺省时使用）。 */
  probeCode: string;
  datumReset: boolean;
  datumReason: DatumReason;
  rows: EngineRow[];
  /**
   * 输入指纹：读数、测量时间、基准标记、生效系数等决定结果的输入改变时变化。
   * 增量重算据此判断该次测量结果是否可复用。
   */
  inputToken: string;
}

export interface PreparedPoint {
  depth: number;
  tilt: number;
  segmentDisplacement: number;
  cumulativeRaw: number;
  checksum: number;
  suspicious: boolean;
  usedProbeForward: string;
  usedProbeReverse: string;
  factorForward: number;
  factorReverse: number;
}

export interface PreparedMeasurement {
  measurement: EngineMeasurement;
  points: PreparedPoint[];
}

export interface ResolvedMeasurements {
  borehole: EngineBorehole;
  prepared: PreparedMeasurement[];
}

/** 引擎产出的逐次结果（不含存储字段）。 */
export interface ComputedResult {
  measurementId: string;
  revision: number;
  measuredAtMs: number;
  datumIndex: number;
  ordinalInDatum: number;
  relativeBaseMeasurementId: string | null;
  /**
   * 本基准段相对第 0 段的逐深度拼接偏移（mm，与 points 同序）。
   * connected[i] = relativeDisplacements[i] + datumAnchor[i]。
   * 第 0 段为全 0；其余段在段内基准处按上一段末测逐深度对齐（见 docs/datum.md）。
   */
  datumAnchor: number[];
  relativeDisplacements: number[];
  connectedDisplacements: number[];
  cumulativeRaw: number[];
  checksums: number[];
  suspicious: boolean[];
  usedProbeForward: string[];
  usedProbeReverse: string[];
  factorForward: number[];
  factorReverse: number[];
  rates: (number | null)[];
  pointLevels: AlarmLevel[];
  crossDatum: boolean[];
  maxAbsRate: number | null;
  level: AlarmLevel;
}

export interface EngineBoundary {
  measurementId: string;
  measuredAtMs: number;
  datumIndex: number;
  reason: DatumReason;
  /** 逐深度拼接偏移（mm）；同时给出按深度对齐前、上一段末测的原始逐深度差异。 */
  anchor: number[];
  /** 对齐前新基准复测与上一段末测的逐深度原始差异 C(reset)−C(prev_last)，诊断用。 */
  rawOffset: number[];
}

export interface FullComputeOutput {
  results: ComputedResult[];
  boundaries: EngineBoundary[];
}

export interface IncrementalResult extends ComputedResult {
  /** 输入未变且连接值也未变（速率同样可复用）。 */
  unchanged: boolean;
}

export interface IncrementalComputeOutput {
  results: IncrementalResult[];
  boundaries: EngineBoundary[];
}

export type { RatePoint };
