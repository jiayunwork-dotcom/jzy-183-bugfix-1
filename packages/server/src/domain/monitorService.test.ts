import { describe, expect, it, beforeEach } from 'vitest';
import type { BoreholeInput, MeasurementInput, ThresholdEntry } from '@incli/shared';
import { MemoryRepository } from '../storage/index.js';
import { MonitorService } from './monitorService.js';
import { QueryService } from './queryService.js';
import { RevisionConflictError, ValidationError } from './errors.js';
import type { ResultJson } from '../storage/types.js';

let clockMs = Date.parse('2024-01-01T00:00:00Z');
const clock = () => new Date(clockMs);
function tick(ms = 1000) {
  clockMs += ms;
}

/**
 * 测点/测段（深度升序）：d_i = i·L，i=1..n；d_n = 孔深，其测段底端为孔底固定点。
 * 段偏移 s_i = tilt_i · L；从孔底往上累加，测点 i 的累计 = Σ_{j>=i} s_j（后缀和）。
 */
const DEPTHS = [0.5, 1.0, 1.5, 2.0];

/** @param tiltsAsc 升序测段 tilt：下标 0=0.5m 行（最浅段），末位=2.0m 行（最深段，固定点段）。 */
function readingsFromTilts(tiltsAsc: number[]): MeasurementInput['readings'] {
  return DEPTHS.map((depth, i) => {
    const diff = tiltsAsc[i]!;
    return { depth, forward: 0.5 + diff / 2, reverse: 0.5 - diff / 2 };
  });
}

const ZERO = (): MeasurementInput['readings'] => readingsFromTilts([0, 0, 0, 0]);

/** 引擎口径的后缀累加（mm）。 */
function cum(tiltsAsc: number[]): number[] {
  const seg = tiltsAsc.map((t) => t * 500);
  return DEPTHS.map((_, i) => seg.slice(i).reduce((a, b) => a + b, 0));
}

// 阈值对全部深度相同（给孔口与孔底两条代表深度）
const thresholds: ThresholdEntry[] = [
  { depth: 0.5, blue: 1, yellow: 2, red: 4 },
  { depth: 2.0, blue: 1, yellow: 2, red: 4 },
];

const boreholeInput = (): BoreholeInput => ({
  code: 'BH-3',
  depth: 2.0,
  spacing: 0.5,
  positiveDirection: 'N23E',
  checksumTolerance: 0.01,
  thresholds,
});

const DAY0 = Date.parse('2024-02-01T00:00:00Z');
function measurement(day: number, rd: MeasurementInput['readings'], extra: Partial<MeasurementInput> = {}): MeasurementInput {
  return {
    measuredAt: new Date(DAY0 + day * 86_400_000).toISOString(),
    probeCode: 'P1',
    readings: rd,
    ...extra,
  };
}

let repo: MemoryRepository;
let monitor: MonitorService;
let query: QueryService;

beforeEach(async () => {
  clockMs = Date.parse('2024-01-01T00:00:00Z');
  repo = new MemoryRepository();
  monitor = new MonitorService(repo, clock);
  query = new QueryService(repo);
  await monitor.registerProbe({ code: 'P1' });
  tick();
  await monitor.addCalibration({ probeCode: 'P1', effectiveAt: '2024-01-01', factor: 1 });
  tick();
  await monitor.createBorehole(boreholeInput());
  tick();
});

async function add(day: number, rd: MeasurementInput['readings'], extra: Partial<MeasurementInput> = {}) {
  const { id } = await monitor.addMeasurement('BH-3', measurement(day, rd, extra));
  tick();
  return id;
}

async function latestResult(measurementId: string): Promise<ResultJson> {
  return (await query.measurementDetail(measurementId)).result!;
}

async function expectProfile(id: string, expectedMm: number[]) {
  const r = await latestResult(id);
  expect(r.points.map((p) => p.relativeDisplacement)).toEqual(expectedMm.map((v) => expect.closeTo(v, 10)));
}

