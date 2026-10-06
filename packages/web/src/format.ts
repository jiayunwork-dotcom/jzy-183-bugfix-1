const LEVEL_LABEL: Record<string, string> = {
  none: '正常',
  blue: '蓝色预警',
  yellow: '黄色预警',
  red: '红色预警',
};

const LEVEL_COLOR: Record<string, string> = {
  none: '#9ca3af',
  blue: '#3b82f6',
  yellow: '#f59e0b',
  red: '#ef4444',
};

export function levelLabel(l: string): string {
  return LEVEL_LABEL[l] ?? l;
}
export function levelColor(l: string): string {
  return LEVEL_COLOR[l] ?? '#999';
}

export function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(0, 16);
}

export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return '—';
  return v.toFixed(digits);
}
