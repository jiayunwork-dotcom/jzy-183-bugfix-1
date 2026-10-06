import type { AlarmLevel, ThresholdEntry } from '@incli/shared';

export function median(sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 === 1 ? sortedAsc[mid]! : (sortedAsc[mid - 1]! + sortedAsc[mid]!) / 2;
}

function sortedCopy(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/**
 * 校核和可疑判定。
 *
 * checksum_i = forward_i + reverse_i（原始读数和），理论上沿孔深近似常数。
 * 用同孔全部深度的中位数作为该常数的稳健估计，MAD 估计离散度：
 *   偏差 > tolerance + 3 * 1.4826 * MAD  标记可疑（不剔除，仅标记）。
 * 3σ 对应正态下约 0.3% 的误报；MAD 为 0 时退回固定容差，干净数据不会误报。
 */
export function flagSuspicious(checksums: number[], tolerance: number): boolean[] {
  if (checksums.length === 0) return [];
  const med = median(sortedCopy(checksums));
  const mad = median(sortedCopy(checksums.map((c) => Math.abs(c - med))));
  const sigma = 1.4826 * mad;
  const limit = tolerance + 3 * sigma;
  return checksums.map((c) => Math.abs(c - med) > limit);
}

/**
 * 按深度取阈值。该孔只给若干代表深度时，中间深度线性插值，
 * 浅于最浅条目取最浅条目，深于最深条目取最深条目。
 */
export function thresholdsAtDepth(thresholds: ThresholdEntry[], depth: number): ThresholdEntry {
  const t = [...thresholds].sort((a, b) => a.depth - b.depth);
  if (t.length === 0) {
    return { depth, blue: Infinity, yellow: Infinity, red: Infinity };
  }
  if (depth <= t[0]!.depth) return { ...t[0]!, depth };
  for (let i = 1; i < t.length; i++) {
    const lo = t[i - 1]!;
    const hi = t[i]!;
    if (depth <= hi.depth) {
      const f = (depth - lo.depth) / (hi.depth - lo.depth || 1);
      return {
        depth,
        blue: lo.blue + (hi.blue - lo.blue) * f,
        yellow: lo.yellow + (hi.yellow - lo.yellow) * f,
        red: lo.red + (hi.red - lo.red) * f,
      };
    }
  }
  return { ...t[t.length - 1]!, depth };
}

/** 速率（绝对值）对照蓝/黄/红阈值定级。 */
export function classifyRate(absRate: number, th: ThresholdEntry): AlarmLevel {
  if (Number.isFinite(th.red) && absRate > th.red) return 'red';
  if (Number.isFinite(th.yellow) && absRate > th.yellow) return 'yellow';
  if (Number.isFinite(th.blue) && absRate > th.blue) return 'blue';
  return 'none';
}

export const LEVEL_RANK: Record<AlarmLevel, number> = { none: 0, blue: 1, yellow: 2, red: 3 };

/**
 * 校验深度序列：必须为 spacing、2*spacing、…、depth（等间距且与孔深相符）。
 * 浮点数用 1e-6 m 的绝对容差比较。返回按深度升序排好的行下标。
 */
export function validateDepthGrid(depthsInput: number[], depth: number, spacing: number): { order: number[]; errors: string[] } {
  const errors: string[] = [];
  const indexed = depthsInput.map((d, i) => ({ d, i }));
  indexed.sort((a, b) => a.d - b.d);

  const expectedCount = Math.round(depth / spacing);
  if (Math.abs(expectedCount * spacing - depth) > 1e-6) {
    errors.push(`孔深 ${depth} 不是测点间距 ${spacing} 的整数倍`);
  }
  if (indexed.length !== expectedCount) {
    errors.push(`深度点数 ${indexed.length} 与 孔深/间距 = ${expectedCount} 不符`);
  }
  const seen = new Set<number>();
  indexed.forEach(({ d }) => {
    const key = Math.round(d / spacing);
    if (seen.has(key)) errors.push(`深度 ${d} m 出现两次`);
    seen.add(key);
  });
  for (let k = 1; k <= expectedCount; k++) {
    if (!seen.has(k)) errors.push(`缺少深度 ${+(k * spacing).toFixed(6)} m 的读数`);
  }
  indexed.forEach(({ d }) => {
    const k = Math.round(d / spacing);
    if (Math.abs(d - k * spacing) > 1e-6) {
      errors.push(`深度 ${d} m 不在间距 ${spacing} m 的网格上`);
    }
    if (d <= 0 || d > depth + 1e-6) {
      errors.push(`深度 ${d} m 超出孔深范围 (0, ${depth}]`);
    }
  });
  return { order: indexed.map((x) => x.i), errors };
}