describe('基准与剖面', () => {
  it('读数全部等于初始测量时位移处处为零', async () => {
    const id0 = await add(0, ZERO());
    const id1 = await add(2, ZERO());
    const r0 = await latestResult(id0);
    const r1 = await latestResult(id1);
    expect(r0.points.every((p) => p.relativeDisplacement === 0)).toBe(true);
    expect(r1.points.every((p) => p.relativeDisplacement === 0)).toBe(true);
    expect(r1.points.every((p) => p.rate === 0)).toBe(true);
  });

  it('探头系数变为两倍而读数不变时位移变为两倍', async () => {
    await add(0, ZERO());
    // 升序段 tilt 0.002,0.004,0,0：后缀累加 [3,2,0,0]
    const tilts = [0.002, 0.004, 0, 0];
    expect(cum(tilts)).toEqual([3, 2, 0, 0]);
    const idMove = await add(2, readingsFromTilts(tilts));
    await expectProfile(idMove, [3, 2, 0, 0]);

    await monitor.addCalibration({ probeCode: 'P1', effectiveAt: '2024-01-15', factor: 2 });
    tick();
    await expectProfile(idMove, [6, 4, 0, 0]);
  });

  it('把正反测读数互换，位移变号', async () => {
    await add(0, ZERO());
    const tilts = [0.002, 0.004, 0, 0.001];
    const rd = readingsFromTilts(tilts);
    const idA = await add(2, rd);
    const swapped = rd.map((r) => ({ ...r, forward: r.reverse, reverse: r.forward }));
    const idB = await add(4, swapped);
    const a = await latestResult(idA);
    const b = await latestResult(idB);
    a.points.forEach((p, i) => expect(b.points[i]!.relativeDisplacement).toBeCloseTo(-p.relativeDisplacement, 10));
  });
});

