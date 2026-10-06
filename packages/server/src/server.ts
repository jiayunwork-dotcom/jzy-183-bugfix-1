import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { createPool, migrate, PgRepository } from './storage/index.js';
import { MonitorService } from './domain/monitorService.js';
import { QueryService } from './domain/queryService.js';
import { registerRoutes } from './http/routes.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://incli:incli@postgres:5432/incli';

async function waitForDb(pool: ReturnType<typeof createPool>, retries = 30, delayMs = 1000): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function main(): Promise<void> {
  const pool = createPool(DATABASE_URL);
  await waitForDb(pool);
  await migrate(pool);

  const repo = new PgRepository(pool);
  const monitor = new MonitorService(repo);
  const query = new QueryService(repo);

  const app = Fastify({ logger: true, bodyLimit: 10 * 1024 * 1024 });
  await registerRoutes(app, { monitor, query });

  // 前端打包产物由应用服务托管（packages/web/dist -> /app/public）
  const publicDirs = [join(here, '..', 'public'), join(here, '..', '..', 'web', 'dist'), join(here, '..', 'public')];
  const publicDir = publicDirs.find((p) => existsSync(join(p, 'index.html')));
  if (publicDir) {
    await app.register(fastifyStatic, { root: publicDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api/')) {
        reply.code(404).send({ error: 'not_found', message: 'unknown api route' });
        return;
      }
      reply.sendFile('index.html');
    });
    app.log.info({ publicDir }, 'serving frontend');
  } else {
    app.log.warn('frontend build not found; API only');
  }

  await app.listen({ port: PORT, host: HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
