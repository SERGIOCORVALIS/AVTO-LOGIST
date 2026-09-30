/**
 * Apply infra/migrations/*.sql in sorted order with schema_migrations tracking.
 * Safe to re-run (skips already applied files).
 *
 * Usage: pnpm --filter @alo/api db:migrate
 *
 * loadRootEnv must run before importing ./db (Pool reads DATABASE_URL at import time).
 */
import { loadRootEnv } from "@alo/shared";
loadRootEnv();

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

async function main(): Promise<void> {
  const { pool } = await import("./db");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const appliedRows = await pool.query<{ id: string }>(`SELECT id FROM schema_migrations`);
  const done = new Set(appliedRows.rows.map((row) => row.id));

  const dir = join(__dirname, "..", "..", "..", "infra", "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (!files.length) {
    console.log("[migrate] no SQL files in", dir);
    await pool.end();
    return;
  }

  let applied = 0;
  for (const file of files) {
    if (done.has(file)) {
      console.log("[migrate] skip", file);
      continue;
    }
    const sql = readFileSync(join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [file]);
      await client.query("COMMIT");
      console.log("[migrate] applied", file);
      applied += 1;
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[migrate] failed", file, err);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log(`[migrate] done — ${applied} new, ${files.length} total`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
