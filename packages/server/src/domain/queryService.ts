import type { AlarmLevel } from '@incli/shared';
import type { Repository, ResultJson } from '../storage/types.js';
import { NotFoundError } from './errors.js';

export interface BoreholeOverviewItem {
  boreholeId: string;
  code: string;
  lastMeasuredAt: string | null;
  level: AlarmLevel;
  maxAbsRate: number | null;
  measurementId: string | null;
  datumGroups: number;
}

/** 全部测孔当前预警等级总览：每孔取最近一次测量的当前快照等级。 */
export class QueryService {
  constructor(private readonly repo: Repository) {}

  async overview(): Promise<BoreholeOverviewItem[]> {
    const aggs = await this.repo.withTx((tx) => this.repo.getAllAggregates(tx));
    const items: BoreholeOverviewItem[] = [];
    for (const agg of aggs) {
      let latest: ResultJson | null = null;
      let latestMs = -1;
      for (const s of agg.snapshots) {
        const t = new Date(s.computed_at).getTime();
        if (t > latestMs) {
          latestMs = t;
          latest = s.result_json;
        }
      }
      const lastMeas = agg.measurements[agg.measurements.length - 1] ?? null;
      items.push({
        boreholeId: agg.borehole.id,
        code: agg.borehole.code,
        lastMeasuredAt: lastMeas?.measured_at ?? null,
        level: (latest?.level as AlarmLevel) ?? 'none',
        maxAbsRate: latest?.maxAbsRate ?? null,
        measurementId: lastMeas?.id ?? null,
        datumGroups: new Set(agg.snapshots.map((s) => s.result_json.datumIndex)).size || 0,
      });
    }
    return items;
  }

  async borehole(code: string) {
    return await this.repo.withTx(async (tx) => {
      const b = await this.repo.findBoreholeByCode(tx, code);
      if (!b) throw new NotFoundError(`测孔 ${code} 不存在`);
      const agg = await this.repo.getBoreholeAggregate(tx, b.id);
      // 每次测量取当前（最新）结果；agg.snapshots 已按 computed_at 升序，直接覆盖
      const current = new Map<string, ResultJson>();
      for (const s of agg.snapshots) current.set(s.measurement_id, s.result_json);
      return {
        borehole: {
          id: agg.borehole.id,
          code: agg.borehole.code,
          depth: agg.borehole.depth,
          spacing: agg.borehole.spacing,
          positiveDirection: agg.borehole.positive_direction,
          checksumTolerance: agg.borehole.checksum_tolerance,
          thresholds: agg.thresholds,
        },
        measurements: agg.measurements.map((m) => ({
          id: m.id,
          measuredAt: m.measured_at,
          probeCode: m.probe_code,
          datumReset: m.datum_reset,
          datumReason: m.datum_reason,
          revision: m.revision,
          result: current.get(m.id) ?? null,
        })),
      };
    });
  }

  /** 任选几次测量的位移剖面叠加；同时给基准切换边界。 */
  async profileOverlay(code: string, measurementIds: string[] | 'all', connected: boolean) {
    const detail = await this.borehole(code);
    const pick = new Set(measurementIds === 'all' ? detail.measurements.map((m) => m.id) : measurementIds);
    const series = detail.measurements
      .filter((m) => pick.has(m.id) && m.result)
      .map((m) => ({
        measurementId: m.id,
        measuredAt: m.measuredAt,
        revision: m.revision,
        datumIndex: m.result!.datumIndex,
        datumReset: m.datumReset,
        depths: m.result!.points.map((p) => p.depth),
        values: m.result!.points.map((p) => (connected ? p.connectedDisplacement : p.relativeDisplacement)),
        levels: m.result!.points.map((p) => p.level),
        crossDatum: m.result!.points.map((p) => p.crossDatum),
      }));
    const boundaries = detail.measurements
      .filter((m) => m.datumReset && m.result && m.result.datumIndex > 0)
      .map((m) => ({
        measurementId: m.id,
        measuredAt: m.measuredAt,
        datumIndex: m.result!.datumIndex,
        anchor: m.result!.datumAnchor,
        reason: m.datumReason,
      }));
    return { code: detail.borehole.code, connected, series, boundaries };
  }

  /** 某个深度随时间的位移与速率曲线。 */
  async depthHistory(code: string, depth: number, connected: boolean) {
    const detail = await this.borehole(code);
    const tol = detail.borehole.spacing * 1e-3;
    const points = detail.measurements
      .filter((m) => m.result)
      .map((m) => {
        const p = m.result!.points.find((pp) => Math.abs(pp.depth - depth) <= Math.max(tol, 1e-6));
        if (!p) return null;
        return {
          measurementId: m.id,
          measuredAt: m.measuredAt,
          displacement: connected ? p.connectedDisplacement : p.relativeDisplacement,
          rate: p.rate,
          level: p.level,
          crossDatum: p.crossDatum,
          datumIndex: m.result!.datumIndex,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return { code, depth, connected, points };
  }

  /** 点开一次测量：校核和、可疑点、探头/系数等。 */
  async measurementDetail(measurementId: string) {
    return await this.repo.withTx(async (tx) => {
      const m = await this.repo.findMeasurementById(tx, measurementId);
      if (!m) throw new NotFoundError(`测量 ${measurementId} 不存在`);
      const agg = await this.repo.getBoreholeAggregate(tx, m.borehole_id);
      const rows = agg.readings
        .filter((r) => r.measurement_id === measurementId)
        .sort((a, b) => a.depth - b.depth);
      const snapshots = await this.repo.listSnapshotsByMeasurement(tx, measurementId);
      const current = snapshots[snapshots.length - 1] ?? null;
      return {
        measurement: {
          id: m.id,
          measuredAt: m.measured_at,
          probeCode: m.probe_code,
          datumReset: m.datum_reset,
          datumReason: m.datum_reason,
          revision: m.revision,
        },
        boreholeCode: agg.borehole.code,
        readings: rows,
        result: current?.result_json ?? null,
        snapshotHistory: snapshots.map((s) => ({
          computedAt: s.computed_at,
          revision: s.revision_at_compute,
          contentHash: s.content_hash.slice(0, 12),
          level: s.result_json.level,
          maxAbsRate: s.result_json.maxAbsRate,
        })),
      };
    });
  }
}
