import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { findStaffByEmail, verifyPassword } from "../auth";
import { logStaffEvent } from "../staffEvents";
import { pool } from "../db";

export function registerAuthRoutes(app: FastifyInstance) {
  app.post("/auth/login", async (req, reply) => {
    const body = z
      .object({
        email: z.string().email(),
        password: z.string().min(1),
      })
      .parse(req.body);

    const user = await findStaffByEmail(body.email);
    if (!user || !user.active) {
      await logStaffEvent({
        req,
        action: "login_fail",
        summary: `Неудачный вход: ${body.email}`,
        target_email: body.email,
        meta: { reason: "unknown_or_inactive" },
      });
      return reply.code(401).send({
        error: "invalid_credentials",
        message: "Неверный email или пароль",
      });
    }
    const ok = await verifyPassword(body.password, user.password_hash);
    if (!ok) {
      await logStaffEvent({
        req,
        action: "login_fail",
        summary: `Неверный пароль: ${user.email}`,
        target_id: user.id,
        target_email: user.email,
        actor: { id: user.id, email: user.email, name: user.name, role: user.role },
        meta: { reason: "bad_password" },
      });
      return reply.code(401).send({
        error: "invalid_credentials",
        message: "Неверный email или пароль",
      });
    }

    await pool.query(
      `UPDATE staff_users SET last_login_at = NOW() WHERE id = $1`,
      [user.id]
    );
    await logStaffEvent({
      req,
      actor: { id: user.id, email: user.email, name: user.name, role: user.role },
      action: "login_ok",
      summary: `${user.role === "director" ? "Директор" : "Менеджер"} ${user.name} вошёл в кабинет`,
      target_id: user.id,
      target_email: user.email,
    });

    const token = app.jwt.sign(
      {
        sub: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
      },
      { expiresIn: "12h" }
    );

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
      },
    };
  });

  app.get("/auth/me", async (req, reply) => {
    if (!req.staff || req.staff.role === "service" || !req.staff.id) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    return {
      user: {
        id: req.staff.id,
        email: req.staff.email,
        role: req.staff.role,
        name: req.staff.name,
      },
    };
  });
}
