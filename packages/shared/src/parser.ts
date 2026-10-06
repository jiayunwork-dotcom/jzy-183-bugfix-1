import type { ReadingInput } from './types.js';
import type { FieldError } from './types.js';

export interface ParsedUpload {
  readings: ReadingInput[];
  errors: FieldError[];
}

/** Split one pasted/exported line (Excel tab, comma, semicolon or spaces). */
function splitCells(line: string): string[] {
  return line
    .trim()
    .split(/\s*[,\t;]\s*|\s+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

function toNumber(token: string): number {
  // Tolerate e.g. "2.50" but reject "12abc".
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(token)) return Number(token);
  return Number.NaN;
}

/**
 * Parse inclinometer export / spreadsheet paste.
 *
 * Each non-empty line describes one depth:
 *   depth  forward  reverse  [probeForward]  [probeReverse]
 * Separators may be tabs, commas, semicolons or runs of spaces.
 * Lines that look like a header (first cell non numeric, contains letters)
 * are skipped; malformed data lines are reported as field errors.
 */
export function parseMeasurementText(text: string): ParsedUpload {
  const readings: ReadingInput[] = [];
  const errors: FieldError[] = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    const line = rawLine.trim();
    if (line.length === 0) return;
    const cells = splitCells(line);
    if (cells.length < 3) {
      errors.push({ field: `readings[${readings.length}]`, message: `第 ${lineNo} 行字段不足，需要：深度 正测 反测 [探头]` });
      return;
    }
    const depth = toNumber(cells[0]!);
    if (!Number.isFinite(depth)) {
      // Header row heuristic: first cell is textual.
      if (/[A-Za-z一-龥]/.test(cells[0]!)) return;
      errors.push({ field: `readings[${readings.length}].depth`, message: `第 ${lineNo} 行深度不是数字：${cells[0]}` });
      return;
    }
    const forward = toNumber(cells[1]!);
    const reverse = toNumber(cells[2]!);
    if (!Number.isFinite(forward)) {
      errors.push({ field: `readings[${readings.length}].forward`, message: `第 ${lineNo} 行正测读数不是有限数：${cells[1]}` });
      return;
    }
    if (!Number.isFinite(reverse)) {
      errors.push({ field: `readings[${readings.length}].reverse`, message: `第 ${lineNo} 行反测读数不是有限数：${cells[2]}` });
      return;
    }
    const row: ReadingInput = { depth, forward, reverse };
    if (cells.length >= 4 && cells[3] !== undefined && cells[3] !== '-') {
      const f = toNumber(cells[3]);
      // Probe code is free text; only a purely numeric token would be ambiguous,
      // which we still accept as a code (e.g. probe "03").
      row.probeCodeForward = Number.isFinite(f) ? cells[3] : cells[3];
    }
    if (cells.length >= 5 && cells[4] !== undefined && cells[4] !== '-') {
      row.probeCodeReverse = cells[4];
    }
    readings.push(row);
  });

  return { readings, errors };
}
