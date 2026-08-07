import "dotenv/config";
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../scripts/load-secrets.cjs");
} catch {
  /* optional */
}
import Fastify from "fastify";
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
import {
  DEFAULT_POLICY,
  type PolicyConfig,
  assertLicenseOrExit,
  createLogger,
  ensureLogTree,
} from "@alo/shared";

const log = createLogger("api");
ensureLogTree();

const license = assertLicenseOrExit("api");
log.info("license", {
  mode: license.mode,
  daysLeft: license.daysLeft,
  periodEndsAt: license.periodEndsAt,
});

const app = Fastify({ logger: true });

app.addHook("onResponse", async (req, reply) => {
  log.info("http", {
    method: req.method,
    url: req.url,
    status: reply.statusCode,
  });
});

app.get("/health", async () => ({
  ok: true,
  service: "alo-api",
  ts: new Date().toISOString(),
}));

registerDealRoutes(app);
registerPolicyRoutes(app);
registerEscalationRoutes(app);
registerOrchestratorProxy(app);
registerCallRoutes(app);
registerPlaybookRoutes(app);
registerAttachmentRoutes(app);
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
  return {
    by_status: deals.rows,
    pending_escalations: pendingEsc.rows[0]?.n ?? 0,
    policy_defaults: DEFAULT_POLICY satisfies PolicyConfig,
  };
});

const port = Number(process.env.API_PORT || 3000);
const host = process.env.API_HOST || "0.0.0.0";

app
  .listen({ port, host })
  .then(() => {
    log.info("API listening", { host, port });
  })
  .catch((err) => {
    log.error("listen_failed", { err: String(err) });
    process.exit(1);
  });
