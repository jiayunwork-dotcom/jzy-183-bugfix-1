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

describe('换探头基准：逐深度冻结拼接', () => {
  const bh2: EngineBorehole = {
    id: 'bh2',
    code: 'BH-X2',
    depth: 2.0,
    spacing: 0.5,
    checksumTolerance: 0.01,
    thresholds: [
      { depth: 0.5, blue: 1, yellow: 2, red: 4 },
      { depth: 2.0, blue: 1, yellow: 2, red: 4 },
    ],
  };
  const depths2 = [0.5, 1.0, 1.5, 2.0];

  function twoProbes(): Map<string, EngineProbe> {
    return new Map(['P1', 'P2'].map((code, i) => [
      code,
      {
        id: `p${i + 1}`,
        code,
        calibrations: [{ id: `c${i + 1}`, probeId: `p${i + 1}`, effectiveAtMs: 0, factor: 1 }],
      },
    ]));
  }

  /** @param tiltsAsc 浅→深四段 tilt；读数正=0.5+tilt/2，反=0.5−tilt/2。 */
  function m2(id: string, t: number, tiltsAsc: number[], probe = 'P1', reset = false): EngineMeasurement {
    return {
      id,
      measuredAtMs: t * 86_400_000,
      probeCode: probe,
      datumReset: reset,
      datumReason: reset ? (t === 0 ? 'initial' : 'probe_change') : 'initial',
      inputToken: id,
      rows: depths2.map((depth, i) => {
        const diff = tiltsAsc[i]!;
        return { depth, forward: 0.5 + diff / 2, reverse: 0.5 - diff / 2, probeCodeForward: probe, probeCodeReverse: probe };
      }),
    };
  }

  it('换探头复测当天逐深度对齐旧段末测 [4,2,0,0]：孔底为零、速率严格为零、不预警；次日 [6,3,0,0]', () => {
    const ms = [
      m2('d0', 0, [0, 0, 0, 0], 'P1', true),
      m2('d2', 2, [0.004, 0.004, 0, 0]),
      // 新探头每段 0.002 常数零漂：原始累计 [8,5,2,1]
      m2('d4', 4, [0.006, 0.006, 0.002, 0.002], 'P2', true),
      m2('d6', 6, [0.008, 0.008, 0.002, 0.002], 'P2'),
    ];
    const { results, boundaries } = computeBoreholeFull(bh2, prepareMeasurements(bh2, twoProbes(), ms), () => 1);

    const reset = results[2]!;
    expect(reset.relativeDisplacements.every((v) => v === 0)).toBe(true);
    expect(reset.connectedDisplacements).toEqual([4, 2, 0, 0].map((v) => expect.closeTo(v, 10)));
    expect(reset.datumAnchors).toEqual([4, 2, 0, 0].map((v) => expect.closeTo(v, 10)));
    // 跨基准首条速率严格为 0（直接对齐，连浮点差都没有），不预警
    expect(reset.rates).toEqual([0, 0, 0, 0]);
    expect(reset.maxAbsRate).toBe(0);
    expect(reset.level).toBe('none');
    expect(reset.crossDatum.every(Boolean)).toBe(true);

    const next = results[3]!;
    expect(next.connectedDisplacements).toEqual([6, 3, 0, 0].map((v) => expect.closeTo(v, 10)));
    expect(next.rates).toEqual([1, 0.5, 0, 0].map((v) => expect.closeTo(v, 10)));
    expect(next.level).toBe('none'); // 孔口恰为蓝阈值 1，等于阈值不预警
    expect(next.crossDatum.every((f) => !f)).toBe(true);

    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]!.anchors).toEqual([4, 2, 0, 0].map((v) => expect.closeTo(v, 10)));
    expect(boundaries[0]!.reason).toBe('probe_change');
  });

  it('零漂呈深度形状（非线性）时逐深度对齐仍成立：标量中位数会残差，逐深度锚点整体吸收', () => {
    // 旧段末测 [4,2,0,0]；新探头复测差异呈线性形状，原始累计 [8,4.5,2,0.5]
    const ms = [
      m2('d0', 0, [0, 0, 0, 0], 'P1', true),
      m2('d2', 2, [0.004, 0.004, 0, 0]),
      m2('d4', 4, [0.007, 0.005, 0.003, 0.001], 'P2', true),
    ];
    const { results } = computeBoreholeFull(bh2, prepareMeasurements(bh2, twoProbes(), ms), () => 1);
    const reset = results[2]!;
    expect(reset.cumulativeRaw).toEqual([8, 4.5, 2, 0.5].map((v) => expect.closeTo(v, 10)));
    expect(reset.connectedDisplacements).toEqual([4, 2, 0, 0].map((v) => expect.closeTo(v, 10)));
    expect(reset.rates).toEqual([0, 0, 0, 0]);
    expect(reset.level).toBe('none');
  });
});
