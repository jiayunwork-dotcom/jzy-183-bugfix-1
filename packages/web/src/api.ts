import type {
  BoreholeInput,
  CalibrationInput,
  MeasurementInput,
} from '@incli/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public fields: { field: string; message: string }[] = [],
    message = '',
  ) {
    super(message || code);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error ?? 'http_error',
      data?.errors ?? [],
      data?.message ?? `HTTP ${res.status}`,
    );
  }
  return data as T;
}

export interface OverviewItem {
  boreholeId: string;
  code: string;
  lastMeasuredAt: string | null;
  level: 'none' | 'blue' | 'yellow' | 'red';
  maxAbsRate: number | null;
  measurementId: string | null;
  datumGroups: number;
}

export interface BoreholeDetail {
  borehole: BoreholeInput & { id: string };
  measurements: {
    id: string;
    measuredAt: string;
    probeCode: string;
    datumReset: boolean;
    datumReason: string;
    revision: number;
    result: ResultJson | null;
  }[];
}

export interface ResultPointJson {
  depth: number;
  relativeDisplacement: number;
  connectedDisplacement: number;
  cumulativeRaw: number;
  checksum: number;
  suspicious: boolean;
  rate: number | null;
  level: string;
  crossDatum: boolean;
  usedProbeForward: string;
  usedProbeReverse: string;
  factorForward: number;
  factorReverse: number;
}

export interface ResultJson {
  measurementId: string;
  boreholeId: string;
  revision: number;
  measuredAtMs: number;
  measuredAt: string;
  datumIndex: number;
  ordinalInDatum: number;
  relativeBaseMeasurementId: string | null;
  datumAnchor: number;
  maxAbsRate: number | null;
  level: string;
  crossDatumRate: boolean;
  points: ResultPointJson[];
}

export interface OverlayResp {
  code: string;
  connected: boolean;
  series: {
    measurementId: string;
    measuredAt: string;
    revision: number;
    datumIndex: number;
    datumReset: boolean;
    depths: number[];
    values: number[];
    levels: string[];
    crossDatum: boolean[];
  }[];
  boundaries: {
    measurementId: string;
    measuredAt: string;
    datumIndex: number;
    anchor: number;
    reason: string;
  }[];
}

export interface DepthHistoryResp {
  code: string;
  depth: number;
  connected: boolean;
  points: {
    measurementId: string;
    measuredAt: string;
    displacement: number;
    rate: number | null;
    level: string;
    crossDatum: boolean;
    datumIndex: number;
  }[];
}

export interface MeasurementDetailResp {
  measurement: {
    id: string;
    measuredAt: string;
    probeCode: string;
    datumReset: boolean;
    datumReason: string;
    revision: number;
  };
  boreholeCode: string;
  readings: {
    id: string;
    depth: number;
    forward: number;
    reverse: number;
    probe_code_forward: string;
    probe_code_reverse: string;
  }[];
  result: ResultJson | null;
  snapshotHistory: {
    computedAt: string;
    revision: number;
    contentHash: string;
    level: string;
    maxAbsRate: number | null;
  }[];
}

export interface ProbeItem {
  probe: { id: string; code: string; note: string | null; created_at: string };
  calibrations: {
    id: string;
    effective_at: string;
    factor: number;
    note: string | null;
    revision: number;
  }[];
}

export interface HistoryResp {
  measurementId: string;
  changed: boolean;
  current: { level: string; maxAbsRate: number | null; revision: number; computedAt: string; result: ResultJson };
  asOf: { level: string; maxAbsRate: number | null; revision: number; computedAt: string; result: ResultJson };
}

export const api = {
  overview: () => request<{ items: OverviewItem[] }>('/api/boreholes'),
  createBorehole: (body: BoreholeInput) => request('/api/boreholes', { method: 'POST', body: JSON.stringify(body) }),
  borehole: (code: string) => request<BoreholeDetail>(`/api/boreholes/${encodeURIComponent(code)}`),
  overlay: (code: string, ids: string[] | 'all', connected: boolean) => {
    const ms = ids === 'all' ? 'all' : ids.join(',');
    return request<OverlayResp>(
      `/api/boreholes/${encodeURIComponent(code)}/overlay?measurements=${ms}&connected=${connected ? 1 : 0}`,
    );
  },
  depthHistory: (code: string, depth: number, connected: boolean) =>
    request<DepthHistoryResp>(
      `/api/boreholes/${encodeURIComponent(code)}/depth-history?depth=${depth}&connected=${connected ? 1 : 0}`,
    ),
  addMeasurement: (code: string, body: MeasurementInput | { text: string; measuredAt: string; probeCode: string; datumReset?: boolean; datumReason?: string }) =>
    request(`/api/boreholes/${encodeURIComponent(code)}/measurements`, { method: 'POST', body: JSON.stringify(body) }),
  measurement: (id: string) => request<MeasurementDetailResp>(`/api/measurements/${id}`),
  correctMeasurement: (id: string, body: MeasurementInput & { baseRevision: number }) =>
    request(`/api/measurements/${id}/correct`, { method: 'POST', body: JSON.stringify(body) }),
  history: (id: string, asOf?: string) =>
    request<HistoryResp>(`/api/measurements/${id}/history${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`),
  probes: () => request<{ items: ProbeItem[] }>('/api/probes'),
  createProbe: (body: { code: string; note?: string }) =>
    request('/api/probes', { method: 'POST', body: JSON.stringify(body) }),
  addCalibration: (body: CalibrationInput) =>
    request('/api/calibrations', { method: 'POST', body: JSON.stringify(body) }),
  correctCalibration: (id: string, body: { baseRevision: number; effectiveAt: string; factor: number; note?: string }) =>
    request(`/api/calibrations/${id}/correct`, { method: 'POST', body: JSON.stringify(body) }),
};
