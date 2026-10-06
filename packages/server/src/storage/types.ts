import type { DatumReason, ThresholdEntry } from '@incli/shared';

export interface ProbeRow {
  id: string;
  code: string;
  note: string | null;
  created_at: string;
}

export interface CalibrationRow {
  id: string;
  probe_id: string;
  effective_at: string;
  effective_at_ms: number;
  factor: number;
  note: string | null;
  /** 标定记录也按版本保留；更正走 CAS。 */
  revision: number;
  superseded: boolean;
  created_at: string;
  updated_at: string;
}

export interface BoreholeRow {
  id: string;
  code: string;
  depth: number;
  spacing: number;
  positive_direction: string;
  checksum_tolerance: number;
  created_at: string;
}

export interface MeasurementRow {
  id: string;
  borehole_id: string;
  measured_at: string;
  measured_at_ms: number;
  probe_code: string;
  datum_reset: boolean;
  datum_reason: DatumReason;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface ReadingRow {
  id: string;
  measurement_id: string;
  depth: number;
  forward: number;
  reverse: number;
  probe_code_forward: string;
  probe_code_reverse: string;
  ord: number;
}

/** 落库的计算结果（逐数值序列）。 */
export interface SnapshotRow {
  id: string;
  measurement_id: string;
  /** 结果内容指纹；内容不变时不新增快照，保证“当时/现在”查询稳定。 */
  content_hash: string;
  revision_at_compute: number;
  result_json: ResultJson;
  computed_at: string;
  computed_at_ms: number;
}

export interface ResultPointJson {
  depth: number;
  relativeDisplacement: number;
  connectedDisplacement: number;
  cumulativeRaw: number;
  checksum: number;
  suspicious: boolean;
  rate: number | null;
  level: string;
  crossDatum: boolean;
  usedProbeForward: string;
  usedProbeReverse: string;
  factorForward: number;
  factorReverse: number;
}

export interface ResultJson {
  measurementId: string;
  boreholeId: string;
  revision: number;
  measuredAtMs: number;
  measuredAt: string;
  datumIndex: number;
  ordinalInDatum: number;
  relativeBaseMeasurementId: string | null;
  datumAnchor: number;
  maxAbsRate: number | null;
  level: string;
  crossDatumRate: boolean;
  points: ResultPointJson[];
}

export interface DatumBoundaryJson {
  measurementId: string;
  measuredAt: string;
  datumIndex: number;
  reason: DatumReason;
  anchor: number;
}

export interface BoreholeThresholdRow {
  id: string;
  borehole_id: string;
  depth: number;
  blue: number;
  yellow: number;
  red: number;
}

export interface BoreholeAggregate {
  borehole: BoreholeRow;
  thresholds: ThresholdEntry[];
  measurements: MeasurementRow[];
  readings: ReadingRow[];
  snapshots: SnapshotRow[];
}

export interface Tx {
  /** 实现持有的数据库会话（pg.PoolClient 或内存锁对象）。 */
  readonly kind: 'pg' | 'memory';
}

export interface Repository {
  withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;

  findProbeByCode(tx: Tx, code: string): Promise<ProbeRow | null>;
  listProbes(tx: Tx): Promise<ProbeRow[]>;
  insertProbe(tx: Tx, row: ProbeRow): Promise<void>;

  insertCalibration(tx: Tx, row: CalibrationRow): Promise<void>;
  listCalibrationsByProbe(tx: Tx, probeId: string): Promise<CalibrationRow[]>;
  listAllCalibrations(tx: Tx): Promise<CalibrationRow[]>;
  /**
   * 更正标定：仅当 revision = expectedRevision 时生效，原子 CAS。
   * 返回 false 表示已有并发更正先提交。
   */
  updateCalibrationRevisioned(
    tx: Tx,
    id: string,
    expectedRevision: number,
    patch: { effectiveAtMs: number; factor: number; note: string | null },
    updatedAt: string,
  ): Promise<boolean>;

  findBoreholeByCode(tx: Tx, code: string): Promise<BoreholeRow | null>;
  findBoreholeById(tx: Tx, id: string): Promise<BoreholeRow | null>;
  listBoreholes(tx: Tx): Promise<BoreholeRow[]>;
  insertBorehole(tx: Tx, row: BoreholeRow, thresholds: ThresholdEntry[]): Promise<void>;

  findMeasurementById(tx: Tx, id: string): Promise<MeasurementRow | null>;
  insertMeasurement(tx: Tx, row: MeasurementRow, readings: ReadingRow[]): Promise<void>;
  /** 原子 CAS 更正测量；返回 false 表示版本冲突。 */
  updateMeasurementRevisioned(
    tx: Tx,
    id: string,
    expectedRevision: number,
    patch: { measuredAtMs: number; probeCode: string; datumReset: boolean; datumReason: DatumReason },
    readings: ReadingRow[],
    updatedAt: string,
  ): Promise<boolean>;

  getBoreholeAggregate(tx: Tx, boreholeId: string): Promise<BoreholeAggregate>;
  getAllAggregates(tx: Tx): Promise<BoreholeAggregate[]>;

  /** 只在 content_hash 变化时写入新快照（事务内唯一约束兜底）。 */
  insertSnapshotIfNewer(tx: Tx, row: SnapshotRow): Promise<boolean>;
  listSnapshotsByMeasurement(tx: Tx, measurementId: string): Promise<SnapshotRow[]>;
  getLatestSnapshot(tx: Tx, measurementId: string): Promise<SnapshotRow | null>;
}
