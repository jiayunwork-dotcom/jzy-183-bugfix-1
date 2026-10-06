import { createHash, randomUUID } from 'node:crypto';
import type {
  AlarmLevel,
  BoreholeInput,
  CalibrationInput,
  DatumReason,
  MeasurementInput,
  ProbeInput,
  ReadingInput,
} from '@incli/shared';
import {
  computeBoreholeFull,
  computeBoreholeIncremental,
  makeInputToken,
  prepareMeasurements,
  type ComputedResult,
  type EngineBorehole,
  type EngineMeasurement,
  type EngineProbe,
} from '../engine/index.js';
import { parseTimestamp, validateBoreholeInput, validateCalibrationInput, validateMeasurementShape, validateProbeInput } from '../domain/validation.js';
import { NotFoundError, RevisionConflictError, ValidationError } from '../domain/errors.js';
import type {
  BoreholeAggregate,
  BoreholeRow,
  CalibrationRow,
  MeasurementRow,
  ProbeRow,
  ReadingRow,
  Repository,
  ResultJson,
  ResultPointJson,
  SnapshotRow,
  Tx,
} from '../storage/types.js';

export interface CreatedBorehole {
  id: string;
  code: string;
}

export interface HistoricalResultView {
  measurementId: string;
  current: { level: AlarmLevel; maxAbsRate: number | null; revision: number; computedAt: string; result: ResultJson };
  asOf: { level: AlarmLevel; maxAbsRate: number | null; revision: number; computedAt: string; result: ResultJson };
  changed: boolean;
}

function nowIso(clock: () => Date): string {
  return clock().toISOString();
}

function toResultJson(
  agg: BoreholeAggregate,
  r: ComputedResult,
  crossBoundary: boolean,
): ResultJson {
  const meas = agg.measurements.find((m) => m.id === r.measurementId)!;
  const points: ResultPointJson[] = agg.borehole.spacing
    ? r.relativeDisplacements.map((_, i) => ({
        depth: agg.measurements.length
          ? depthOf(agg, r.measurementId, i)
          : 0,
        relativeDisplacement: r.relativeDisplacements[i]!,
        connectedDisplacement: r.connectedDisplacements[i]!,
        cumulativeRaw: r.cumulativeRaw[i]!,
        checksum: r.checksums[i]!,
        suspicious: r.suspicious[i]!,
        rate: r.rates[i]!,
        level: r.pointLevels[i]!,
        crossDatum: r.crossDatum[i]!,
        usedProbeForward: r.usedProbeForward[i]!,
        usedProbeReverse: r.usedProbeReverse[i]!,
        factorForward: r.factorForward[i]!,
        factorReverse: r.factorReverse[i]!,
      }))
    : [];
  return {
    measurementId: r.measurementId,
    boreholeId: agg.borehole.id,
    revision: r.revision,
    measuredAtMs: r.measuredAtMs,
    measuredAt: meas.measured_at,
    datumIndex: r.datumIndex,
    ordinalInDatum: r.ordinalInDatum,
    relativeBaseMeasurementId: r.relativeBaseMeasurementId,
    datumAnchor: r.datumAnchor,
    maxAbsRate: r.maxAbsRate,
    level: r.level,
    crossDatumRate: crossBoundary,
    points,
  };
}

function depthOf(agg: BoreholeAggregate, measurementId: string, index: number): number {
  const rows = agg.readings
    .filter((rd) => rd.measurement_id === measurementId)
    .sort((a, b) => a.depth - b.depth);
  return rows[index]?.depth ?? 0;
}

