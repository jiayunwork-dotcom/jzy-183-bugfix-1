import type {
  ComputedResult,
  EngineBoundary,
  FullComputeOutput,
  IncrementalComputeOutput,
  IncrementalResult,
  PreparedMeasurement,
} from './types.js';
import { LEVEL_RANK, classifyRate, thresholdsAtDepth } from './geometry.js';

const MS_PER_DAY = 86_400_000;

interface GroupInfo {
  datumIndex: number;
  start: number;
  /** 段内基准（段内第一次测量）在 prepared 数组中的下标。 */
  base: number;
}

function partitionGroups(prepared: PreparedMeasurement[]): GroupInfo[] {
  const groups: GroupInfo[] = [];
  prepared.forEach((p, idx) => {
    const m = p.measurement;
    if (idx === 0 || m.datumReset) {
      groups.push({ datumIndex: groups.length, start: idx, base: idx });
    }
  });
  return groups;
}

function groupOf(groups: GroupInfo[], idx: number): GroupInfo {
  // groups.start 升序，找最后一个 start <= idx
  let g = groups[0]!;
  for (const cand of groups) {
    if (cand.start <= idx) g = cand;
    else break;
  }
  return g;
}

function relativeProfile(pm: PreparedMeasurement, base: PreparedMeasurement): number[] {
  return pm.points.map((pt, i) => pt.cumulativeRaw - base.points[i]!.cumulativeRaw);
}

interface RelEntry {
  rel: number[];
  baseId: string;
}

interface BuildContext {
  prepared: PreparedMeasurement[];
  groups: GroupInfo[];
  groupByIndex: GroupInfo[];
  relatives: RelEntry[]; // per prepared index
  anchors: number[][]; // per group，逐深度拼接锚点
  connected: number[][];
}

function buildRelatives(ctx: BuildContext): void {
  const { prepared, groups } = ctx;
  for (const g of groups) {
    const basePm = prepared[g.base]!;
    for (let i = g.start; i < (groups[g.datumIndex + 1]?.start ?? prepared.length); i++) {
      ctx.relatives[i] = {
        rel: relativeProfile(prepared[i]!, basePm),
        baseId: basePm.measurement.id,
      };
    }
  }
}

/**
 * 基准拼接（决策，详见 README“基准（datum）”一节）：
 * anchor[0] 处处为 0；新段 k 的基准是该段第一次测量（修复/换探头当天复测，
 * 其段内相对剖面 reset_k 处处为 0）。复测与旧段最后一次测量紧邻，无法区分
 * 这段间隔里的逐深度差异是系统零漂还是真实位移，本系统按“零漂移处理”拍板：
 * 复测当天的连接剖面逐深度强制等于旧段末测的连接剖面，即每个深度各有自己的
 * 标量拼接量：
 *   anchor[k][d] = connected(last_{k−1}, d)
 *                = anchor[k−1][d] + relative(last_{k−1}, d)
 *   connected(m, d) = anchor[group(m)][d] + relative(m, d)
 * 因此跨基准的第一条速率逐深度严格为 0，不参与预警；该速率仍打 crossDatum
 * 标记，提示它是“按零漂移假设对齐”得到的，而非实测变化。
 */
function buildAnchorsAndConnected(ctx: BuildContext): void {
  const { prepared, groups, relatives, connected } = ctx;
  const pointCount = prepared[0]!.points.length;
  ctx.anchors[0] = new Array(pointCount).fill(0);
  for (let k = 0; k < groups.length; k++) {
    if (k === 0) {
      // 第 0 段起点即孔的第一次测量，连接剖面 = 段内相对剖面（基准处处为 0）。
      connected[groups[0]!.start] = [...relatives[groups[0]!.start]!.rel];
    } else {
      const prevLast = groups[k]!.start - 1;
      // 逐深度冻结：新段起点连接剖面 = 旧段末测连接剖面。
      // 直接复用旧末测的连接数组（拷贝），保证跨段首条速率严格为 0（连浮点差都没有）。
      ctx.anchors[k] = [...connected[prevLast]!];
      connected[groups[k]!.start] = [...connected[prevLast]!];
    }
    const end = groups[k + 1]?.start ?? prepared.length;
    for (let i = groups[k]!.start + 1; i < end; i++) {
      connected[i] = relatives[i]!.rel.map((v, d) => v + ctx.anchors[k]![d]!);
    }
  }
}

function rateBetween(cur: number[], prev: number[], curMs: number, prevMs: number): number[] {
  const days = (curMs - prevMs) / MS_PER_DAY;
  return cur.map((v, i) => (v - prev[i]!) / days);
}

export function computeBoreholeFull(
  borehole: { thresholds: import('@incli/shared').ThresholdEntry[] },
  prepared: PreparedMeasurement[],
  revisionFor: (id: string) => number,
): FullComputeOutput {
  if (prepared.length === 0) return { results: [], boundaries: [] };

  const groups = partitionGroups(prepared);
  const ctx: BuildContext = {
    prepared,
    groups,
    groupByIndex: prepared.map((_, i) => groupOf(groups, i)),
    relatives: [],
    anchors: [],
    connected: [],
  };
  buildRelatives(ctx);
  buildAnchorsAndConnected(ctx);
  const results = finalizeWithThresholds(ctx, revisionFor, borehole.thresholds);
  const boundaries: EngineBoundary[] = groups
    .filter((g) => g.datumIndex > 0)
    .map((g) => {
      const pm = prepared[g.base]!;
      return {
        measurementId: pm.measurement.id,
        measuredAtMs: pm.measurement.measuredAtMs,
        datumIndex: g.datumIndex,
        reason: pm.measurement.datumReason,
        anchors: ctx.anchors[g.datumIndex]!,
      };
    });
  return { results, boundaries };
}

