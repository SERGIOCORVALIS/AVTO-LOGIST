/**
 * CI smoke: Postgres + Redis reachable.
 * Run: pnpm --filter @alo/api exec tsx src/ciDepsSmoke.ts
 *
 * loadRootEnv runs before importing db (Pool reads DATABASE_URL at import).
 * Existing process.env (CI) wins over any local .env.
 */
import { loadRootEnv } from "@alo/shared";

async function main(): Promise<void> {
  loadRootEnv();
  process.env.DATABASE_URL =
    process.env.DATABASE_URL || "postgresql://alo:alo@127.0.0.1:5432/autologistics";
  process.env.REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

  const { pool } = await import("./db");
  await pool.query("SELECT 1");

  const IORedis = (await import("ioredis")).default;
  const r = new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    lazyConnect: true,
  });
  await r.connect();
  const pong = await r.ping();
  r.disconnect();
  await pool.end();

  if (pong !== "PONG") throw new Error("redis ping failed");
  console.log("api-deps-ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
