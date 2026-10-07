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
  /** 每段相对第 0 段的逐深度拼接偏移，anchors[k][d]，段 0 为全 0。 */
  anchors: number[][];
  /** 每个新基准复测相对上一段末测被吸收掉的逐深度原始差异（诊断用）。 */
  rawOffsets: number[][];
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
 * 基准拼接（决策，详见 README“基准（datum）”与 docs/datum.md）：
 *
 * anchor[0][d] = 0。新段 k 的基准是该段第一次测量 reset_k（修复/换探头当天复测），
 * 它的段内相对剖面处处为 0。认为 reset_k 与上一段最后一次测量 last_{k−1} 之间
 * 没有真实位移，两次测量在每个深度的差异全部来自系统差（换探头零漂/管型改变），
 * 因此逐深度对齐，而不是取单一标量：
 *
 *   anchor[k][d]    = anchor[k-1][d] + R_d(last_{k-1})
 *                   = connected(last_{k-1}, d)
 *   rawOffset[k][d] = C_d(reset_k) - C_d(last_{k-1})   （被吸收的逐深度原始差异）
 *   connected(m, d) = anchor[group(m)][d] + R_d(m)
 *
 * 于是 reset_k 当天的连续剖面与上一测逐深度重合（孔底固定点仍为 0），
 * 跨基准速率为 0、不产生误警；常数零漂在累计剖面上呈逐段累积的线性形状，
 * 只有逐深度向量才能整体抵消。
 */
function buildAnchors(ctx: BuildContext): void {
  const { prepared, groups, relatives } = ctx;
  const width = prepared[0]!.points.length;
  ctx.anchors[0] = new Array(width).fill(0);
  ctx.rawOffsets[0] = new Array(width).fill(0);
  for (let k = 1; k < groups.length; k++) {
    const prevLast = groups[k]!.start - 1;
    const prevAnchor = ctx.anchors[k - 1]!;
    const prevRel = relatives[prevLast]!.rel;
    ctx.anchors[k] = prevAnchor.map((a, d) => a + prevRel[d]!);

    const resetPm = prepared[groups[k]!.base]!;
    const prevPm = prepared[prevLast]!;
    ctx.rawOffsets[k] = resetPm.points.map((pt, d) => pt.cumulativeRaw - prevPm.points[d]!.cumulativeRaw);
  }
}

function buildConnected(ctx: BuildContext): void {
  const { groupByIndex, anchors, relatives, connected } = ctx;
  relatives.forEach((entry, i) => {
    const anchor = anchors[groupByIndex[i]!.datumIndex]!;
    connected[i] = entry.rel.map((v, d) => v + anchor[d]!);
  });
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
    rawOffsets: [],
    connected: [],
  };
  buildRelatives(ctx);
  buildAnchors(ctx);
  buildConnected(ctx);
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
        anchor: ctx.anchors[g.datumIndex]!,
        rawOffset: ctx.rawOffsets[g.datumIndex]!,
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
      rates = rateBetween(connected[i]!, connected[i - 1]!, m.measuredAtMs, prepared[i - 1]!.measurement.measuredAtMs);
      if (cross) crossFlags.fill(true);
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
      datumAnchor: anchors[g.datumIndex]!,
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
    arraysEqual(a.datumAnchor, b.datumAnchor) &&
    a.maxAbsRate === b.maxAbsRate &&
    a.level === b.level &&
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
