import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { MemoryRepository } from '../storage/index.js';
import { MonitorService } from '../domain/monitorService.js';
import { QueryService } from '../domain/queryService.js';
import { registerRoutes } from './routes.js';

const DEPTHS = [0.5, 1, 1.5];
function rows(tiltsAsc: number[]) {
  return DEPTHS.map((depth, i) => {
    const d = tiltsAsc[i]!;
    return { depth, forward: 0.5 + d / 2, reverse: 0.5 - d / 2 };
  });
}

describe('HTTP 全链路（Fastify inject + 内存仓库）', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    const repo = new MemoryRepository();
    await registerRoutes(app, {
      monitor: new MonitorService(repo),
      query: new QueryService(repo),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('完整业务流：登记探头 → 录孔 → 两次测量 → 总览 → 叠加 → 更正冲突 → 历史', async () => {
    const post = (url: string, body: unknown) =>
      app.inject({ method: 'POST', url, payload: body as never });
    const get = (url: string) => app.inject({ method: 'GET', url });

    expect((await post('/api/probes', { code: 'P1' })).statusCode).toBe(201);
    expect(
      (
        await post('/api/calibrations', {
          probeCode: 'P1',
          effectiveAt: '2024-01-01',
          factor: 1,
        })
      ).statusCode,
    ).toBe(201);

    const bh = await post('/api/boreholes', {
      code: 'H-1',
      depth: 1.5,
      spacing: 0.5,
      positiveDirection: 'N',
      checksumTolerance: 0.01,
      thresholds: [
        { depth: 0.5, blue: 1, yellow: 2, red: 4 },
        { depth: 1.5, blue: 1, yellow: 2, red: 4 },
      ],
    });
    expect(bh.statusCode).toBe(201);

    // 粘贴文本上传（含一个表头行）
    const text = [
      'depth fwd rev',
      '0.5 0.5 0.5',
      '1.0 0.5 0.5',
      '1.5 0.5 0.5',
    ].join('\n');
    const m1 = await post('/api/boreholes/H-1/measurements', {
      text,
      measuredAt: '2024-02-01',
      probeCode: 'P1',
    });
    expect(m1.statusCode).toBe(201);
    const m1Id = (await m1.json()).id;

    // 第 2 天孔口 3mm（1.5mm/d，蓝）
    const m2 = await post('/api/boreholes/H-1/measurements', {
      measuredAt: '2024-02-03',
      probeCode: 'P1',
      readings: rows([0.006, 0, 0]),
    });
    expect(m2.statusCode).toBe(201);
    const m2Id = (await m2.json()).id;

    const overview = await (await get('/api/boreholes')).json();
    expect(overview.items[0].code).toBe('H-1');
    expect(overview.items[0].level).toBe('blue');

    const overlay = await (await get('/api/boreholes/H-1/overlay?measurements=all&connected=1')).json();
    expect(overlay.series).toHaveLength(2);
    expect(overlay.series[1].values[0]).toBeCloseTo(3, 10);

    // 422：未知探头
    const bad = await post('/api/boreholes/H-1/measurements', {
      measuredAt: '2024-02-04',
      probeCode: 'NOPE',
      readings: rows([0, 0, 0]),
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors.some((e: { message: string }) => /没有登记/.test(e.message))).toBe(true);

    // 409：基于不存在的旧版本更正
    const conflict = await post(`/api/measurements/${m2Id}/correct`, {
      baseRevision: 99,
      measuredAt: '2024-02-03',
      probeCode: 'P1',
      readings: rows([0.018, 0, 0]),
    });
    expect(conflict.statusCode).toBe(409);

    // 正常更正到红色（4.5mm/d）
    const ok = await post(`/api/measurements/${m2Id}/correct`, {
      baseRevision: 1,
      measuredAt: '2024-02-03',
      probeCode: 'P1',
      readings: rows([0.018, 0, 0]),
    });
    expect(ok.statusCode).toBe(200);

    // 历史判级：asOf 取更正之前（2024-02-03 当天测量之后、更正之前）
    const hist = (await get(`/api/measurements/${m2Id}/history?asOf=2024-02-04T00:00:00Z`)).json();
    expect(hist.changed).toBe(true);
    expect(hist.asOf.level).toBe('blue');
    expect(hist.current.level).toBe('red');

    // 首次测量的详情：相对位移 0，校核和齐全
    const detail = (await get(`/api/measurements/${m1Id}`)).json();
    expect(detail.result.points.every((p: { relativeDisplacement: number }) => p.relativeDisplacement === 0)).toBe(true);
    expect(detail.snapshotHistory.length).toBe(1);
  });
});