describe('更正、重算与一致性', () => {
  it('更正后增量结果与全量重算完全一致', async () => {
    const id0 = await add(0, ZERO());
    const t1 = [0.002, 0.002, 0, 0]; // 累计 [2,1,0,0]
    const t2 = [0.004, 0.004, 0.002, 0]; // 累计 [5,3,1,0]
    expect(cum(t1)).toEqual([2, 1, 0, 0]);
    expect(cum(t2)).toEqual([5, 3, 1, 0]);
    const id1 = await add(2, readingsFromTilts(t1));
    const id2 = await add(4, readingsFromTilts(t2));

    const counts = async () =>
      Object.fromEntries(
        await Promise.all([id0, id1, id2].map(async (id) => [id, (await query.measurementDetail(id)).snapshotHistory.length] as const)),
      );
    expect(await counts()).toEqual({ [id0]: 1, [id1]: 1, [id2]: 1 });

    // 更正中间一次测量为新剖面，累计 [6,3,1,0]
    const detail = (await query.measurementDetail(id1)).measurement;
    const t1b = [0.006, 0.004, 0.002, 0];
    expect(cum(t1b)).toEqual([6, 3, 1, 0]);
    await monitor.correctMeasurement(id1, detail.revision, measurement(2, readingsFromTilts(t1b)));
    tick();

    // id1 剖面变（新快照）；id2 相对剖面不变（基准仍是 id0），但与 id1 的速率变（新快照）
    const afterCorrect = await counts();
    expect(afterCorrect[id0]).toBe(1);
    expect(afterCorrect[id1]).toBe(2);
    expect(afterCorrect[id2]).toBe(2);

    // 强制全量重算：内容相同不得新增快照；服务内还有逐数值一致性断言（不一致直接抛错）
    const agg = await monitor.getBoreholeByCode('BH-3');
    await monitor.forceFullRecompute(agg.borehole.id);
    tick();
    expect(await counts()).toEqual(afterCorrect);

    await expectProfile(id1, cum(t1b));
    await expectProfile(id2, cum(t2));
    // 孔口速率 = (5 - 6)/2d = -0.5 mm/d
    expect((await latestResult(id2)).points[0]!.rate).toBeCloseTo(-0.5, 10);
  });

  it('补录到已有测量中间，前后两次的速率按新顺序重算', async () => {
    await add(0, ZERO());
    // 第 4 天孔口 8mm：2mm/d
    const t4 = [0.008, 0.008, 0, 0];
    expect(cum(t4)[0]).toBe(8);
    const id4 = await add(4, readingsFromTilts(t4));
    expect((await latestResult(id4)).points[0]!.rate).toBeCloseTo(2, 10);

    // 第 2 天补录：孔口 4mm
    const t2 = [0.004, 0.004, 0, 0];
    const id2 = (await monitor.addMeasurement('BH-3', measurement(2, readingsFromTilts(t2)))).id;
    tick();
    expect((await latestResult(id2)).points[0]!.rate).toBeCloseTo(2, 10);
    expect((await latestResult(id4)).points[0]!.rate).toBeCloseTo(2, 10);

    // 第 3 天再补：孔口 7mm
    const t3 = [0.008, 0.006, 0, 0];
    expect(cum(t3)[0]).toBe(7);
    const id3 = (await monitor.addMeasurement('BH-3', measurement(3, readingsFromTilts(t3)))).id;
    tick();
    // 2→3：(7-4)/1 = 3
    expect((await latestResult(id3)).points[0]!.rate).toBeCloseTo(3, 10);
    // 3→4：(8-7)/1 = 1（旧“相对 id2 的 2mm/d”必须已被新顺序覆盖）
    expect((await latestResult(id4)).points[0]!.rate).toBeCloseTo(1, 10);
  });

  it('同一次测量被两个人同时更正，只生效一次，另一次得到冲突提示', async () => {
    await add(0, ZERO());
    // 第 2 天最浅测段 tilt=0.001 → 孔口 0.5mm
    const id = await add(2, readingsFromTilts([0.001, 0, 0, 0]));
    await expectProfile(id, [0.5, 0, 0, 0]);
    const { revision } = (await query.measurementDetail(id)).measurement;

    // 两人都基于 revision=1：改成孔口 2mm / 3mm
    const p1 = monitor.correctMeasurement(id, revision, measurement(2, readingsFromTilts([0.004, 0, 0, 0])));
    const p2 = monitor.correctMeasurement(id, revision, measurement(2, readingsFromTilts([0.006, 0, 0, 0])));
    const results = await Promise.allSettled([p1, p2]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RevisionConflictError);
    tick();

    // 先提交者（2mm）生效，3mm 绝不静默覆盖
    await expectProfile(id, [2, 0, 0, 0]);

    // 失败者读取新版本后重试，可以成功
    const current = (await query.measurementDetail(id)).measurement.revision;
    await monitor.correctMeasurement(id, current, measurement(2, readingsFromTilts([0.006, 0, 0, 0])));
    tick();
    await expectProfile(id, [3, 0, 0, 0]);
  });
});

describe('历史判级', () => {
  it('“按当时数据”与“按现在数据”都可查，且列出差异', async () => {
    await add(0, ZERO());
    // 第 2 天孔口 3mm → 1.5mm/d，蓝
    const id = await add(2, readingsFromTilts([0.006, 0, 0, 0]));
    const blueView = await monitor.historicalGrade(id, clockMs);
    expect(blueView.current.level).toBe('blue');
    // 蓝快照写入时刻（更正之前），用于之后的“按当时”查询
    const atBlue = Date.parse(blueView.current.computedAt);

    // 更正为孔口 9mm → 4.5mm/d，红
    const detail = (await query.measurementDetail(id)).measurement;
    await monitor.correctMeasurement(id, detail.revision, measurement(2, readingsFromTilts([0.018, 0, 0, 0])));
    tick();
    const diff = await monitor.historicalGrade(id, atBlue);
    expect(diff.changed).toBe(true);
    expect(diff.asOf.level).toBe('blue');
    expect(diff.current.level).toBe('red');
    expect(diff.asOf.result.maxAbsRate).toBeCloseTo(1.5, 10);
    expect(diff.current.result.maxAbsRate).toBeCloseTo(4.5, 10);
  });
});

