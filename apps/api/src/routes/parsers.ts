import { randomUUID } from "crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pool } from "../db";
import { requireDirector } from "../auth";
import { logStaffEvent } from "../staffEvents";
import { digestQueue, enqueueAssociationsUpdate } from "../queues";

const PARSER_ID = "associations_cis";
const REPO_ROOT = resolve(__dirname, "../../../..");
const CATALOG_PATH = resolve(REPO_ROOT, "data/suppliers_associations_cis.json");

function readCatalogCounts(): Record<string, number> | null {
  if (!existsSync(CATALOG_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as {
      counts?: Record<string, number>;
    };
    return raw.counts ?? null;
  } catch {
    return null;
  }
}

function publicRun(row: Record<string, unknown>) {
  return {
    id: row.id,
    parser_id: row.parser_id,
    status: row.status,
    triggered_by: row.triggered_by,
    triggered_by_staff_id: row.triggered_by_staff_id ?? null,
    started_at: row.started_at,
    finished_at: row.finished_at ?? null,
    stats: row.stats ?? {},
    error: row.error ?? null,
    log_path: row.log_path ?? null,
  };
}

export function registerParserRoutes(app: FastifyInstance) {
  app.get("/parsers", async (req, reply) => {
    if (!requireDirector(req, reply)) return;

    const settings = await pool.query(
      `SELECT id, enabled, cron, enrich_emails, auto_seed, updated_at
       FROM parser_settings WHERE id = $1`,
      [PARSER_ID]
    );
    const runs = await pool.query(
      `SELECT id, parser_id, status, triggered_by, triggered_by_staff_id,
              started_at, finished_at, stats, error, log_path
       FROM parser_runs WHERE parser_id = $1
       ORDER BY started_at DESC LIMIT 30`,
      [PARSER_ID]
    );
    const active = await pool.query(
      `SELECT id, status, started_at FROM parser_runs
       WHERE parser_id = $1 AND status IN ('queued', 'running')
       ORDER BY started_at DESC LIMIT 1`,
      [PARSER_ID]
    );

    return {
      parser_id: PARSER_ID,
      settings: settings.rows[0] ?? {
        id: PARSER_ID,
        enabled: true,
        cron: "0 6 * * 1",
        enrich_emails: true,
        auto_seed: true,
      },
      catalog_counts: readCatalogCounts(),
      active_run: active.rows[0] ?? null,
      runs: runs.rows.map(publicRun),
    };
  });

  app.put("/parsers/settings", async (req, reply) => {
    if (!requireDirector(req, reply)) return;
    const body = z
      .object({
        enabled: z.boolean().optional(),
        enrich_emails: z.boolean().optional(),
        auto_seed: z.boolean().optional(),
      })
      .parse(req.body);

    const r = await pool.query(
      `UPDATE parser_settings SET
         enabled = COALESCE($2, enabled),
         enrich_emails = COALESCE($3, enrich_emails),
         auto_seed = COALESCE($4, auto_seed),
         updated_at = NOW()
       WHERE id = $1
       RETURNING id, enabled, cron, enrich_emails, auto_seed, updated_at`,
      [PARSER_ID, body.enabled ?? null, body.enrich_emails ?? null, body.auto_seed ?? null]
    );

    await logStaffEvent({
      req,
      actor: req.staff,
      action: "parser_settings",
      summary: "Обновлены настройки парсера ассоциаций",
      meta: body,
    });

    return { settings: r.rows[0] };
  });

  app.post("/parsers/run", async (req, reply) => {
    if (!requireDirector(req, reply)) return;

    const active = await pool.query(
      `SELECT id FROM parser_runs
       WHERE parser_id = $1 AND status IN ('queued', 'running')
       LIMIT 1`,
      [PARSER_ID]
    );
    if (active.rows[0]) {
      return reply.code(409).send({
        error: "already_running",
        run_id: active.rows[0].id,
      });
    }

    const runId = randomUUID();
    await pool.query(
      `INSERT INTO parser_runs (id, parser_id, status, triggered_by, triggered_by_staff_id)
       VALUES ($1, $2, 'queued', 'manual', $3)`,
      [runId, PARSER_ID, req.staff?.id ?? null]
    );

    await enqueueAssociationsUpdate(runId, req.staff?.id ?? null);

    await logStaffEvent({
      req,
      actor: req.staff,
      action: "parser_run",
      target_id: runId,
      summary: "Запущен парсер перевозчиков КазАТО/БАМАП",
      meta: { run_id: runId },
    });

    return reply.code(202).send({ run_id: runId, status: "queued" });
  });

  app.get("/parsers/runs/:id", async (req, reply) => {
    if (!requireDirector(req, reply)) return;
    const { id } = req.params as { id: string };
    const r = await pool.query(
      `SELECT id, parser_id, status, triggered_by, triggered_by_staff_id,
              started_at, finished_at, stats, error, log_path
       FROM parser_runs WHERE id = $1`,
      [id]
    );
    if (!r.rows[0]) return reply.code(404).send({ error: "not_found" });
    return publicRun(r.rows[0] as Record<string, unknown>);
  });
}
