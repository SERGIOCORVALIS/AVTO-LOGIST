/**
 * Report / apply client identity merges and content-hash duplicates.
 * Usage: pnpm mail:archive-dedupe [--apply]
 */
import { config } from "dotenv";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(ROOT, ".env") });
const { Pool } = createRequire(resolve(ROOT, "apps/api/package.json"))("pg");
const APPLY = process.argv.includes("--apply");

async function main() {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      "postgresql://alo:alo@localhost:5432/autologistics",
  });

  const dupMessages = await pool.query(`
    SELECT content_hash, COUNT(*)::int AS n, array_agg(id::text) AS ids
    FROM mail_messages
    WHERE content_hash IS NOT NULL
    GROUP BY content_hash
    HAVING COUNT(*) > 1
    ORDER BY n DESC
    LIMIT 200
  `);

  const identityConflicts = await pool.query(`
    SELECT i.kind, i.value_norm, COUNT(DISTINCT i.client_id)::int AS clients,
           array_agg(DISTINCT i.client_id::text) AS client_ids
    FROM client_identities i
    GROUP BY i.kind, i.value_norm
    HAVING COUNT(DISTINCT i.client_id) > 1
    LIMIT 100
  `);

  const lines = [
    "# Mail archive dedupe report",
    "",
    `Date: ${new Date().toISOString()}`,
    APPLY ? "**APPLY mode**" : "*(dry-run — pass --apply to merge)*",
    "",
    `## Duplicate content_hash messages: ${dupMessages.rows.length} groups`,
    ...dupMessages.rows.slice(0, 30).map(
      (r) => `- hash=${String(r.content_hash).slice(0, 12)}… n=${r.n}`
    ),
    "",
    `## Identity conflicts (same email/phone/inn → many clients): ${identityConflicts.rows.length}`,
    ...identityConflicts.rows.map(
      (r) => `- ${r.kind}=${r.value_norm} clients=${r.clients}`
    ),
    "",
  ];

  let merged = 0;
  let msgsDeleted = 0;

  if (APPLY) {
    for (const row of identityConflicts.rows) {
      const ids = row.client_ids as string[];
      const keep = ids[0];
      const drop = ids.slice(1);
      for (const d of drop) {
        await pool.query(
          `UPDATE mail_messages SET client_id = $1 WHERE client_id = $2`,
          [keep, d]
        );
        await pool.query(
          `UPDATE client_calc_requests SET client_id = $1 WHERE client_id = $2`,
          [keep, d]
        );
        await pool.query(
          `UPDATE client_facts SET client_id = $1 WHERE client_id = $2`,
          [keep, d]
        );
        await pool.query(
          `UPDATE mail_threads SET client_id = $1 WHERE client_id = $2`,
          [keep, d]
        );
        await pool.query(
          `UPDATE mail_attachments SET client_id = $1 WHERE client_id = $2`,
          [keep, d]
        );
        await pool.query(
          `UPDATE deals SET client_id = $1 WHERE client_id = $2`,
          [keep, d]
        );
        await pool.query(
          `DELETE FROM client_identities WHERE client_id = $1`,
          [d]
        );
        await pool.query(`DELETE FROM clients WHERE id = $1`, [d]);
        merged += 1;
      }
    }

    for (const row of dupMessages.rows) {
      const ids = row.ids as string[];
      const keep = ids[0];
      const drop = ids.slice(1);
      for (const d of drop) {
        await pool.query(`DELETE FROM mail_messages WHERE id = $1`, [d]);
        msgsDeleted += 1;
      }
      void keep;
    }
  }

  lines.push(`Merged clients: ${merged}`, `Deleted dup messages: ${msgsDeleted}`, "");

  const outDir = resolve(ROOT, "logs/mail");
  mkdirSync(outDir, { recursive: true });
  const path = join(
    outDir,
    `dedupe-${new Date().toISOString().slice(0, 10)}.md`
  );
  writeFileSync(path, lines.join("\n"), "utf8");
  console.log(`[report] ${path}`);
  console.log({ groups: dupMessages.rows.length, conflicts: identityConflicts.rows.length, merged, msgsDeleted, apply: APPLY });
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
