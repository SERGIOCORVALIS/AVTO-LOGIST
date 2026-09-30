import { config } from "dotenv";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(ROOT, ".env") });
const { Pool } = createRequire(resolve(ROOT, "apps/api/package.json"))("pg");

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgresql://alo:alo@localhost:5432/autologistics",
});

async function main() {
  const facts = await pool.query(`
    SELECT fact_type, COUNT(*)::int AS n
    FROM client_facts
    WHERE fact_type IN ('invoice','contract','folder_client')
    GROUP BY fact_type
    ORDER BY n DESC
  `);
  const clients = await pool.query(`SELECT COUNT(*)::int AS n FROM clients`);
  const infoMsgs = await pool.query(`
    SELECT COUNT(*)::int AS n FROM mail_messages WHERE mailbox_id = 'info'
  `);
  console.log("facts", facts.rows);
  console.log("clients_total", clients.rows[0].n);
  console.log("info_messages", infoMsgs.rows[0].n);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
