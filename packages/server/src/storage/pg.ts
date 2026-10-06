import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import pg from 'pg';
import type { ThresholdEntry } from '@incli/shared';
import type {
  BoreholeAggregate,
  BoreholeRow,
  CalibrationRow,
  MeasurementRow,
  ProbeRow,
  ReadingRow,
  Repository,
  SnapshotRow,
  Tx,
} from './types.js';

const { Pool: PgPool } = pg;

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(pool: Pool): Promise<void> {
  // dist 与 src 目录各放一份 schema.sql（Dockerfile 拷贝时处理；开发期从 src 读）
  const candidates = [join(here, 'schema.sql'), join(here, '..', '..', 'src', 'storage', 'schema.sql')];
  let sql = '';
  for (const path of candidates) {
    try {
      sql = await readFile(path, 'utf8');
      break;
    } catch {
      /* try next */
    }
  }
  if (!sql) throw new Error('找不到 schema.sql');
  await pool.query(sql);
}

interface PgTx extends Tx {
  kind: 'pg';
  client: PoolClient;
}

export class PgRepository implements Repository {
  constructor(private readonly pool: Pool) {}

  async withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const tx: PgTx = { kind: 'pg', client };
      const out = await fn(tx);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private c(tx: Tx): PoolClient {
    if (tx.kind !== 'pg') throw new Error('expected pg tx');
    return (tx as PgTx).client;
  }

  async findProbeByCode(tx: Tx, code: string): Promise<ProbeRow | null> {
    const r = await this.c(tx).query<ProbeRow>('SELECT * FROM probes WHERE code = $1', [code]);
    return r.rows[0] ?? null;
  }

  async listProbes(tx: Tx): Promise<ProbeRow[]> {
    const r = await this.c(tx).query<ProbeRow>('SELECT * FROM probes ORDER BY code');
    return r.rows;
  }

  async insertProbe(tx: Tx, row: ProbeRow): Promise<void> {
    await this.c(tx).query('INSERT INTO probes (id, code, note, created_at) VALUES ($1,$2,$3,$4)', [
      row.id,
      row.code,
      row.note,
      row.created_at,
    ]);
  }

