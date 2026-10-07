import { describe, expect, it } from 'vitest';
import { computeBoreholeFull, prepareMeasurements, type EngineBorehole, type EngineMeasurement, type EngineProbe } from '../engine/index.js';

const bh: EngineBorehole = {
  id: 'bh1',
  code: 'BH-3',
  depth: 1.5,
  spacing: 0.5,
  checksumTolerance: 0.01,
  thresholds: [{ depth: 0.5, blue: 1, yellow: 2, red: 3 }],
};

function probes(factor = 1): Map<string, EngineProbe> {
  return new Map([
    [
      'P1',
      {
        id: 'p1',
        code: 'P1',
        calibrations: [{ id: 'c1', probeId: 'p1', effectiveAtMs: 0, factor }],
      },
    ],
  ]);
}

/**
 * 需求小算例：测段长 0.5 m，从孔底往上三个测段相对初始测量的倾斜正弦值
 * 依次为 0、0.004、0.002，则三个测段顶端的累计位移依次是 0、2 mm、3 mm。
 *
 * 测点网格为 0.5/1.0/1.5 m（1.5 m = 孔底固定点）。
 * 从孔底往上段序：seg0 tilt=0（1.0→1.5 段），seg1 tilt=0.004（0.5→1.0 段），
 * seg2 tilt=0.002（孔口 0 → 0.5 段，读数列 depth=0.5 对应）。
 * 升序累计：0.5m = 0+2+1 = 3mm；1.0m = 0+2 = 2mm；1.5m = 0。
 */
function measurement(tiltsFromBottom: number[], id: string, t: number, reset = true): EngineMeasurement {
  // tiltsFromBottom: 从孔底往上 [seg_deepest, ..., seg_shallowest]
  const depths = [0.5, 1.0, 1.5];
  const tiltsAsc = [...tiltsFromBottom].reverse();
  return {
    id,
    measuredAtMs: t,
    probeCode: 'P1',
    datumReset: reset,
    datumReason: 'initial',
    inputToken: id,
    rows: depths.map((depth, i) => {
      const diff = tiltsAsc[i]!; // forward - reverse
      return { depth, forward: 0.5 + diff / 2, reverse: 0.5 - diff / 2, probeCodeForward: 'P1', probeCodeReverse: 'P1' };
    }),
  };
}

describe('三测段算例：从孔底往上 0 / 2mm / 3mm', () => {
  it('升序深度累计位移为 3mm(0.5m)、2mm(1.0m)、0mm(1.5m)', () => {
    const prepared = prepareMeasurements(bh, probes(), [measurement([0, 0.004, 0.002], 'm1', 0)]);
    const { results } = computeBoreholeFull(bh, prepared, () => 1);
    const cum = results[0]!.cumulativeRaw;
    expect(cum[0]).toBeCloseTo(3, 10);
    expect(cum[1]).toBeCloseTo(2, 10);
    expect(cum[2]).toBeCloseTo(0, 10);
  });

  it('首次测量作为初始测量，相对位移处处为 0', () => {
    const prepared = prepareMeasurements(bh, probes(), [measurement([0, 0.004, 0.002], 'm1', 0)]);
    const { results } = computeBoreholeFull(bh, prepared, () => 1);
    for (const v of results[0]!.relativeDisplacements) expect(v).toBeCloseTo(0, 10);
  });
});

describe('物理对称性', () => {
  it('读数全部等于初始测量时相对位移处处为零', () => {
    const base = measurement([0.001, 0.002, 0.003], 'm1', 0);
    const same = measurement([0.001, 0.002, 0.003], 'm2', 86_400_000, false);
    const prepared = prepareMeasurements(bh, probes(), [base, same]);
    const { results } = computeBoreholeFull(bh, prepared, () => 1);
    for (const v of results[1]!.relativeDisplacements) expect(v).toBeCloseTo(0, 10);
    for (const v of results[1]!.rates) expect(v).toBeCloseTo(0, 10);
  });

  it('探头系数变为两倍而读数不变时位移变为两倍', () => {
    const m = measurement([0, 0.004, 0.002], 'm1', 0);
    const once = prepareMeasurements(bh, probes(1), [m]);
    const twice = prepareMeasurements(bh, probes(2), [m]);
    const r1 = computeBoreholeFull(bh, once, () => 1).results[0]!.cumulativeRaw;
    const r2 = computeBoreholeFull(bh, twice, () => 1).results[0]!.cumulativeRaw;
    r1.forEach((v, i) => expect(r2[i]).toBeCloseTo(2 * v, 10));
  });

  it('把正反测读数互换，位移变号', () => {
    const m = measurement([0.001, 0.004, 0.002], 'm1', 0);
    const swapped: EngineMeasurement = {
      ...m,
      rows: m.rows.map((r) => ({ ...r, forward: r.reverse, reverse: r.forward })),
    };
    const r1 = prepareMeasurements(bh, probes(), [m]);
    const r2 = prepareMeasurements(bh, probes(), [swapped]);
    const c1 = computeBoreholeFull(bh, r1, () => 1).results[0]!.cumulativeRaw;
    const c2 = computeBoreholeFull(bh, r2, () => 1).results[0]!.cumulativeRaw;
    c1.forEach((v, i) => expect(c2[i]).toBeCloseTo(-v, 10));
  });

  it('校核和恒定的数据没有可疑点；单点异常被标出但不剔除', () => {
    const clean: EngineMeasurement = {
      ...measurement([0, 0.004, 0.002], 'm1', 0),
    };
    const preparedClean = prepareMeasurements(bh, probes(), [clean]);
    expect(preparedClean[0]!.points.every((p) => !p.suspicious)).toBe(true);

    const dirty: EngineMeasurement = {
      ...clean,
      rows: clean.rows.map((r, i) => (i === 1 ? { ...r, forward: r.forward + 0.5, reverse: r.reverse + 0.5 } : r)),
    };
    const preparedDirty = prepareMeasurements(bh, probes(), [dirty]);
    const flags = preparedDirty[0]!.points.map((p) => p.suspicious);
    expect(flags[1]).toBe(true);
    // 不剔除：点还在
    expect(preparedDirty[0]!.points).toHaveLength(3);
  });
});