describe('输入拒收', () => {
  const catchErr = (p: Promise<unknown>) => p.then(() => null).catch((e) => e as ValidationError);

  it('深度不等间距/与孔深不符/重复深度 都给出具体字段', async () => {
    const grid = await catchErr(
      monitor.addMeasurement('BH-3', measurement(1, [
        { depth: 0.5, forward: 1, reverse: 1 },
        { depth: 1.2, forward: 1, reverse: 1 },
        { depth: 1.5, forward: 1, reverse: 1 },
        { depth: 2.0, forward: 1, reverse: 1 },
      ])),
    );
    expect(grid).toBeInstanceOf(ValidationError);
    expect(grid!.errors.some((e) => e.field === 'readings' && /网格|间距/.test(e.message))).toBe(true);

    const dup = await catchErr(
      monitor.addMeasurement('BH-3', measurement(1, [
        { depth: 0.5, forward: 1, reverse: 1 },
        { depth: 0.5, forward: 1, reverse: 1 },
        { depth: 1.5, forward: 1, reverse: 1 },
        { depth: 2.0, forward: 1, reverse: 1 },
      ])),
    );
    expect(dup).toBeInstanceOf(ValidationError);
    expect(dup!.errors.some((e) => /出现两次/.test(e.message))).toBe(true);

    const missing = await catchErr(
      monitor.addMeasurement('BH-3', measurement(1, [
        { depth: 0.5, forward: 1, reverse: 1 },
        { depth: 1.0, forward: 1, reverse: 1 },
        { depth: 1.5, forward: 1, reverse: 1 },
      ])),
    );
    expect(missing).toBeInstanceOf(ValidationError);
    expect(missing!.errors.some((e) => /点数|缺少深度/.test(e.message))).toBe(true);
  });

  it('读数不是有限数、日期早于初始、探头未登记、阈值不递增', async () => {
    await add(0, ZERO());

    const nanErr = await catchErr(
      monitor.addMeasurement('BH-3', measurement(1, [
        { depth: 0.5, forward: Number.NaN, reverse: 1 },
        { depth: 1.0, forward: 1, reverse: Infinity },
        { depth: 1.5, forward: 1, reverse: 1 },
        { depth: 2.0, forward: 1, reverse: 1 },
      ])),
    );
    expect(nanErr).toBeInstanceOf(ValidationError);
    expect(nanErr!.errors.some((e) => /有限数/.test(e.message))).toBe(true);

    const dateErr = await catchErr(monitor.addMeasurement('BH-3', measurement(-1, ZERO())));
    expect(dateErr).toBeInstanceOf(ValidationError);
    expect(dateErr!.errors.some((e) => e.field === 'measuredAt' && /早于/.test(e.message))).toBe(true);

    const probeErr = await catchErr(
      monitor.addMeasurement('BH-3', measurement(1, ZERO(), { probeCode: 'NO-SUCH' })),
    );
    expect(probeErr).toBeInstanceOf(ValidationError);
    expect(probeErr!.errors.some((e) => /没有登记/.test(e.message))).toBe(true);

    const thErr = await catchErr(
      monitor.createBorehole({
        ...boreholeInput(),
        code: 'BH-X',
        thresholds: [{ depth: 0.5, blue: 3, yellow: 2, red: 1 }],
      }),
    );
    expect(thErr).toBeInstanceOf(ValidationError);
    expect(thErr!.errors.some((e) => /严格递增/.test(e.message))).toBe(true);
  });
});

