import { createHash } from 'node:crypto';

/**
 * 输入指纹：决定一次测量计算结果的全部输入。
 * 包含读数、逐行探头、时间、基准标记，以及在 measuredAt 生效的标定系数。
 * 任何一项变化都会使指纹改变，增量重算据此判断相对剖面可否复用。
 */
export function makeInputToken(input: {
  measuredAtMs: number;
  probeCode: string;
  datumReset: boolean;
  datumReason: string;
  rows: {
    depth: number;
    forward: number;
    reverse: number;
    probeCodeForward: string;
    probeCodeReverse: string;
    factorForward: number;
    factorReverse: number;
  }[];
}): string {
  const h = createHash('sha256');
  h.update(
    JSON.stringify({
      t: input.measuredAtMs,
      p: input.probeCode,
      r: input.datumReset,
      rs: input.datumReason,
      rows: input.rows.map((r) => [
        r.depth,
        r.forward,
        r.reverse,
        r.probeCodeForward,
        r.probeCodeReverse,
        r.factorForward,
        r.factorReverse,
      ]),
    }),
  );
  return h.digest('hex');
}