/**
 * 换探头（新基准）拼接：新探头的常数零漂逐段累加后在累计剖面上呈线性形状，
 * 标量偏移无法抵消，必须逐深度对齐。孔深 2 m、间距 0.5 m、四个测点，
 * 孔底（2.0 m）为固定点。
 */
const bh4: EngineBorehole = {
  id: 'bh4',
  code: 'BH-4',
  depth: 2.0,
  spacing: 0.5,
  checksumTolerance: 0.01,
  thresholds: [{ depth: 0.5, blue: 1, yellow: 2, red: 4 }],
};

function measurement4(tiltsAsc: number[], id: string, t: number, reset = false): EngineMeasurement {
  const depths = [0.5, 1.0, 1.5, 2.0];
  return {
    id,
    measuredAtMs: t * MS_DAY,
    probeCode: 'P1',
    datumReset: reset,
    datumReason: reset ? 'probe_change' : 'initial',
    inputToken: id,
    rows: depths.map((depth, i) => {
      const diff = tiltsAsc[i]!;
      return { depth, forward: 0.5 + diff / 2, reverse: 0.5 - diff / 2, probeCodeForward: 'P1', probeCodeReverse: 'P1' };
    }),
  };
}

const MS_DAY = 86_400_000;

describe('换探头新基准：逐深度对齐', () => {
  it('当天连续剖面与旧探头末测重合、孔底为零、速率为零；其后速率只反映真实增量', () => {
    const ms = [
      measurement4([0, 0, 0, 0], 'm0', 0),
      measurement4([0.004, 0.004, 0, 0], 'm2', 2),
      measurement4([0.006, 0.006, 0.002, 0.002], 'm4', 4, true),
      measurement4([0.008, 0.008, 0.002, 0.002], 'm6', 6),
    ];
    const prepared = prepareMeasurements(bh4, probes(), ms);
    const { results, boundaries } = computeBoreholeFull(bh4, prepared, () => 1);

    const r4 = results[2]!;
    expect(r4.relativeDisplacements.every((v) => Math.abs(v) < 1e-9)).toBe(true);
    expect(r4.connectedDisplacements.map((v) => Number(v.toFixed(6)))).toEqual([4, 2, 0, 0]);
    expect(r4.cumulativeRaw.map((v) => Number(v.toFixed(6)))).toEqual([8, 5, 2, 1]);
    expect(r4.rates.map((v) => Number(v!.toFixed(6)))).toEqual([0, 0, 0, 0]);
    expect(r4.level).toBe('none');
    expect(r4.datumAnchor.map((v) => Number(v.toFixed(6)))).toEqual([4, 2, 0, 0]);
    expect(r4.crossDatum.every(Boolean)).toBe(true);

    const r6 = results[3]!;
    expect(r6.relativeDisplacements.map((v) => Number(v.toFixed(6)))).toEqual([2, 1, 0, 0]);
    expect(r6.connectedDisplacements.map((v) => Number(v.toFixed(6)))).toEqual([6, 3, 0, 0]);
    expect(r6.rates.map((v) => Number(v!.toFixed(6)))).toEqual([1, 0.5, 0, 0]);
    // 1 mm/d 带 ~1e-15 正浮点残差，严格 > 蓝阈值 → 蓝
    expect(r6.level).toBe('blue');
    expect(r6.crossDatum.every((f) => !f)).toBe(true);

    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]!.anchor.map((v) => Number(v.toFixed(6)))).toEqual([4, 2, 0, 0]);
    expect(boundaries[0]!.rawOffset.map((v) => Number(v.toFixed(6)))).toEqual([4, 3, 2, 1]);
  });

  it('连续两次换探头（含只有一次测量的段）：第二边界对齐到紧邻的一测', () => {
    const ms = [
      measurement4([0, 0, 0, 0], 'm0', 0),
      measurement4([0.004, 0, 0, 0], 'm2', 2), // 累计 [2,0,0,0]
      measurement4([0.006, 0.002, 0.002, 0.002], 'm4', 4, true), // 原始 [6,3,2,1]
      measurement4([0.009, 0.005, 0.005, 0.005], 'm6', 6, true), // 原始 [12,7.5,5,2.5]
    ];
    const prepared = prepareMeasurements(bh4, probes(), ms);
    const { results, boundaries } = computeBoreholeFull(bh4, prepared, () => 1);

    // m4 对齐 m2 → [2,0,0,0]
    expect(results[2]!.connectedDisplacements.map((v) => Number(v.toFixed(6)))).toEqual([2, 0, 0, 0]);
    expect(results[2]!.rates.map((v) => Number(v!.toFixed(6)))).toEqual([0, 0, 0, 0]);
    // 段 1 只有一次测量；m6 对齐 m4 的连续剖面，仍是 [2,0,0,0]
    expect(results[3]!.connectedDisplacements.map((v) => Number(v.toFixed(6)))).toEqual([2, 0, 0, 0]);
    expect(results[3]!.rates.map((v) => Number(v!.toFixed(6)))).toEqual([0, 0, 0, 0]);
    expect(boundaries.map((b) => b.datumIndex)).toEqual([1, 2]);
    expect(boundaries[1]!.anchor.map((v) => Number(v.toFixed(6)))).toEqual([2, 0, 0, 0]);
  });
});
