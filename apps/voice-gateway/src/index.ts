import "dotenv/config";
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../scripts/load-secrets.cjs");
} catch {
  /* optional */
}

import Fastify from "fastify";
import { Pool } from "pg";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import {
  QUEUES,
  assertLicenseOrExit,
  createLogger,
  ensureLogTree,
} from "@alo/shared";
import { SessionManager } from "./sessions";
import { startSipTrunk, type SipTrunk } from "./sip/trunk";
import { registerSipHttpRoutes } from "./sip/routes";

const log = createLogger("voice-gateway");
ensureLogTree();

const license = assertLicenseOrExit("voice-gateway");
log.info("license", {
  mode: license.mode,
  daysLeft: license.daysLeft,
  periodEndsAt: license.periodEndsAt,
});

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgresql://alo:alo@localhost:5432/autologistics",
});

const apiBase = process.env.API_URL || "http://localhost:3000";
const sessions = new SessionManager(pool);

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const channelQueue = new Queue(QUEUES.channel, { connection: redis });

async function main() {
  let trunk: SipTrunk | null = null;

  const app = Fastify({ logger: false });

  app.get("/health", async () => ({
    ok: true,
    service: "voice-gateway",
    sip: trunk
      ? {
          active: trunk.stack.active,
          provider: trunk.cfg.provider,
          providerLabel: trunk.cfg.providerLabel,
          domain: trunk.cfg.domain,
          outboundProxy: trunk.cfg.outboundProxy || null,
          port: trunk.cfg.port,
          publicHost: trunk.cfg.publicHost,
          uriMode: trunk.cfg.uriMode,
          stats: trunk.stack.getStats(),
        }
      : { active: false, providers: ["zadarma", "beeline"] },
    ts: new Date().toISOString(),
  }));

  registerSipHttpRoutes(app, sessions, () => trunk?.cfg ?? null);

  trunk = await startSipTrunk({ sessions, apiBase, channelQueue });

  const port = Number(process.env.VOICE_GATEWAY_PORT || 3010);
  const host = process.env.VOICE_GATEWAY_HOST || "0.0.0.0";

  await app.listen({ port, host });
  log.info("voice-gateway listening", {
    host,
    port,
    sip: Boolean(trunk),
  });

  const shutdown = async () => {
    log.info("shutting down");
    await trunk?.stop();
    await app.close();
    await pool.end();
    await redis.quit();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  log.error("fatal", { err: String(err) });
  process.exit(1);
});