describe('基准切换拼接（换探头）', () => {
  async function registerProbe2(code: string) {
    await monitor.registerProbe({ code });
    tick();
    await monitor.addCalibration({ probeCode: code, effectiveAt: '2024-01-01', factor: 1 });
    tick();
  }

  /** 用户复现场景：孔深 2m / 间距 0.5m，阈值蓝1黄2红4。 */
  async function setupRepro() {
    await registerProbe2('P2');
    await add(0, ZERO());
    // 第 2 天（旧探头）：升序段 0.004,0.004,0,0 → 累计 [4,2,0,0]
    await add(2, readingsFromTilts([0.004, 0.004, 0, 0]));
    // 第 4 天换新探头复测并标为换探头新基准；新探头每段带 0.002 常数零漂
    const idReset = await add(4, readingsFromTilts([0.006, 0.006, 0.002, 0.002]), {
      probeCode: 'P2',
      datumReset: true,
      datumReason: 'probe_change',
    });
    // 第 6 天：浅部继续变形（新探头读数，零漂仍在）
    const idLast = await add(6, readingsFromTilts([0.008, 0.008, 0.002, 0.002]), { probeCode: 'P2' });
    return { idReset, idLast };
  }

  it('换探头当天：剖面与旧段末测逐深度一致 [4,2,0,0]，孔底为零，速率全零，不预警', async () => {
    const { idReset } = await setupRepro();
    const reset = await latestResult(idReset);
    // 新段内相对剖面处处 0
    expect(reset.points.every((p) => p.relativeDisplacement === 0)).toBe(true);
    // 逐深度冻结拼接：不再是清一色 1mm，孔底固定点保持 0
    expect(reset.points.map((p) => p.connectedDisplacement)).toEqual([4, 2, 0, 0].map((v) => expect.closeTo(v, 10)));
    // 跨基准首条速率严格为 0（连浮点残差都没有），不触发任何预警
    expect(reset.points.every((p) => p.rate === 0)).toBe(true);
    expect(reset.maxAbsRate).toBe(0);
    expect(reset.level).toBe('none');
    expect(reset.datumIndex).toBe(1);
    // 逐点仍打跨基准标记，提醒这是按“零漂移”假设对齐出来的速率
    expect(reset.points.every((p) => p.crossDatum)).toBe(true);

    const overlay = await query.profileOverlay('BH-3', 'all', true);
    expect(overlay.boundaries).toHaveLength(1);
    expect(overlay.boundaries[0]!.measurementId).toBe(idReset);
    expect(overlay.boundaries[0]!.anchors).toEqual([4, 2, 0, 0].map((v) => expect.closeTo(v, 10)));
  });

  it('换探头之后：第 6 天剖面为 [6,3,0,0]，与换探头前的曲线接得上，速率 [1,0.5,0,0]', async () => {
    const { idReset, idLast } = await setupRepro();
    const last = await latestResult(idLast);
    expect(last.points.map((p) => p.connectedDisplacement)).toEqual([6, 3, 0, 0].map((v) => expect.closeTo(v, 10)));
    // 孔底固定点仍为 0
    expect(last.points[3]!.connectedDisplacement).toBe(0);
    expect(last.points.map((p) => p.rate)).toEqual([1, 0.5, 0, 0].map((v) => expect.closeTo(v, 10)));
    // 孔口速率恰为蓝阈值 1（浮点噪声由定级容差吸收，等于阈值不预警）
    expect(last.level).toBe('none');
    expect(last.points.some((p) => p.crossDatum)).toBe(false);

    // 叠加图：第 2 天末测与第 4 天复测完全重合，整条新段曲线与旧段接得上
    const all = (await query.borehole('BH-3')).measurements;
    const id2 = all[1]!.id;
    const overlay = await query.profileOverlay('BH-3', 'all', true);
    const byId = new Map(overlay.series.map((s) => [s.measurementId, s.values]));
    expect(byId.get(id2)).toEqual(byId.get(idReset));
    expect(byId.get(idLast)).toEqual([6, 3, 0, 0].map((v) => expect.closeTo(v, 10)));
  });

  it('更正换探头之前的测量：后面各次剖面/速率/等级跟着更新；“按当时数据”的判级仍可查', async () => {
    const { idReset, idLast } = await setupRepro();
    // 第 2 天原始 [4,2,0,0]，孔口速率 2 mm/d（严格大于蓝1、不大于黄2）→ 蓝
    const id2 = (await query.borehole('BH-3')).measurements[1]!.id;
    expect((await latestResult(id2)).points[0]!.rate).toBeCloseTo(2, 10);
    expect((await latestResult(id2)).level).toBe('blue');
    const blueView = await monitor.historicalGrade(id2, clockMs);
    expect(blueView.current.level).toBe('blue');
    const atBlue = Date.parse(blueView.current.computedAt);

    const counts = async () => {
      const ids = [(await query.borehole('BH-3')).measurements[0]!.id, id2, idReset, idLast];
      return Object.fromEntries(
        await Promise.all(ids.map(async (id) => [id, (await query.measurementDetail(id)).snapshotHistory.length] as const)),
      );
    };
    expect(Object.values(await counts()).every((n) => n === 1)).toBe(true);

    // 把第 2 天更正为 [1,0,0,0]（升序段 0.002,0,0,0）：第 2 天速率 0.5 → 无预警
    const detail = (await query.measurementDetail(id2)).measurement;
    await monitor.correctMeasurement(id2, detail.revision, measurement(2, readingsFromTilts([0.002, 0, 0, 0])));
    tick();

    // 第 2 天自身变为 [1,0,0,0]、速率 0.5 → 无预警
    const r2 = await latestResult(id2);
    expect(r2.points.map((p) => p.connectedDisplacement)).toEqual([1, 0, 0, 0].map((v) => expect.closeTo(v, 10)));
    expect(r2.level).toBe('none');
    // 复测当天锚点跟着挪到 [1,0,0,0]，速率仍全零、不预警
    const rReset = await latestResult(idReset);
    expect(rReset.points.map((p) => p.connectedDisplacement)).toEqual([1, 0, 0, 0].map((v) => expect.closeTo(v, 10)));
    expect(rReset.points.every((p) => p.rate === 0)).toBe(true);
    expect(rReset.level).toBe('none');
    // 第 6 天整体跟随为 [3,1,0,0]；段内速率 [1,0.5,0,0] 不受更正影响
    const rLast = await latestResult(idLast);
    expect(rLast.points.map((p) => p.connectedDisplacement)).toEqual([3, 1, 0, 0].map((v) => expect.closeTo(v, 10)));
    expect(rLast.points.map((p) => p.rate)).toEqual([1, 0.5, 0, 0].map((v) => expect.closeTo(v, 10)));

    // 受影响的三次都写了新快照，首测未变；强制全量重算不再新增
    const after = await counts();
    expect(after[(await query.borehole('BH-3')).measurements[0]!.id]).toBe(1);
    expect(after[id2]).toBe(2);
    expect(after[idReset]).toBe(2);
    expect(after[idLast]).toBe(2);
    const agg = await monitor.getBoreholeByCode('BH-3');
    await monitor.forceFullRecompute(agg.borehole.id);
    tick();
    expect(await counts()).toEqual(after);

    // “按当时数据”：蓝；“按现在数据”：无预警，两者都能查到
    const diff = await monitor.historicalGrade(id2, atBlue);
    expect(diff.changed).toBe(true);
    expect(diff.asOf.level).toBe('blue');
    expect(diff.current.level).toBe('none');
  });

  it('在旧探头末测与换探头复测之间补录：锚点改用补录末测，复测速率仍为零，后续曲线跟随', async () => {
    await registerProbe2('P2');
    await add(0, ZERO());
    // 先只有 第4天换探头复测、第6天跟进：此时锚点冻结在第 0 天 [0,0,0,0]
    await add(4, readingsFromTilts([0.006, 0.006, 0.002, 0.002]), {
      probeCode: 'P2',
      datumReset: true,
      datumReason: 'probe_change',
    });
    const id6 = await add(6, readingsFromTilts([0.008, 0.008, 0.002, 0.002]), { probeCode: 'P2' });
    expect((await latestResult((await query.borehole('BH-3')).measurements[1]!.id)).points.map((p) => p.connectedDisplacement))
      .toEqual([0, 0, 0, 0].map((v) => expect.closeTo(v, 10)));

    // 补录第 2 天旧探头测量 [4,2,0,0]
    await monitor.addMeasurement('BH-3', measurement(2, readingsFromTilts([0.004, 0.004, 0, 0])));
    tick();
    // 时间顺序变为 第0天, 第2天, 第4天复测, 第6天
    const inOrder = (await query.borehole('BH-3')).measurements;
    const resetId = inOrder[2]!.id;
    const reset = await latestResult(resetId);
    expect(reset.points.map((p) => p.connectedDisplacement)).toEqual([4, 2, 0, 0].map((v) => expect.closeTo(v, 10)));
    expect(reset.points.every((p) => p.rate === 0)).toBe(true);
    const last = await latestResult(id6);
    expect(last.points.map((p) => p.connectedDisplacement)).toEqual([6, 3, 0, 0].map((v) => expect.closeTo(v, 10)));
    expect(last.points.map((p) => p.rate)).toEqual([1, 0.5, 0, 0].map((v) => expect.closeTo(v, 10)));
    const overlay = await query.profileOverlay('BH-3', 'all', true);
    expect(overlay.boundaries[0]!.anchors).toEqual([4, 2, 0, 0].map((v) => expect.closeTo(v, 10)));
  });

  it('连换两次探头（中间段只有一次测量）：两次复测都冻结在同一剖面，之后的变形照常累计', async () => {
    await registerProbe2('P2');
    await registerProbe2('P3');
    await add(0, ZERO());
    await add(2, readingsFromTilts([0.004, 0.004, 0, 0])); // [4,2,0,0]
    // P2 常数零漂 0.002/段
    const idR1 = await add(4, readingsFromTilts([0.006, 0.006, 0.002, 0.002]), {
      probeCode: 'P2',
      datumReset: true,
      datumReason: 'probe_change',
    });
    // 紧接着又换 P3（P3 常数零漂 0.003/段，漂移形状不同），中间段只有第 4 天一次测量
    const idR2 = await add(6, readingsFromTilts([0.007, 0.007, 0.003, 0.003]), {
      probeCode: 'P3',
      datumReset: true,
      datumReason: 'probe_change',
    });
    // 第 8 天：浅部两段各再增 0.004/0.004 物理倾斜（P3 读数）
    const id8 = await add(8, readingsFromTilts([0.011, 0.011, 0.003, 0.003]), { probeCode: 'P3' });

    for (const id of [idR1, idR2]) {
      const r = await latestResult(id);
      expect(r.points.every((p) => p.relativeDisplacement === 0)).toBe(true);
      expect(r.points.map((p) => p.connectedDisplacement)).toEqual([4, 2, 0, 0].map((v) => expect.closeTo(v, 10)));
      expect(r.points.every((p) => p.rate === 0)).toBe(true);
      expect(r.level).toBe('none');
    }
    expect((await latestResult(idR2)).datumIndex).toBe(2);
    // 第 8 天：冻结的 [4,2] + 段内相对 [4,2] = [8,4]，孔底始终 0；速率 [2,1,0,0]
    const r8 = await latestResult(id8);
    expect(r8.points.map((p) => p.connectedDisplacement)).toEqual([8, 4, 0, 0].map((v) => expect.closeTo(v, 10)));
    expect(r8.points.map((p) => p.rate)).toEqual([2, 1, 0, 0].map((v) => expect.closeTo(v, 10)));

    const overlay = await query.profileOverlay('BH-3', 'all', true);
    expect(overlay.boundaries).toHaveLength(2);
    for (const b of overlay.boundaries) expect(b.anchors).toEqual([4, 2, 0, 0].map((v) => expect.closeTo(v, 10)));

    // 增量 ≡ 全量：强制全量重算不产生任何新快照（服务内还有逐数值断言）
    const agg = await monitor.getBoreholeByCode('BH-3');
    const snapshotCounts = async () => {
      const ms = (await query.borehole('BH-3')).measurements;
      return Promise.all(ms.map(async (m) => (await query.measurementDetail(m.id)).snapshotHistory.length));
    };
    const countsBefore = await snapshotCounts();
    await monitor.forceFullRecompute(agg.borehole.id);
    tick();
    expect(await snapshotCounts()).toEqual(countsBefore);
  });
});
