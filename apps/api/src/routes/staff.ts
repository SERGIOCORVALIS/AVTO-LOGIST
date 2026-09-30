import { randomBytes } from "crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../db";
import { hashPassword, requireDirector } from "../auth";
import { logStaffEvent } from "../staffEvents";

const CYR: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

export function generatePassword(length = 12): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@$%";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function slugFromName(name: string): string {
  const lower = name.trim().toLowerCase();
  let s = "";
  for (const ch of lower) {
    if (CYR[ch] !== undefined) s += CYR[ch];
    else if (/[a-z0-9]/.test(ch)) s += ch;
    else if (/\s|-|_|\./.test(ch)) s += ".";
  }
  s = s.replace(/\.+/g, ".").replace(/^\.|\.$/g, "");
  return s || "manager";
}

async function uniqueEmail(base: string): Promise<string> {
  const domain = "transinvest.local";
  const local = base.includes("@") ? base.split("@")[0] : base;
  const wanted = `${local}@${domain}`;
  const exists = await pool.query(
    `SELECT 1 FROM staff_users WHERE lower(email) = lower($1)`,
    [wanted]
  );
  if (!exists.rows[0]) return wanted.toLowerCase();
  for (let i = 2; i < 50; i++) {
    const candidate = `${local}${i}@${domain}`.toLowerCase();
    const r = await pool.query(
      `SELECT 1 FROM staff_users WHERE lower(email) = lower($1)`,
      [candidate]
    );
    if (!r.rows[0]) return candidate;
  }
  return `${local}.${randomBytes(2).toString("hex")}@${domain}`;
}

function publicStaff(row: Record<string, unknown>) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    active: row.active,
    last_login_at: row.last_login_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function registerStaffRoutes(app: FastifyInstance) {
  app.get("/staff/managers", async (req, reply) => {
    if (!requireDirector(req, reply)) return;
    const r = await pool.query(
      `SELECT id, email, name, role, active, last_login_at, created_at, updated_at
       FROM staff_users WHERE role = 'manager'
       ORDER BY active DESC, name ASC`
    );
    return { items: r.rows.map(publicStaff) };
  });

  app.post("/staff/managers", async (req, reply) => {
    if (!requireDirector(req, reply)) return;
    const body = z
      .object({
        name: z.string().min(2).max(120),
        email: z
          .union([z.string().email(), z.literal("")])
          .optional(),
      })
      .parse(req.body);

    const email = body.email
      ? body.email.toLowerCase().trim()
      : await uniqueEmail(slugFromName(body.name));
    const password = generatePassword();
    const hash = await hashPassword(password);

    try {
      const r = await pool.query(
        `INSERT INTO staff_users (email, password_hash, role, name, active)
         VALUES ($1, $2, 'manager', $3, TRUE)
         RETURNING id, email, name, role, active, last_login_at, created_at, updated_at`,
        [email, hash, body.name.trim()]
      );
      const user = publicStaff(r.rows[0]);
      await logStaffEvent({
        req,
        actor: req.staff,
        action: "manager_created",
        summary: `Директор создал менеджера ${user.name} (${user.email})`,
        target_id: String(user.id),
        target_email: String(user.email),
        meta: { name: user.name },
      });
      return reply.code(201).send({ user, login: user.email, password });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("staff_users_email_key") || msg.includes("unique")) {
        return reply.code(409).send({
          error: "email_taken",
          message: "Такой логин (email) уже занят",
        });
      }
      throw err;
    }
  });

  app.post<{ Params: { id: string } }>(
    "/staff/managers/:id/password",
    async (req, reply) => {
      if (!requireDirector(req, reply)) return;
      const password = generatePassword();
      const hash = await hashPassword(password);
      const r = await pool.query(
        `UPDATE staff_users SET password_hash = $1, updated_at = NOW()
         WHERE id = $2 AND role = 'manager'
         RETURNING id, email, name, role, active, last_login_at, created_at, updated_at`,
        [hash, req.params.id]
      );
      if (!r.rows[0]) return reply.code(404).send({ error: "not_found" });
      const user = publicStaff(r.rows[0]);
      await logStaffEvent({
        req,
        actor: req.staff,
        action: "manager_password_reset",
        summary: `Директор выдал новый пароль менеджеру ${user.name} (${user.email})`,
        target_id: String(user.id),
        target_email: String(user.email),
      });
      return { user, login: user.email, password };
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/staff/managers/:id",
    async (req, reply) => {
      if (!requireDirector(req, reply)) return;
      if (req.staff?.id && req.staff.id === req.params.id) {
        return reply.code(400).send({
          error: "cannot_delete_self",
          message: "Нельзя удалить свою учётку",
        });
      }
      const r = await pool.query(
        `DELETE FROM staff_users WHERE id = $1 AND role = 'manager'
         RETURNING id, email, name`,
        [req.params.id]
      );
      if (!r.rows[0]) return reply.code(404).send({ error: "not_found" });
      await logStaffEvent({
        req,
        actor: req.staff,
        action: "manager_deleted",
        summary: `Директор удалил менеджера ${r.rows[0].name} (${r.rows[0].email})`,
        target_id: r.rows[0].id,
        target_email: r.rows[0].email,
      });
      return { ok: true, deleted: publicStaff({ ...r.rows[0], role: "manager", active: false }) };
    }
  );

  app.get("/staff/events", async (req, reply) => {
    if (!requireDirector(req, reply)) return;
    const q = req.query as {
      limit?: string;
      actor_id?: string;
      action?: string;
    };
    const limit = Math.min(Number(q.limit || 150), 500);
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.actor_id) {
      params.push(q.actor_id);
      where.push(`actor_id = $${params.length}`);
    }
    if (q.action) {
      params.push(q.action);
      where.push(`action = $${params.length}`);
    }
    params.push(limit);
    const r = await pool.query(
      `SELECT * FROM staff_events
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    );
    return { items: r.rows };
  });
}