/** 深度数组（升序），所有测量共享。 */
export function depthsOf(prepared: PreparedMeasurement[]): number[] {
  return prepared.length ? prepared[0]!.points.map((p) => p.depth) : [];
}

function finalizeWithThresholds(
  ctx: BuildContext,
  revisionFor: (id: string) => number,
  thresholds: import('@incli/shared').ThresholdEntry[],
): ComputedResult[] {
  const { prepared, groupByIndex, anchors, connected, relatives } = ctx;
  const results: ComputedResult[] = [];

  prepared.forEach((pm, i) => {
    const m = pm.measurement;
    const g = groupByIndex[i]!;
    const crossFlags = new Array<boolean>(pm.points.length).fill(false);
    let rates: (number | null)[];
    if (i === 0) {
      rates = pm.points.map(() => null);
    } else {
      const cross = groupByIndex[i - 1]!.datumIndex !== g.datumIndex;
      if (cross) {
        // 基准段起点（修复/换探头当天复测）：连接剖面已与旧段末测逐深度对齐，
        // 跨段首条速率按约定严格为 0；逐点打 crossDatum 标记提示判读谨慎。
        rates = pm.points.map(() => 0);
        crossFlags.fill(true);
      } else {
        rates = rateBetween(connected[i]!, connected[i - 1]!, m.measuredAtMs, prepared[i - 1]!.measurement.measuredAtMs);
      }
    }

    let maxAbsRate: number | null = null;
    let level: ComputedResult['level'] = 'none';
    const pointLevels = pm.points.map((pt, j) => {
      const r = rates[j]!;
      if (i === 0 || r === null) return 'none' as const;
      const abs = Math.abs(r);
      if (maxAbsRate === null || abs > maxAbsRate) maxAbsRate = abs;
      const lvl = classifyRate(abs, thresholdsAtDepth(thresholds, pt.depth));
      if (LEVEL_RANK[lvl] > LEVEL_RANK[level]) level = lvl;
      return lvl;
    });

    results.push({
      measurementId: m.id,
      revision: revisionFor(m.id),
      measuredAtMs: m.measuredAtMs,
      datumIndex: g.datumIndex,
      ordinalInDatum: i - g.start,
      relativeBaseMeasurementId: relatives[i]!.baseId,
      datumAnchors: anchors[g.datumIndex]!,
      relativeDisplacements: relatives[i]!.rel,
      connectedDisplacements: connected[i]!,
      cumulativeRaw: pm.points.map((p) => p.cumulativeRaw),
      checksums: pm.points.map((p) => p.checksum),
      suspicious: pm.points.map((p) => p.suspicious),
      usedProbeForward: pm.points.map((p) => p.usedProbeForward),
      usedProbeReverse: pm.points.map((p) => p.usedProbeReverse),
      factorForward: pm.points.map((p) => p.factorForward),
      factorReverse: pm.points.map((p) => p.factorReverse),
      rates,
      pointLevels,
      crossDatum: crossFlags,
      maxAbsRate,
      level,
    });
  });

  return results;
}

/* ------------------------------------------------------------------ */
/* Incremental path                                                     */
/* ------------------------------------------------------------------ */

function arraysEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 增量重算：全量重算后与上一轮结果逐项比对，完全相同才标记 unchanged。
 * 服务层只对变化结果写快照；同时服务内有“增量 ≡ 全量”的逐数值断言，
 * 因此任何时刻按当前数据增量更新的剖面与速率，都与从头全量重算完全一致。
 */
export function computeBoreholeIncremental(
  borehole: { thresholds: import('@incli/shared').ThresholdEntry[] },
  prepared: PreparedMeasurement[],
  previous: ComputedResult[],
  revisionFor: (id: string) => number,
): IncrementalComputeOutput {
  const full = computeBoreholeFull(borehole, prepared, revisionFor);
  const prevById = new Map(previous.map((r) => [r.measurementId, r]));

  const results: IncrementalResult[] = full.results.map((r) => {
    const old = prevById.get(r.measurementId);
    const unchanged = !!old && sameResult(old, r);
    return { ...r, unchanged };
  });

  return { results, boundaries: full.boundaries };
}

function sameResult(a: ComputedResult, b: ComputedResult): boolean {
  return (
    a.measurementId === b.measurementId &&
    a.measuredAtMs === b.measuredAtMs &&
    a.datumIndex === b.datumIndex &&
    a.ordinalInDatum === b.ordinalInDatum &&
    a.relativeBaseMeasurementId === b.relativeBaseMeasurementId &&
    a.maxAbsRate === b.maxAbsRate &&
    a.level === b.level &&
    arraysEqual(a.datumAnchors, b.datumAnchors) &&
    arraysEqual(a.relativeDisplacements, b.relativeDisplacements) &&
    arraysEqual(a.connectedDisplacements, b.connectedDisplacements) &&
    arraysEqual(a.cumulativeRaw, b.cumulativeRaw) &&
    arraysEqual(a.checksums, b.checksums) &&
    arraysEqual(a.factorForward, b.factorForward) &&
    arraysEqual(a.factorReverse, b.factorReverse) &&
    ratesEqual(a.rates, b.rates) &&
    a.pointLevels.every((l, i) => l === b.pointLevels[i]) &&
    a.suspicious.every((s, i) => s === b.suspicious[i]) &&
    a.crossDatum.every((s, i) => s === b.crossDatum[i])
  );
}

function ratesEqual(a: (number | null)[], b: (number | null)[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === null || b[i] === null) {
      if (a[i] !== b[i]) return false;
    } else if (a[i] !== b[i]) return false;
  }
  return true;
}