function contentHash(r: ResultJson): string {
  // revision 与计算时刻不参与“结果内容”比较：同样的输入产出同样的曲线/等级即视为同一结果。
  const { revision: _rev, ...body } = r;
  void _rev;
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export class MonitorService {
  constructor(
    private readonly repo: Repository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /* ----------------------------- 测孔 ----------------------------- */

  async createBorehole(input: BoreholeInput): Promise<CreatedBorehole> {
    const errors = validateBoreholeInput(input);
    if (errors.length) throw new ValidationError(errors);
    return await this.repo.withTx(async (tx) => {
      if (await this.repo.findBoreholeByCode(tx, input.code)) {
        throw new ValidationError([{ field: 'code', message: `测孔编号 ${input.code} 已存在` }]);
      }
      const id = randomUUID();
      const row: BoreholeRow = {
        id,
        code: input.code,
        depth: input.depth,
        spacing: input.spacing,
        positive_direction: input.positiveDirection,
        checksum_tolerance: input.checksumTolerance,
        created_at: nowIso(this.clock),
      };
      await this.repo.insertBorehole(tx, row, input.thresholds);
      return { id, code: input.code };
    });
  }

  async listBoreholes(): Promise<BoreholeAggregate[]> {
    return await this.repo.withTx((tx) => this.repo.getAllAggregates(tx));
  }

  async getBoreholeByCode(code: string): Promise<BoreholeAggregate> {
    return await this.repo.withTx(async (tx) => {
      const b = await this.repo.findBoreholeByCode(tx, code);
      if (!b) throw new NotFoundError(`测孔 ${code} 不存在`);
      return await this.repo.getBoreholeAggregate(tx, b.id);
    });
  }

  /* ----------------------------- 探头 ----------------------------- */

  async registerProbe(input: ProbeInput): Promise<{ id: string; code: string }> {
    const errors = validateProbeInput(input);
    if (errors.length) throw new ValidationError(errors);
    return await this.repo.withTx(async (tx) => {
      if (await this.repo.findProbeByCode(tx, input.code)) {
        throw new ValidationError([{ field: 'code', message: `探头 ${input.code} 已登记` }]);
      }
      const row: ProbeRow = { id: randomUUID(), code: input.code, note: input.note ?? null, created_at: nowIso(this.clock) };
      await this.repo.insertProbe(tx, row);
      return { id: row.id, code: row.code };
    });
  }

  async listProbesWithCalibrations(): Promise<{ probe: ProbeRow; calibrations: CalibrationRow[] }[]> {
    return await this.repo.withTx(async (tx) => {
      const probes = await this.repo.listProbes(tx);
      return await Promise.all(
        probes.map(async (probe) => ({ probe, calibrations: await this.repo.listCalibrationsByProbe(tx, probe.id) })),
      );
    });
  }

  async addCalibration(input: CalibrationInput): Promise<{ id: string }> {
    const errors = validateCalibrationInput(input);
    if (errors.length) throw new ValidationError(errors);
    const effectiveAtMs = parseTimestamp(input.effectiveAt);
    return await this.repo.withTx(async (tx) => {
      const probe = await this.repo.findProbeByCode(tx, input.probeCode);
      if (!probe) throw new ValidationError([{ field: 'probeCode', message: `探头编号 ${input.probeCode} 没有登记` }]);
      const row: CalibrationRow = {
        id: randomUUID(),
        probe_id: probe.id,
        effective_at: new Date(effectiveAtMs).toISOString(),
        effective_at_ms: effectiveAtMs,
        factor: input.factor,
        note: input.note ?? null,
        revision: 1,
        superseded: false,
        created_at: nowIso(this.clock),
        updated_at: nowIso(this.clock),
      };
      await this.repo.insertCalibration(tx, row);
      // 生效时间可能早于已有测量（补录标定），受影响孔全部重算。
      await this.recomputeBoreholesUsingProbe(tx, probe.code, /* incremental */ false);
      return { id: row.id };
    });
  }

  /** 更正标定：CAS 保证并发只有一笔生效；随后重算所有使用该探头的孔。 */
  async correctCalibration(
    calibrationId: string,
    baseRevision: number,
    patch: Omit<CalibrationInput, 'probeCode'>,
  ): Promise<void> {
    const errors = validateCalibrationInput({
      probeCode: 'x',
      effectiveAt: patch.effectiveAt,
      factor: patch.factor,
      note: patch.note,
    });
    if (errors.length) throw new ValidationError(errors);
    const effectiveAtMs = parseTimestamp(patch.effectiveAt);
    await this.repo.withTx(async (tx) => {
      const all = await this.repo.listAllCalibrations(tx);
      const target = all.find((c) => c.id === calibrationId);
      if (!target) throw new NotFoundError(`标定记录 ${calibrationId} 不存在`);
      const probeRow = await this.repo.listProbes(tx).then((ps) => ps.find((p) => p.id === target.probe_id));
      const ok = await this.repo.updateCalibrationRevisioned(
        tx,
        calibrationId,
        baseRevision,
        { effectiveAtMs, factor: patch.factor, note: patch.note ?? null },
        nowIso(this.clock),
      );
      if (!ok) {
        throw new RevisionConflictError('标定记录', baseRevision);
      }
      await this.recomputeBoreholesUsingProbe(tx, probeRow!.code, false);
    });
  }

  /* --------------------------- 测量录入 ---------------------------- */

  private toReadingRows(measurementId: string, probeCode: string, readings: ReadingInput[]): ReadingRow[] {
    return [...readings]
      .map((r, i) => ({
        id: randomUUID(),
        measurement_id: measurementId,
        ord: i,
        depth: r.depth,
        forward: r.forward,
        reverse: r.reverse,
        probe_code_forward: r.probeCodeForward ?? probeCode,
        probe_code_reverse: r.probeCodeReverse ?? probeCode,
      }))
      .sort((a, b) => a.depth - b.depth)
      .map((r, i) => ({ ...r, ord: i }));
  }

  async addMeasurement(boreholeCode: string, input: MeasurementInput): Promise<{ id: string }> {
    return await this.repo.withTx(async (tx) => {
      const borehole = await this.repo.findBoreholeByCode(tx, boreholeCode);
      if (!borehole) throw new NotFoundError(`测孔 ${boreholeCode} 不存在`);
      const agg = await this.repo.getBoreholeAggregate(tx, borehole.id);
      const measuredAtMs = parseTimestamp(input.measuredAt);
      const errors = validateMeasurementShape(input, borehole.depth, borehole.spacing);
      if (Number.isNaN(measuredAtMs)) {
        // validate 已产生错误
      } else {
        // 拒收：测量日期早于该孔初始测量
        if (agg.measurements.length > 0 && measuredAtMs < agg.measurements[0]!.measured_at_ms) {
          errors.push({
            field: 'measuredAt',
            message: `测量日期 ${input.measuredAt} 早于该孔初始测量 ${new Date(agg.measurements[0]!.measured_at_ms).toISOString().slice(0, 10)}`,
          });
        }
      }
      // 拒收：探头编号没有登记（含逐行覆盖）
      const probeCodes = new Set<string>([input.probeCode]);
      for (const r of input.readings ?? []) {
        if (r.probeCodeForward) probeCodes.add(r.probeCodeForward);
        if (r.probeCodeReverse) probeCodes.add(r.probeCodeReverse);
      }
      for (const code of probeCodes) {
        if (!(await this.repo.findProbeByCode(tx, code))) {
          errors.push({ field: 'probeCode', message: `探头编号 ${code} 没有登记` });
        }
      }
      if (agg.measurements.some((m) => m.measured_at_ms === measuredAtMs)) {
        errors.push({ field: 'measuredAt', message: '该时刻已有一次测量（同孔测量时刻必须唯一）' });
      }
      if (errors.length) throw new ValidationError(errors);

      const id = randomUUID();
      const isFirst = agg.measurements.length === 0;
      const datumReset = isFirst ? true : !!input.datumReset;
      const datumReason: DatumReason = isFirst ? 'initial' : input.datumReset ? (input.datumReason ?? 'manual_reset') : 'initial';
      const row: MeasurementRow = {
        id,
        borehole_id: borehole.id,
        measured_at: new Date(measuredAtMs).toISOString(),
        measured_at_ms: measuredAtMs,
        probe_code: input.probeCode,
        datum_reset: datumReset,
        datum_reason: datumReason,
        revision: 1,
        created_at: nowIso(this.clock),
        updated_at: nowIso(this.clock),
      };
      const readingRows = this.toReadingRows(id, input.probeCode, input.readings);
      await this.repo.insertMeasurement(tx, row, readingRows);

      await this.recomputeBorehole(tx, borehole.id, { mode: 'auto' });
      return { id };
    });
  }

  /**
   * 更正一次测量。expectedRevision 为调用方读取到的版本：
   *  - 版本一致：读数/时间/探头/基准标记整体替换，revision +1，重算；
   *  - 版本不一致：另一笔更正已先提交，抛 409，本次静默覆盖绝不发生。
   * 补录到中间（measuredAt 落在两次之间）会改变排序，全部速率按新顺序重算。
   */
  async correctMeasurement(measurementId: string, expectedRevision: number, input: MeasurementInput): Promise<void> {
    await this.repo.withTx(async (tx) => {
      const existing = await this.repo.findMeasurementById(tx, measurementId);
      if (!existing) throw new NotFoundError(`测量 ${measurementId} 不存在`);
      const borehole = await this.repo.findBoreholeById(tx, existing.borehole_id);
      const measuredAtMs = parseTimestamp(input.measuredAt);
      const errors = validateMeasurementShape(input, borehole!.depth, borehole!.spacing);
      const agg = await this.repo.getBoreholeAggregate(tx, existing.borehole_id);
      if (!Number.isNaN(measuredAtMs)) {
        const initial = agg.measurements[0]!;
        if (agg.measurements.length > 0 && measuredAtMs < initial.measured_at_ms && initial.id !== measurementId) {
          errors.push({ field: 'measuredAt', message: '测量日期早于该孔初始测量' });
        }
        if (agg.measurements.some((m) => m.measured_at_ms === measuredAtMs && m.id !== measurementId)) {
          errors.push({ field: 'measuredAt', message: '该时刻已有另一次测量' });
        }
      }
      const probeCodes = new Set<string>([input.probeCode]);
      for (const r of input.readings ?? []) {
        if (r.probeCodeForward) probeCodes.add(r.probeCodeForward);
        if (r.probeCodeReverse) probeCodes.add(r.probeCodeReverse);
      }
      for (const code of probeCodes) {
        if (!(await this.repo.findProbeByCode(tx, code))) {
          errors.push({ field: 'probeCode', message: `探头编号 ${code} 没有登记` });
        }
      }
      if (errors.length) throw new ValidationError(errors);

      // 不允许把段内基准之外的唯一首测改成普通点以外的危险结构由 datumReset 显式控制；
      // 首测必须保持 reset。
      const isFirst = agg.measurements[0]!.id === measurementId;
      const patch = {
        measuredAtMs,
        probeCode: input.probeCode,
        datumReset: isFirst ? true : !!input.datumReset,
        datumReason: (isFirst ? 'initial' : input.datumReset ? input.datumReason ?? 'manual_reset' : existing.datum_reason) as DatumReason,
      };
      const readingRows = this.toReadingRows(measurementId, input.probeCode, input.readings);
      const ok = await this.repo.updateMeasurementRevisioned(tx, measurementId, expectedRevision, patch, readingRows, nowIso(this.clock));
      if (!ok) {
        const current = await this.repo.findMeasurementById(tx, measurementId);
        throw new RevisionConflictError(`测量 ${measurementId}`, current?.revision ?? expectedRevision + 1);
      }
      await this.recomputeBorehole(tx, existing.borehole_id, { mode: 'auto' });
    });
  }

  /* --------------------------- 历史判级 ---------------------------- */

  /**
   * “按当时数据”与“按现在数据”：
   *  - asOfMs 给出“当时”时刻，取 computed_at <= asOfMs 的最后一个快照；
   *  - 当前取最新快照。两者内容不同则列出 changed=true 及各自等级。
   */
  async historicalGrade(measurementId: string, asOfMs?: number): Promise<HistoricalResultView> {
    return await this.repo.withTx(async (tx) => {
      const m = await this.repo.findMeasurementById(tx, measurementId);
      if (!m) throw new NotFoundError(`测量 ${measurementId} 不存在`);
      const snapshots = await this.repo.listSnapshotsByMeasurement(tx, measurementId);
      if (snapshots.length === 0) throw new NotFoundError(`测量 ${measurementId} 尚无计算结果`);
      const asOf = asOfMs ?? this.clock().getTime();
      const past = [...snapshots].reverse().find((s) => this.snapshotTime(s) <= asOf) ?? snapshots[0]!;
      const latest = snapshots[snapshots.length - 1]!;
      const changed = past.content_hash !== latest.content_hash;
      return {
        measurementId,
        current: this.snapshotView(latest),
        asOf: this.snapshotView(past),
        changed,
      };
    });
  }

  private snapshotTime(s: SnapshotRow): number {
    return new Date(s.computed_at).getTime();
  }

  private snapshotView(s: SnapshotRow) {
    const j = s.result_json;
    return {
      level: j.level as AlarmLevel,
      maxAbsRate: j.maxAbsRate,
      revision: j.revision,
      computedAt: s.computed_at,
      result: j,
    };
  }

  /* ----------------------------- 重算 ----------------------------- */

  private async loadEngineState(tx: Tx, boreholeId: string) {
    const agg = await this.repo.getBoreholeAggregate(tx, boreholeId);
    const probesList = await this.repo.listProbes(tx);
    const calibrations = await this.repo.listAllCalibrations(tx);
    const probeMap = new Map<string, EngineProbe>();
    for (const p of probesList) {
      probeMap.set(p.code, {
        id: p.id,
        code: p.code,
        calibrations: calibrations
          .filter((c) => c.probe_id === p.id)
          .map((c) => ({ id: c.id, probeId: c.probe_id, effectiveAtMs: c.effective_at_ms, factor: c.factor })),
      });
    }
    const bh: EngineBorehole = {
      id: agg.borehole.id,
      code: agg.borehole.code,
      depth: agg.borehole.depth,
      spacing: agg.borehole.spacing,
      thresholds: agg.thresholds,
      checksumTolerance: agg.borehole.checksum_tolerance,
    };
    const measurements: EngineMeasurement[] = agg.measurements.map((m) => {
      const rows = agg.readings
        .filter((rd) => rd.measurement_id === m.id)
        .sort((a, b) => a.depth - b.depth);
      const resolvedRows = rows.map((rd) => {
        const pf = probeMap.get(rd.probe_code_forward)!;
        const pr = probeMap.get(rd.probe_code_reverse)!;
        const fF = this.factorAt(pf, m.measured_at_ms);
        const fR = this.factorAt(pr, m.measured_at_ms);
        return {
          depth: rd.depth,
          forward: rd.forward,
          reverse: rd.reverse,
          probeCodeForward: rd.probe_code_forward,
          probeCodeReverse: rd.probe_code_reverse,
          factorForward: fF,
          factorReverse: fR,
        };
      });
      return {
        id: m.id,
        measuredAtMs: m.measured_at_ms,
        probeCode: m.probe_code,
        datumReset: m.datum_reset,
        datumReason: m.datum_reason,
        inputToken: makeInputToken({
          measuredAtMs: m.measured_at_ms,
          probeCode: m.probe_code,
          datumReset: m.datum_reset,
          datumReason: m.datum_reason,
          rows: resolvedRows,
        }),
        rows: resolvedRows.map((r) => ({
          depth: r.depth,
          forward: r.forward,
          reverse: r.reverse,
          probeCodeForward: r.probeCodeForward,
          probeCodeReverse: r.probeCodeReverse,
        })),
      };
    });
    return { agg, bh, probeMap, measurements };
  }

  private factorAt(probe: EngineProbe, measuredAtMs: number): number {
    const valid = probe.calibrations.filter((c) => c.effectiveAtMs <= measuredAtMs);
    if (valid.length === 0) throw new ValidationError([{ field: 'probeCode', message: `探头 ${probe.code} 在测量时刻没有生效标定` }]);
    valid.sort((a, b) => b.effectiveAtMs - a.effectiveAtMs);
    return valid[0]!.factor;
  }

  /**
   * 重算一个孔并写入快照。
   *
   * 关键不变量（测试强制）：任何时刻增量路径产出的剖面与速率，
   * 必须与把该孔全部测量从头全量重算的结果逐数值一致。
   * 实现方式：增量路径 = 全量重算 + 逐结果指纹比对，指纹未变的结果标 unchanged，
   * 快照只对变化的结果写入。因此既增量（不重复写历史）又数学上等同全量。
   */
  private async recomputeBorehole(
    tx: Tx,
    boreholeId: string,
    opts: { mode: 'full' | 'incremental' | 'auto'; previous?: ComputedResult[] },
  ): Promise<{ full: ComputedResult[]; incremental: { unchanged: boolean; measurementId: string }[] }> {
    const { agg, bh, probeMap, measurements } = await this.loadEngineState(tx, boreholeId);
    const revisionFor = (id: string) => agg.measurements.find((m) => m.id === id)!.revision;
    const prepared = prepareMeasurements(bh, probeMap, measurements);
    const full = computeBoreholeFull(bh, prepared, revisionFor);

    let inc: ReturnType<typeof computeBoreholeIncremental>;
    if (opts.mode === 'full') {
      inc = computeBoreholeIncremental(bh, prepared, [], revisionFor);
    } else {
      const previous =
        opts.previous ?? (agg.snapshots.length > 0 ? this.snapshotsToComputed(agg) : []);
      inc = computeBoreholeIncremental(bh, prepared, previous, revisionFor);
    }

    const computedAtMs = this.clock().getTime();
    const computedAt = new Date(computedAtMs).toISOString();
    for (const r of inc.results) {
      if (r.unchanged) continue;
      const meas = agg.measurements.find((m) => m.id === r.measurementId)!;
      const cross = r.crossDatum.some(Boolean);
      const json = toResultJson(agg, r, cross);
      const hash = contentHash(json);
      await this.repo.insertSnapshotIfNewer(tx, {
        id: randomUUID(),
        measurement_id: r.measurementId,
        content_hash: hash,
        revision_at_compute: meas.revision,
        result_json: json,
        computed_at: computedAt,
        computed_at_ms: computedAtMs,
      });
    }

    // 防御性断言：增量与全量必须一致（unchanged 只是缓存标记，不参与比较）。
    for (let i = 0; i < full.results.length; i++) {
      const a = stripMeta(full.results[i]!);
      const { unchanged: _u, ...b } = inc.results[i]!;
      void _u;
      if (JSON.stringify(a) !== JSON.stringify(stripMeta(b))) {
        throw new Error(`incremental/full mismatch for borehole ${boreholeId} measurement ${a.measurementId}`);
      }
    }

    return { full: full.results, incremental: inc.results.map((r) => ({ unchanged: r.unchanged, measurementId: r.measurementId })) };
  }

  private snapshotsToComputed(agg: BoreholeAggregate): ComputedResult[] {
    const byMeasurement = new Map<string, SnapshotRow>();
    for (const s of agg.snapshots) {
      const prev = byMeasurement.get(s.measurement_id);
      if (!prev || new Date(s.computed_at).getTime() > new Date(prev.computed_at).getTime()) {
        byMeasurement.set(s.measurement_id, s);
      }
    }
    const out: ComputedResult[] = [];
    for (const m of agg.measurements) {
      const snap = byMeasurement.get(m.id);
      if (!snap) continue;
      const j = snap.result_json;
      out.push({
        measurementId: j.measurementId,
        revision: j.revision,
        measuredAtMs: j.measuredAtMs,
        datumIndex: j.datumIndex,
        ordinalInDatum: j.ordinalInDatum,
        relativeBaseMeasurementId: j.relativeBaseMeasurementId,
        datumAnchor: j.datumAnchor,
        relativeDisplacements: j.points.map((p) => p.relativeDisplacement),
        connectedDisplacements: j.points.map((p) => p.connectedDisplacement),
        cumulativeRaw: j.points.map((p) => p.cumulativeRaw),
        checksums: j.points.map((p) => p.checksum),
        suspicious: j.points.map((p) => p.suspicious),
        usedProbeForward: j.points.map((p) => p.usedProbeForward),
        usedProbeReverse: j.points.map((p) => p.usedProbeReverse),
        factorForward: j.points.map((p) => p.factorForward),
        factorReverse: j.points.map((p) => p.factorReverse),
        rates: j.points.map((p) => p.rate),
        pointLevels: j.points.map((p) => p.level as AlarmLevel),
        crossDatum: j.points.map((p) => p.crossDatum),
        maxAbsRate: j.maxAbsRate,
        level: j.level as AlarmLevel,
      });
    }
    return out;
  }

  private async recomputeBoreholesUsingProbe(tx: Tx, probeCode: string, _incremental: boolean): Promise<void> {
    const aggs = await this.repo.getAllAggregates(tx);
    for (const agg of aggs) {
      const uses = agg.readings.some(
        (r) => r.probe_code_forward === probeCode || r.probe_code_reverse === probeCode,
      );
      if (uses) await this.recomputeBorehole(tx, agg.borehole.id, { mode: 'auto' });
    }
  }

  /** 测试/管理用：对单孔强制全量重算并核对与增量一致。 */
  async forceFullRecompute(boreholeId: string): Promise<void> {
    await this.repo.withTx((tx) => this.recomputeBorehole(tx, boreholeId, { mode: 'full' }));
  }
}

function stripMeta(r: ComputedResult): Omit<ComputedResult, 'revision'> {
  const { revision: _r, ...rest } = r;
  void _r;
  return rest;
}