  async insertCalibration(tx: Tx, row: CalibrationRow): Promise<void> {
    await this.c(tx).query(
      `INSERT INTO probe_calibrations
        (id, probe_id, effective_at, factor, note, revision, superseded, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        row.id,
        row.probe_id,
        row.effective_at,
        row.factor,
        row.note,
        row.revision,
        row.superseded,
        row.created_at,
        row.updated_at,
      ],
    );
  }

  async listCalibrationsByProbe(tx: Tx, probeId: string): Promise<CalibrationRow[]> {
    const r = await this.c(tx).query<CalibrationRow>(
      `SELECT *, EXTRACT(EPOCH FROM effective_at)*1000 AS effective_at_ms
       FROM probe_calibrations WHERE probe_id = $1 AND superseded = FALSE
       ORDER BY effective_at`,
      [probeId],
    );
    return r.rows;
  }

  async listAllCalibrations(tx: Tx): Promise<CalibrationRow[]> {
    const r = await this.c(tx).query<CalibrationRow>(
      `SELECT *, EXTRACT(EPOCH FROM effective_at)*1000 AS effective_at_ms
       FROM probe_calibrations WHERE superseded = FALSE`
    );
    return r.rows;
  }

  async updateCalibrationRevisioned(
    tx: Tx,
    id: string,
    expectedRevision: number,
    patch: { effectiveAtMs: number; factor: number; note: string | null },
    updatedAt: string,
  ): Promise<boolean> {
    const r = await this.c(tx).query(
      `UPDATE probe_calibrations
         SET revision = revision + 1, effective_at = $2, factor = $3, note = $4, updated_at = $5
       WHERE id = $1 AND revision = $6
       RETURNING revision`,
      [id, new Date(patch.effectiveAtMs).toISOString(), patch.factor, patch.note, updatedAt, expectedRevision],
    );
    return r.rowCount === 1;
  }

  async findBoreholeByCode(tx: Tx, code: string): Promise<BoreholeRow | null> {
    const r = await this.c(tx).query<BoreholeRow>('SELECT * FROM boreholes WHERE code = $1', [code]);
    return r.rows[0] ?? null;
  }

  async findBoreholeById(tx: Tx, id: string): Promise<BoreholeRow | null> {
    const r = await this.c(tx).query<BoreholeRow>('SELECT * FROM boreholes WHERE id = $1', [id]);
    return r.rows[0] ?? null;
  }

  async listBoreholes(tx: Tx): Promise<BoreholeRow[]> {
    const r = await this.c(tx).query<BoreholeRow>('SELECT * FROM boreholes ORDER BY code');
    return r.rows;
  }

  async insertBorehole(tx: Tx, row: BoreholeRow, thresholds: ThresholdEntry[]): Promise<void> {
    const client = this.c(tx);
    await client.query(
      `INSERT INTO boreholes (id, code, depth, spacing, positive_direction, checksum_tolerance, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [row.id, row.code, row.depth, row.spacing, row.positive_direction, row.checksum_tolerance, row.created_at],
    );
    for (let i = 0; i < thresholds.length; i++) {
      const t = thresholds[i]!;
      await client.query(
        `INSERT INTO borehole_thresholds (id, borehole_id, depth, blue, yellow, red)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
        [row.id, t.depth, t.blue, t.yellow, t.red],
      );
    }
  }

  async findMeasurementById(tx: Tx, id: string): Promise<MeasurementRow | null> {
    const r = await this.c(tx).query<MeasurementRow>(
      `SELECT *, EXTRACT(EPOCH FROM measured_at)*1000 AS measured_at_ms
       FROM measurements WHERE id = $1`,
      [id],
    );
    return r.rows[0] ?? null;
  }

  async insertMeasurement(tx: Tx, row: MeasurementRow, readings: ReadingRow[]): Promise<void> {
    const client = this.c(tx);
    await client.query(
      `INSERT INTO measurements
        (id, borehole_id, measured_at, probe_code, datum_reset, datum_reason, revision, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        row.id,
        row.borehole_id,
        row.measured_at,
        row.probe_code,
        row.datum_reset,
        row.datum_reason,
        row.revision,
        row.created_at,
        row.updated_at,
      ],
    );
    for (const rd of readings) {
      await client.query(
        `INSERT INTO measurement_readings
          (id, measurement_id, ord, depth, forward, reverse, probe_code_forward, probe_code_reverse)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [rd.id, rd.measurement_id, rd.ord, rd.depth, rd.forward, rd.reverse, rd.probe_code_forward, rd.probe_code_reverse],
      );
    }
  }

  async updateMeasurementRevisioned(
    tx: Tx,
    id: string,
    expectedRevision: number,
    patch: { measuredAtMs: number; probeCode: string; datumReset: boolean; datumReason: MeasurementRow['datum_reason'] },
    readings: ReadingRow[],
    updatedAt: string,
  ): Promise<boolean> {
    const client = this.c(tx);
    const r = await client.query(
      `UPDATE measurements
         SET revision = revision + 1, measured_at = $2, probe_code = $3,
             datum_reset = $4, datum_reason = $5, updated_at = $6
       WHERE id = $1 AND revision = $7
       RETURNING revision`,
      [
        id,
        new Date(patch.measuredAtMs).toISOString(),
        patch.probeCode,
        patch.datumReset,
        patch.datumReason,
        updatedAt,
        expectedRevision,
      ],
    );
    if (r.rowCount !== 1) return false;
    await client.query('DELETE FROM measurement_readings WHERE measurement_id = $1', [id]);
    for (const rd of readings) {
      await client.query(
        `INSERT INTO measurement_readings
          (id, measurement_id, ord, depth, forward, reverse, probe_code_forward, probe_code_reverse)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [rd.id, rd.measurement_id, rd.ord, rd.depth, rd.forward, rd.reverse, rd.probe_code_forward, rd.probe_code_reverse],
      );
    }
    return true;
  }

  private async thresholdsFor(client: PoolClient, boreholeId: string): Promise<ThresholdEntry[]> {
    const r = await client.query(
      'SELECT depth, blue, yellow, red FROM borehole_thresholds WHERE borehole_id = $1 ORDER BY depth',
      [boreholeId],
    );
    return r.rows;
  }

  async getBoreholeAggregate(tx: Tx, boreholeId: string): Promise<BoreholeAggregate> {
    const client = this.c(tx);
    const bh = await client.query<BoreholeRow>('SELECT * FROM boreholes WHERE id = $1', [boreholeId]);
    if (bh.rowCount === 0) throw new Error('borehole not found');
    const thresholds = await this.thresholdsFor(client, boreholeId);
    const measurements = (
      await client.query<MeasurementRow>(
        `SELECT *, EXTRACT(EPOCH FROM measured_at)*1000 AS measured_at_ms
         FROM measurements WHERE borehole_id = $1
         ORDER BY measured_at, id`,
        [boreholeId],
      )
    ).rows;
    let readings: ReadingRow[] = [];
    let snapshots: SnapshotRow[] = [];
    if (measurements.length > 0) {
      readings = (
        await client.query<ReadingRow>(
          `SELECT * FROM measurement_readings WHERE measurement_id = ANY($1::uuid[]) ORDER BY measurement_id, ord`,
          [measurements.map((m) => m.id)],
        )
      ).rows;
      snapshots = (
        await client.query<SnapshotRow>(
          `SELECT *, EXTRACT(EPOCH FROM computed_at)*1000 AS computed_at_ms
           FROM computed_snapshots WHERE measurement_id = ANY($1::uuid[])
           ORDER BY computed_at`,
          [measurements.map((m) => m.id)],
        )
      ).rows;
    }
    return { borehole: bh.rows[0]!, thresholds, measurements, readings, snapshots };
  }

  async getAllAggregates(tx: Tx): Promise<BoreholeAggregate[]> {
    const client = this.c(tx);
    const bhs = (await client.query<BoreholeRow>('SELECT * FROM boreholes ORDER BY code')).rows;
    return await Promise.all(bhs.map((b) => this.getBoreholeAggregate(tx, b.id)));
  }

  async insertSnapshotIfNewer(tx: Tx, row: SnapshotRow): Promise<boolean> {
    const r = await this.c(tx).query(
      `INSERT INTO computed_snapshots (id, measurement_id, content_hash, revision_at_compute, result_json, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (measurement_id, content_hash) DO NOTHING`,
      [row.id, row.measurement_id, row.content_hash, row.revision_at_compute, JSON.stringify(row.result_json), row.computed_at],
    );
    return r.rowCount === 1;
  }

  async listSnapshotsByMeasurement(tx: Tx, measurementId: string): Promise<SnapshotRow[]> {
    const r = await this.c(tx).query<SnapshotRow>(
      `SELECT *, EXTRACT(EPOCH FROM computed_at)*1000 AS computed_at_ms
       FROM computed_snapshots WHERE measurement_id = $1 ORDER BY computed_at`,
      [measurementId],
    );
    return r.rows;
  }

  async getLatestSnapshot(tx: Tx, measurementId: string): Promise<SnapshotRow | null> {
    const r = await this.c(tx).query<SnapshotRow>(
      `SELECT *, EXTRACT(EPOCH FROM computed_at)*1000 AS computed_at_ms
       FROM computed_snapshots WHERE measurement_id = $1 ORDER BY computed_at DESC LIMIT 1`,
      [measurementId],
    );
    return r.rows[0] ?? null;
  }
}

export function createPool(connectionString: string): Pool {
  return new PgPool({ connectionString, max: 10 });
}
