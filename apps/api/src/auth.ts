import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "crypto";
import { promisify } from "util";
import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "./db";

const scrypt = promisify(scryptCb);

export type StaffRole = "director" | "manager";
export type AuthRole = StaffRole | "service";

export interface StaffUser {
  id: string;
  email: string;
  role: StaffRole;
  name: string;
  active: boolean;
}

export interface RequestStaff {
  id?: string;
  email?: string;
  name?: string;
  role: AuthRole;
}

declare module "fastify" {
  interface FastifyRequest {
    staff?: RequestStaff;
  }
}

export const DIRECTOR_ESCALATION_REASONS = new Set([
  "amount_threshold",
  "margin_or_discount_policy",
  "profit_below_minimum",
  "cashflow_gap",
  "legal_must_approve",
  "grey_scheme_hard_block",
  "grey_scheme_request",
  "sanctioned_goods",
  "procurement_loss_pattern",
]);

export const DOCUMENT_FOLDERS = [
  "kp",
  "contracts",
  "invoices",
  "customs",
  "client",
  "other",
] as const;

export type DocumentFolder = (typeof DOCUMENT_FOLDERS)[number];

export function isProduction(): boolean {
  return (
    process.env.ALO_ENV === "production" ||
    process.env.NODE_ENV === "production"
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${buf.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const [salt, hex] = stored.split(":");
  if (!salt || !hex) return false;
  const buf = (await scrypt(password, salt, 64)) as Buffer;
  const storedBuf = Buffer.from(hex, "hex");
  if (buf.length !== storedBuf.length) return false;
  return timingSafeEqual(buf, storedBuf);
}

export async function ensureStaffSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_users (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('director', 'manager')),
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `ALTER TABLE staff_users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`
  );
}

async function upsertStaff(opts: {
  email: string;
  password: string;
  role: StaffRole;
  name: string;
}): Promise<void> {
  const hash = await hashPassword(opts.password);
  await pool.query(
    `INSERT INTO staff_users (email, password_hash, role, name, active)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       role = EXCLUDED.role,
       name = EXCLUDED.name,
       active = TRUE,
       updated_at = NOW()`,
    [opts.email.toLowerCase().trim(), hash, opts.role, opts.name]
  );
}

import { ensureStaffEventsSchema } from "./staffEvents";

export async function seedStaffUsers(): Promise<void> {
  await ensureStaffSchema();
  await ensureStaffEventsSchema();
  const prod = isProduction();

  const directorEmail =
    process.env.CABINET_DIRECTOR_EMAIL ||
    (prod ? "" : "director@transinvest.local");
  const directorPassword =
    process.env.CABINET_DIRECTOR_PASSWORD ||
    (prod ? "" : "TransinvestDir!2026");
  const managerEmail =
    process.env.CABINET_MANAGER_EMAIL ||
    (prod ? "" : "manager@transinvest.local");
  const managerPassword =
    process.env.CABINET_MANAGER_PASSWORD ||
    (prod ? "" : "TransinvestMgr!2026");

  if (directorEmail && directorPassword) {
    await upsertStaff({
      email: directorEmail,
      password: directorPassword,
      role: "director",
      name: process.env.CABINET_DIRECTOR_NAME || "Директор",
    });
  }
  if (managerEmail && managerPassword) {
    await upsertStaff({
      email: managerEmail,
      password: managerPassword,
      role: "manager",
      name: process.env.CABINET_MANAGER_NAME || "Менеджер",
    });
  }
}

export async function findStaffByEmail(
  email: string
): Promise<(StaffUser & { password_hash: string }) | null> {
  const r = await pool.query(
    `SELECT id, email, password_hash, role, name, active
     FROM staff_users WHERE lower(email) = lower($1)`,
    [email.trim()]
  );
  return r.rows[0] ?? null;
}

export function publicPath(url: string): boolean {
  const path = url.split("?")[0];
  return path === "/health" || path === "/auth/login";
}

export function readInternalToken(req: FastifyRequest): string {
  const header = req.headers["x-internal-token"];
  if (typeof header === "string" && header) return header;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return "";
}

export function requireDirector(
  req: FastifyRequest,
  reply: FastifyReply
): boolean {
  const role = req.staff?.role;
  if (!role || role === "service") return true;
  if (role === "director") return true;
  reply.code(403).send({
    error: "director_only",
    message: "Это действие доступно только директору",
  });
  return false;
}

export function folderFromKind(
  kind?: string | null,
  filename?: string
): DocumentFolder {
  const k = (kind || "").toLowerCase();
  const n = (filename || "").toLowerCase();
  const blob = `${k} ${n}`;
  if (
    /\b(kp|quote|offer|расч[её]т|коммерч)/i.test(blob) ||
    k === "kp"
  ) {
    return "kp";
  }
  if (/\b(contract|договор|соглашен)/i.test(blob) || k === "contracts") {
    return "contracts";
  }
  if (/\b(invoice|инвойс|сч[её]т)/i.test(blob) || k === "invoices") {
    return "invoices";
  }
  if (
    /\b(customs|hs|cert|тамож|сертиф|дт|гтд)/i.test(blob) ||
    k === "customs"
  ) {
    return "customs";
  }
  if (/\b(client|клиент)/i.test(blob) || k === "client") {
    return "client";
  }
  return "other";
}
