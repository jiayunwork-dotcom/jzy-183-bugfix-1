import { createPool, migrate } from '../storage/pg.js';

const connectionString = process.env.DATABASE_URL ?? 'postgresql://incli:incli@localhost:5432/incli';

const pool = createPool(connectionString);
migrate(pool)
  .then(() => {
    console.log('migration applied');
    return pool.end();
  })
  .catch(async (err: unknown) => {
    console.error('migration failed', err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
