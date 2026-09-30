import { loadRootEnv } from "@alo/shared";
loadRootEnv();
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../scripts/load-secrets.cjs");
} catch {
  /* optional */
}
import { pool } from "./db";
import { isProduction, seedStaffUsers } from "./auth";
import { assertProductionReady, cabinetAuthRequired } from "./bootGuard";
import { createApp } from "./app";
import { createLogger, ensureLogTree, enforceLicense } from "@alo/shared";

const log = createLogger("api");
ensureLogTree();

const port = Number(process.env.API_PORT || 3000);
const host = process.env.API_HOST || "0.0.0.0";

async function main() {
  await enforceLicense({ service: "api", allowPrompt: Boolean(process.stdin.isTTY) });
  assertProductionReady(log);
  try {
    await seedStaffUsers();
  } catch (err) {
    log.error("staff_seed_failed", { err: String(err) });
    if (isProduction()) throw err;
  }
  const app = await createApp();
  await app.listen({ port, host });
  log.info("API listening", { host, port, auth: cabinetAuthRequired() });
}

main().catch((err) => {
  log.error("listen_failed", { err: String(err) });
  process.exit(1);
});

process.on("SIGINT", async () => {
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(0);
});
