import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import IORedis from "ioredis";
import { pool } from "./db";
import { registerDealRoutes } from "./routes/deals";
import { registerPolicyRoutes } from "./routes/policy";
import { registerEscalationRoutes } from "./routes/escalations";
import { registerOrchestratorProxy } from "./routes/orchestrator";
import { registerCallRoutes } from "./routes/calls";
import { registerPlaybookRoutes } from "./routes/playbooks";
import { registerAttachmentRoutes } from "./routes/attachments";
import { registerInternalRoutes } from "./routes/internal";
import { registerCalendarRoutes } from "./routes/calendar";
import { registerAuthRoutes } from "./routes/auth";
import { registerDocumentRoutes } from "./routes/documents";
import { registerCompanyRoutes } from "./routes/company";
import { registerStaffRoutes } from "./routes/staff";
import { registerPartnerRoutes } from "./routes/partners";
import { registerParserRoutes } from "./routes/parsers";
import { registerClientRoutes } from "./routes/clients";
import {
  publicPath,
  readInternalToken,
  type RequestStaff,
} from "./auth";
import { cabinetAuthRequired, resolveJwtSecret } from "./bootGuard";
import { registerSecurity } from "./security";
import { DEFAULT_POLICY, type PolicyConfig, createLogger } from "@alo/shared";

const log = createLogger("api");

export async function createApp(opts?: {
  logger?: boolean;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts?.logger ?? true });

  const corsOrigin = process.env.CABINET_CORS_ORIGIN;
  await app.register(cors, {
    origin: corsOrigin
      ? corsOrigin.split(",").map((s) => s.trim())
      : true,
    credentials: true,
  });

  const jwtSecret = resolveJwtSecret();
  await app.register(jwt, { secret: jwtSecret });

  registerSecurity(app);

  const requireCabinetAuth = cabinetAuthRequired();

  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "OPTIONS") return;
    const url = req.url.split("?")[0];
    if (url.startsWith("/internal")) return;
    if (publicPath(url)) return;

    const internal = process.env.INTERNAL_API_TOKEN || "";
    const got = readInternalToken(req);
    if (internal && got === internal) {
      req.staff = { role: "service" };
      return;
    }

    const auth = req.headers.authorization;
    if (typeof auth === "string" && auth.startsWith("Bearer ") && got !== internal) {
      try {
        const payload = await req.jwtVerify<{
          sub: string;
          email: string;
          role: "director" | "manager";
          name: string;
        }>();
        req.staff = {
          id: payload.sub,
          email: payload.email,
          name: payload.name,
          role: payload.role,
        } satisfies RequestStaff;
        return;
      } catch {
        return reply.code(401).send({ error: "unauthorized" });
      }
    }

    if (requireCabinetAuth) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.addHook("onResponse", async (req, reply) => {
    if (opts?.logger === false) return;
    log.info("http", {
      method: req.method,
      url: req.url,
      status: reply.statusCode,
    });
  });

  app.get("/health", async (_req, reply) => {
    const checks: Record<string, "ok" | "fail"> = {};
    try {
      await pool.query("SELECT 1");
      checks.postgres = "ok";
    } catch {
      checks.postgres = "fail";
    }

    let redis: IORedis | null = null;
    try {
      redis = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        lazyConnect: true,
      });
      await redis.connect();
      const pong = await redis.ping();
      checks.redis = pong === "PONG" ? "ok" : "fail";
    } catch {
      checks.redis = "fail";
    } finally {
      if (redis) {
        try {
          redis.disconnect();
        } catch {
          /* ignore */
        }
      }
    }

    const ok = checks.postgres === "ok" && checks.redis === "ok";
    return reply.code(ok ? 200 : 503).send({
      ok,
      service: "alo-api",
      checks,
      ts: new Date().toISOString(),
    });
  });

  registerAuthRoutes(app);
  registerDealRoutes(app);
  registerPolicyRoutes(app);
  registerEscalationRoutes(app);
  registerOrchestratorProxy(app);
  registerCallRoutes(app);
  registerPlaybookRoutes(app);
  registerAttachmentRoutes(app);
  registerDocumentRoutes(app);
  registerCompanyRoutes(app);
  registerStaffRoutes(app);
  registerPartnerRoutes(app);
  registerParserRoutes(app);
  registerClientRoutes(app);
  registerInternalRoutes(app);
  registerCalendarRoutes(app);

  app.get("/stats/summary", async () => {
    const deals = await pool.query(`
      SELECT status, COUNT(*)::int AS n,
             COALESCE(AVG(margin_pct),0)::float AS avg_margin,
             COALESCE(SUM(amount_rub),0)::float AS revenue
      FROM deals GROUP BY status
    `);
    const pendingEsc = await pool.query(
      `SELECT COUNT(*)::int AS n FROM escalations WHERE status = 'pending'`
    );
    const flags = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE paused)::int AS paused,
        COUNT(*) FILTER (WHERE takeover)::int AS takeover,
        COUNT(*) FILTER (WHERE status = 'awaiting_manager')::int AS awaiting_manager,
        COUNT(*) FILTER (
          WHERE status NOT IN ('closed_won','closed_lost','cancelled')
        )::int AS open_deals
      FROM deals
    `);
    return {
      by_status: deals.rows,
      pending_escalations: pendingEsc.rows[0]?.n ?? 0,
      policy_defaults: DEFAULT_POLICY satisfies PolicyConfig,
      robot: flags.rows[0] ?? {
        paused: 0,
        takeover: 0,
        awaiting_manager: 0,
        open_deals: 0,
      },
    };
  });

  return app;
}
