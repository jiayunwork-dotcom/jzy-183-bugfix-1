import type { ThresholdEntry } from '@incli/shared';
import { randomUUID } from 'node:crypto';
import type {
  BoreholeAggregate,
  BoreholeRow,
  BoreholeThresholdRow,
  CalibrationRow,
  MeasurementRow,
  ProbeRow,
  ReadingRow,
  Repository,
  SnapshotRow,
  Tx,
} from './types.js';

/**
 * 内存仓库：行为与 Postgres 仓库一致（含原子 CAS），供领域服务测试。
 * withTx 内持有一把简单的串行锁，CAS 直接比较版本号，模拟事务语义。
 */
export class MemoryRepository implements Repository {
  private probes = new Map<string, ProbeRow>();
  private calibrations = new Map<string, CalibrationRow>();
  private boreholes = new Map<string, BoreholeRow>();
  private thresholds = new Map<string, BoreholeThresholdRow[]>();
  private measurements = new Map<string, MeasurementRow>();
  private readings = new Map<string, ReadingRow[]>();
  private snapshots = new Map<string, SnapshotRow[]>();
  /** 统计 CAS 尝试次数（成功/失败），并发测试用。 */
  casAttempts = 0;
  private queue: Promise<unknown> = Promise.resolve();

  async withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    // 串行化所有事务：两个并发更正只有一个能先完成 CAS。
    const run = this.queue.then(async () => {
      const tx: Tx = { kind: 'memory' };
      return await fn(tx);
    });
    this.queue = run.catch(() => {});
    return await run;
  }

  async findProbeByCode(_tx: Tx, code: string): Promise<ProbeRow | null> {
    return this.probes.get(code) ?? null;
  }

  async listProbes(_tx: Tx): Promise<ProbeRow[]> {
    return [...this.probes.values()];
  }

  async insertProbe(_tx: Tx, row: ProbeRow): Promise<void> {
    this.probes.set(row.code, row);
  }

  async insertCalibration(_tx: Tx, row: CalibrationRow): Promise<void> {
    this.calibrations.set(row.id, {
      ...row,
      effective_at_ms: row.effective_at_ms || new Date(row.effective_at).getTime(),
    });
  }

  async listCalibrationsByProbe(_tx: Tx, probeId: string): Promise<CalibrationRow[]> {
    return [...this.calibrations.values()]
      .filter((c) => c.probe_id === probeId && !c.superseded)
      .sort((a, b) => a.effective_at_ms - b.effective_at_ms);
  }

  async listAllCalibrations(_tx: Tx): Promise<CalibrationRow[]> {
    return [...this.calibrations.values()].filter((c) => !c.superseded);
  }

  async updateCalibrationRevisioned(
    _tx: Tx,
    id: string,
    expectedRevision: number,
    patch: { effectiveAtMs: number; factor: number; note: string | null },
    updatedAt: string,
  ): Promise<boolean> {
    this.casAttempts++;
    const row = this.calibrations.get(id);
    if (!row || row.revision !== expectedRevision) return false;
    row.revision += 1;
    row.effective_at_ms = patch.effectiveAtMs;
    row.effective_at = new Date(patch.effectiveAtMs).toISOString();
    row.factor = patch.factor;
    row.note = patch.note;
    row.updated_at = updatedAt;
    return true;
  }

  async findBoreholeByCode(_tx: Tx, code: string): Promise<BoreholeRow | null> {
    for (const b of this.boreholes.values()) if (b.code === code) return b;
    return null;
  }

  async findBoreholeById(_tx: Tx, id: string): Promise<BoreholeRow | null> {
    return this.boreholes.get(id) ?? null;
  }

  async listBoreholes(_tx: Tx): Promise<BoreholeRow[]> {
    return [...this.boreholes.values()];
  }

  async insertBorehole(_tx: Tx, row: BoreholeRow, thresholds: ThresholdEntry[]): Promise<void> {
    this.boreholes.set(row.id, row);
    this.thresholds.set(
      row.id,
      thresholds.map((t) => ({
        id: randomUUID(),
        borehole_id: row.id,
        depth: t.depth,
        blue: t.blue,
        yellow: t.yellow,
        red: t.red,
      })),
    );
  }

  async findMeasurementById(_tx: Tx, id: string): Promise<MeasurementRow | null> {
    return this.measurements.get(id) ?? null;
  }

  async insertMeasurement(_tx: Tx, row: MeasurementRow, readings: ReadingRow[]): Promise<void> {
    this.measurements.set(row.id, {
      ...row,
      measured_at_ms: row.measured_at_ms || new Date(row.measured_at).getTime(),
    });
    this.readings.set(row.id, readings);
  }

  async updateMeasurementRevisioned(
    _tx: Tx,
    id: string,
    expectedRevision: number,
    patch: { measuredAtMs: number; probeCode: string; datumReset: boolean; datumReason: MeasurementRow['datum_reason'] },
    readings: ReadingRow[],
    updatedAt: string,
  ): Promise<boolean> {
    this.casAttempts++;
    const row = this.measurements.get(id);
    if (!row || row.revision !== expectedRevision) return false;
    row.revision += 1;
    row.measured_at_ms = patch.measuredAtMs;
    row.measured_at = new Date(patch.measuredAtMs).toISOString();
    row.probe_code = patch.probeCode;
    row.datum_reset = patch.datumReset;
    row.datum_reason = patch.datumReason;
    row.updated_at = updatedAt;
    this.readings.set(id, readings);
    return true;
  }

  async getBoreholeAggregate(_tx: Tx, boreholeId: string): Promise<BoreholeAggregate> {
    const borehole = this.boreholes.get(boreholeId);
    if (!borehole) throw new Error('borehole not found');
    const measurements = [...this.measurements.values()]
      .filter((m) => m.borehole_id === boreholeId)
      .map((m) => ({ ...m, measured_at_ms: new Date(m.measured_at).getTime() }))
      .sort((a, b) => a.measured_at_ms - b.measured_at_ms || a.id.localeCompare(b.id));
    const snapshots = measurements
      .flatMap((m) => this.snapshots.get(m.id) ?? [])
      .map((s) => ({ ...s, computed_at_ms: new Date(s.computed_at).getTime() }))
      .sort((a, b) => a.computed_at_ms - b.computed_at_ms);
    return {
      borehole,
      thresholds: (this.thresholds.get(boreholeId) ?? []).map((t) => ({
        depth: t.depth,
        blue: t.blue,
        yellow: t.yellow,
        red: t.red,
      })),
      measurements,
      readings: measurements.flatMap((m) => this.readings.get(m.id) ?? []),
      snapshots,
    };
  }

  async getAllAggregates(tx: Tx): Promise<BoreholeAggregate[]> {
    const out: BoreholeAggregate[] = [];
    for (const b of this.boreholes.values()) out.push(await this.getBoreholeAggregate(tx, b.id));
    return out;
  }

  async insertSnapshotIfNewer(_tx: Tx, row: SnapshotRow): Promise<boolean> {
    const list = this.snapshots.get(row.measurement_id) ?? [];
    if (list.some((s) => s.content_hash === row.content_hash)) return false;
    list.push(row);
    this.snapshots.set(row.measurement_id, list);
    return true;
  }

  async listSnapshotsByMeasurement(_tx: Tx, measurementId: string): Promise<SnapshotRow[]> {
    return [...(this.snapshots.get(measurementId) ?? [])]
      .map((s) => ({ ...s, computed_at_ms: new Date(s.computed_at).getTime() }))
      .sort((a, b) => a.computed_at_ms - b.computed_at_ms);
  }

  async getLatestSnapshot(_tx: Tx, measurementId: string): Promise<SnapshotRow | null> {
    const list = this.snapshots.get(measurementId);
    if (!list || list.length === 0) return null;
    return [...list].map((s) => ({ ...s, computed_at_ms: new Date(s.computed_at).getTime() }))
      .sort((a, b) => b.computed_at_ms - a.computed_at_ms)[0]!;
  }
}
