import type { FastifyInstance } from 'fastify';
import type { MeasurementInput } from '@incli/shared';
import { parseMeasurementText } from '@incli/shared';
import { MonitorService } from '../domain/monitorService.js';
import { QueryService } from '../domain/queryService.js';
import { NotFoundError, RevisionConflictError, ValidationError } from '../domain/errors.js';

export interface RouteDeps {
  monitor: MonitorService;
  query: QueryService;
}

interface CorrectParams {
  id: string;
}
interface CorrectBody extends MeasurementInput {
  baseRevision: number;
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { monitor, query } = deps;

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ValidationError) {
      reply.code(422).send({ error: 'validation_failed', errors: err.errors });
      return;
    }
    if (err instanceof RevisionConflictError) {
      reply.code(409).send({ error: 'revision_conflict', message: err.message, currentRevision: err.currentRevision });
      return;
    }
    if (err instanceof NotFoundError) {
      reply.code(404).send({ error: 'not_found', message: err.message });
      return;
    }
    app.log.error(err);
    reply.code(500).send({ error: 'internal', message: err.message });
  });

  app.get('/api/health', async () => ({ ok: true }));

  /* ------------------------------ 测孔 ------------------------------ */

  app.get('/api/boreholes', async () => ({ items: await query.overview() }));

  app.post('/api/boreholes', async (req, reply) => {
    const created = await monitor.createBorehole(req.body as never);
    reply.code(201).send(created);
  });

  app.get('/api/boreholes/:code', async (req) => {
    const { code } = req.params as { code: string };
    return await query.borehole(code);
  });

  app.get('/api/boreholes/:code/overlay', async (req) => {
    const { code } = req.params as { code: string };
    const q = req.query as { measurements?: string; connected?: string };
    const ids = !q.measurements || q.measurements === 'all' ? 'all' : q.measurements.split(',').filter(Boolean);
    return await query.profileOverlay(code, ids, q.connected !== '0');
  });

  app.get('/api/boreholes/:code/depth-history', async (req) => {
    const { code } = req.params as { code: string };
    const q = req.query as { depth?: string; connected?: string };
    const depth = Number(q.depth);
    if (!Number.isFinite(depth)) throw new ValidationError([{ field: 'depth', message: '需要 depth（m）' }]);
    return await query.depthHistory(code, depth, q.connected !== '0');
  });

  /* ------------------------------ 探头 ------------------------------ */

  app.get('/api/probes', async () => ({ items: await monitor.listProbesWithCalibrations() }));

  app.post('/api/probes', async (req, reply) => {
    const created = await monitor.registerProbe(req.body as never);
    reply.code(201).send(created);
  });

  app.post('/api/calibrations', async (req, reply) => {
    const created = await monitor.addCalibration(req.body as never);
    reply.code(201).send(created);
  });

  app.post('/api/calibrations/:id/correct', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { baseRevision: number; effectiveAt: string; factor: number; note?: string };
    await monitor.correctCalibration(id, Number(body.baseRevision), {
      effectiveAt: body.effectiveAt,
      factor: Number(body.factor),
      note: body.note,
    });
    return { ok: true };
  });

  /* ------------------------------ 测量 ------------------------------ */

  app.post('/api/boreholes/:code/measurements', async (req, reply) => {
    const { code } = req.params as { code: string };
    const body = req.body as MeasurementInput | { text: string; measuredAt: string; probeCode: string; datumReset?: boolean; datumReason?: MeasurementInput['datumReason'] };
    let input: MeasurementInput;
    if ('text' in body && typeof body.text === 'string') {
      const parsed = parseMeasurementText(body.text);
      if (parsed.errors.length) throw new ValidationError(parsed.errors);
      input = {
        measuredAt: body.measuredAt,
        probeCode: body.probeCode,
        datumReset: body.datumReset,
        datumReason: body.datumReason,
        readings: parsed.readings,
      };
    } else {
      input = body as MeasurementInput;
    }
    const created = await monitor.addMeasurement(code, input);
    reply.code(201).send(created);
  });

  app.get('/api/measurements/:id', async (req) => {
    const { id } = req.params as CorrectParams;
    return await query.measurementDetail(id);
  });

  app.post('/api/measurements/:id/correct', async (req) => {
    const { id } = req.params as CorrectParams;
    const body = req.body as CorrectBody;
    const { baseRevision, ...input } = body;
    await monitor.correctMeasurement(id, Number(baseRevision), input);
    return { ok: true };
  });

  app.get('/api/measurements/:id/history', async (req) => {
    const { id } = req.params as CorrectParams;
    const q = req.query as { asOf?: string };
    const asOf = q.asOf ? Date.parse(q.asOf) : undefined;
    return await monitor.historicalGrade(id, asOf);
  });
}
