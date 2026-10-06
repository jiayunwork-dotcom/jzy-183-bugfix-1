import type { PreparedMeasurement, EngineBorehole, EngineProbe, EngineMeasurement } from './types.js';
import { flagSuspicious, validateDepthGrid } from './geometry.js';

function factorAt(probe: EngineProbe | undefined, measuredAtMs: number): number {
  if (!probe || probe.calibrations.length === 0) {
    throw new Error(`探头 ${probe?.code ?? '?'} 在该时刻没有生效标定`);
  }
  const valid = probe.calibrations
    .filter((c) => c.effectiveAtMs <= measuredAtMs)
    .sort((a, b) => b.effectiveAtMs - a.effectiveAtMs);
  if (valid.length === 0) {
    throw new Error(`探头 ${probe.code} 的标定生效时间晚于测量时间`);
  }
  return valid[0]!.factor;
}

/**
 * 逐次测量的单孔预处理：
 *  - 校验深度网格
 *  - 解析每个深度正/反测所用探头及其在 measuredAt 生效的标定系数
 *  - tilt = (forward - reverse) * factor （无量纲，正弦值近似；
 *    正反测互换即变号，方向约定与“正方向朝向”一致）
 *  - segmentDisplacement = tilt * spacing(mm)
 *  - cumulativeRaw：从孔底固定点逐段累加（深度降序累加，见 docs/datum.md）
 *  - checksum = forward + reverse，并按中位数/MAD 标记可疑点
 *
 * 返回按深度降序（孔口 → 孔底方向索引为 0..n-1，
 * points[i] 对应第 i 个测段、深度 = (n-i)*spacing）的准备结果，
 * 与“从孔底往上逐段累加”的叙述一致。
 */
export function prepareMeasurements(
  borehole: EngineBorehole,
  probes: Map<string, EngineProbe>,
  measurements: EngineMeasurement[],
): PreparedMeasurement[] {
  const sorted = [...measurements].sort((a, b) => a.measuredAtMs - b.measuredAtMs || a.id.localeCompare(b.id));

  return sorted.map((m) => {
    const { order } = validateDepthGrid(
      m.rows.map((r) => r.depth),
      borehole.depth,
      borehole.spacing,
    );
    // 按深度升序：0.5, 1.0, … depth
    const ascending = order.map((idx) => m.rows[idx]!);

    const tilt: number[] = [];
    const segDisp: number[] = [];
    const checksums: number[] = [];
    const usedForward: string[] = [];
    const usedReverse: string[] = [];
    const facForward: number[] = [];
    const facReverse: number[] = [];

    for (const row of ascending) {
      const codeF = row.probeCodeForward || m.probeCode;
      const codeR = row.probeCodeReverse || m.probeCode;
      const probeF = probes.get(codeF);
      const probeR = probes.get(codeR);
      if (!probeF) throw new Error(`探头编号 ${codeF} 没有登记`);
      if (!probeR) throw new Error(`探头编号 ${codeR} 没有登记`);
      const fF = factorAt(probeF, m.measuredAtMs);
      const fR = factorAt(probeR, m.measuredAtMs);
      // 正反测通常同一探头、同一系数；允许两个方向分别解析。
      const factor = (fF + fR) / 2;
      tilt.push((row.forward - row.reverse) * factor);
      segDisp.push(0);
      checksums.push(row.forward + row.reverse);
      usedForward.push(codeF);
      usedReverse.push(codeR);
      facForward.push(fF);
      facReverse.push(fR);
    }

    const spacingMm = borehole.spacing * 1000;
    for (let i = 0; i < tilt.length; i++) segDisp[i] = tilt[i]! * spacingMm;

    // 从孔底（最深行）往上累加：cum[i]（升序数组）= sum_{j>=i} seg[j]
    const n = segDisp.length;
    const cumRawAsc: number[] = new Array(n).fill(0);
    let acc = 0;
    for (let i = n - 1; i >= 0; i--) {
      acc += segDisp[i]!;
      cumRawAsc[i] = acc;
    }

    const suspiciousAsc = flagSuspicious(checksums, borehole.checksumTolerance);

    // 转成深度降序，便于上层“从孔底往上”叙述；保留升序数值映射。
    const points = ascending.map((row, idxAsc) => ({
      depth: row.depth,
      tilt: tilt[idxAsc]!,
      segmentDisplacement: segDisp[idxAsc]!,
      cumulativeRaw: cumRawAsc[idxAsc]!,
      checksum: checksums[idxAsc]!,
      suspicious: suspiciousAsc[idxAsc]!,
      usedProbeForward: usedForward[idxAsc]!,
      usedProbeReverse: usedReverse[idxAsc]!,
      factorForward: facForward[idxAsc]!,
      factorReverse: facReverse[idxAsc]!,
    }));

    return { measurement: m, points };
  });
}
