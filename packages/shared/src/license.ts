import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * Days after first install/start before LICENSE_KEY is required.
 * After this window API/gateway refuse to start without a valid key.
 */
export const LICENSE_GRACE_DAYS = 180;

/** After key activation, next renewal is due after this many days. */
export const LICENSE_PERIOD_DAYS = 180;

const KEY_PREFIX = "ALO1";

export type LicenseState = {
  /** Clock start: first API/gateway start on this install. */
  installedAt: string;
  activatedAt?: string;
  keyFingerprint?: string;
  periodEndsAt?: string;
};

export type LicenseCheckOk = {
  ok: true;
  mode: "grace" | "licensed" | "skipped";
  periodEndsAt?: string;
  daysLeft?: number;
};

export type LicenseCheckFail = {
  ok: false;
  code:
    | "missing_key"
    | "invalid_key"
    | "key_expired"
    | "renewal_required";
  message: string;
};

export type LicenseCheckResult = LicenseCheckOk | LicenseCheckFail;

function issuerSecret(): string {
  return (
    process.env.LICENSE_ISSUER_SECRET?.trim() ||
    "ALO-PANKOV-SV-2026-PROPRIETARY-ISSUER-v1"
  );
}

function repoRootFromCwd(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (
      fs.existsSync(path.join(dir, "pnpm-workspace.yaml")) ||
      fs.existsSync(path.join(dir, "LICENSE"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function licenseStatePath(): string {
  if (process.env.LICENSE_STATE_PATH?.trim()) {
    return path.resolve(process.env.LICENSE_STATE_PATH.trim());
  }
  return path.join(repoRootFromCwd(), "data", "license.state.json");
}

function fingerprint(key: string): string {
  return crypto.createHash("sha256").update(key.trim()).digest("hex").slice(0, 16);
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function daysLeftUntil(iso: string, now = new Date()): number {
  return Math.max(
    0,
    Math.ceil((new Date(iso).getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
  );
}

function loadState(): LicenseState {
  const p = licenseStatePath();
  try {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, "utf8")) as LicenseState;
      if (raw?.installedAt) return raw;
    }
  } catch {
    /* recreate */
  }
  const fresh: LicenseState = { installedAt: new Date().toISOString() };
  saveState(fresh);
  return fresh;
}

function saveState(state: LicenseState): void {
  const p = licenseStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export type IssuedLicense = {
  key: string;
  iat: number;
  exp: number;
  note?: string;
};

/** Issue a signed LICENSE_KEY (author tooling). Default validity: 180 days. */
export function issueLicenseKey(opts?: {
  days?: number;
  note?: string;
  nowSec?: number;
}): IssuedLicense {
  const days = opts?.days ?? LICENSE_PERIOD_DAYS;
  const iat = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  const exp = iat + days * 24 * 60 * 60;
  const body = {
    v: 1,
    iat,
    exp,
    note: opts?.note || "",
  };
  const payload = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const sig = crypto
    .createHmac("sha256", issuerSecret())
    .update(payload)
    .digest("base64url");
  return { key: `${KEY_PREFIX}.${payload}.${sig}`, iat, exp, note: opts?.note };
}

export function verifyLicenseKeyFormat(key: string): {
  ok: boolean;
  reason?: string;
  exp?: number;
  iat?: number;
} {
  const trimmed = key.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 3 || parts[0] !== KEY_PREFIX) {
    return { ok: false, reason: "expected ALO1.<payload>.<signature>" };
  }
  const payload = parts[1]!;
  const sig = parts[2]!;
  const expected = crypto
    .createHmac("sha256", issuerSecret())
    .update(payload)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad signature" };
  }
  let data: { v?: number; iat?: number; exp?: number };
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      v?: number;
      iat?: number;
      exp?: number;
    };
  } catch {
    return { ok: false, reason: "bad payload" };
  }
  if (data.v !== 1 || typeof data.exp !== "number" || typeof data.iat !== "number") {
    return { ok: false, reason: "bad payload fields" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (now > data.exp) {
    return { ok: false, reason: "key expired", exp: data.exp, iat: data.iat };
  }
  return { ok: true, exp: data.exp, iat: data.iat };
}

function maySkipLicense(): boolean {
  if (process.env.LICENSE_SKIP === "1" || process.env.LICENSE_SKIP === "true") {
    if (
      process.env.NODE_ENV === "production" ||
      process.env.ALO_ENV === "production"
    ) {
      return process.env.LICENSE_ALLOW_SKIP === "true";
    }
    return true;
  }
  return false;
}

/** Require LICENSE_KEY even during the first 180-day grace window. */
function enforceImmediately(): boolean {
  const v = process.env.LICENSE_ENFORCE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "immediate";
}

function activateKey(state: LicenseState, key: string): LicenseState {
  const now = new Date().toISOString();
  const fp = fingerprint(key);
  if (state.keyFingerprint !== fp) {
    state.activatedAt = now;
    state.keyFingerprint = fp;
    state.periodEndsAt = addDays(now, LICENSE_PERIOD_DAYS);
  } else if (!state.periodEndsAt || !state.activatedAt) {
    state.activatedAt = state.activatedAt || now;
    state.periodEndsAt = addDays(state.activatedAt, LICENSE_PERIOD_DAYS);
  }
  saveState(state);
  return state;
}

/**
 * License gate for API / gateways.
 *
 * Timeline (default):
 *   • First start → record installedAt in data/license.state.json
 *   • 180 days → grace (no LICENSE_KEY required)
 *   • After 180 days → LICENSE_KEY required; refuse without valid signed key
 *   • Valid key → another 180 days; then a *new* key is required
 *
 * LICENSE_ENFORCE=true → require key immediately (no grace).
 * LICENSE_SKIP=true → skip in non-production (CI/dev).
 */
export function checkLicense(): LicenseCheckResult {
  if (maySkipLicense()) {
    return { ok: true, mode: "skipped" };
  }

  const state = loadState();
  const now = new Date();
  const graceEndsAt = addDays(state.installedAt, LICENSE_GRACE_DAYS);
  const inGrace = now.getTime() < new Date(graceEndsAt).getTime();
  const key = process.env.LICENSE_KEY?.trim() || "";

  if (inGrace && !enforceImmediately() && !key) {
    return {
      ok: true,
      mode: "grace",
      periodEndsAt: graceEndsAt,
      daysLeft: daysLeftUntil(graceEndsAt, now),
    };
  }

  if (!key) {
    return {
      ok: false,
      code: "missing_key",
      message:
        inGrace && enforceImmediately()
          ? "LICENSE_ENFORCE is on: LICENSE_KEY is required at start. Set LICENSE_KEY in .env (node scripts/issue-license.mjs)."
          : `Grace period ended (${LICENSE_GRACE_DAYS} days after install/start). ` +
            "LICENSE_KEY is required — API/gateway refuse to start without a key. " +
            "Obtain a key from Pankov Sergey Vladimirovich, set LICENSE_KEY in .env, restart. " +
            "See LICENSE / SUPPORT.md · issue: node scripts/issue-license.mjs",
    };
  }

  const verified = verifyLicenseKeyFormat(key);
  if (!verified.ok) {
    if (verified.reason === "key expired") {
      return {
        ok: false,
        code: "key_expired",
        message:
          "LICENSE_KEY has expired. Request a new key (renewal every 6 months).",
      };
    }
    return {
      ok: false,
      code: "invalid_key",
      message: `LICENSE_KEY is invalid (${verified.reason || "unknown"}).`,
    };
  }

  const next = activateKey(state, key);
  const periodEndsAt = next.periodEndsAt!;

  if (now.getTime() > new Date(periodEndsAt).getTime()) {
    return {
      ok: false,
      code: "renewal_required",
      message:
        `License period ended (${LICENSE_PERIOD_DAYS} days after key activation). ` +
        "Request a new LICENSE_KEY, replace it in .env, then restart.",
    };
  }

  const endsMs = Math.min(
    new Date(periodEndsAt).getTime(),
    verified.exp ? verified.exp * 1000 : Number.POSITIVE_INFINITY
  );
  const ends = new Date(endsMs).toISOString();

  return {
    ok: true,
    mode: "licensed",
    periodEndsAt: ends,
    daysLeft: daysLeftUntil(ends, now),
  };
}

/** Check license and exit process on failure. Call before listen()/main work. */
export function assertLicenseOrExit(service: string): LicenseCheckOk {
  const result = checkLicense();
  if (!result.ok) {
    // eslint-disable-next-line no-console
    console.error(
      `[license] ${service}: REFUSED — ${result.code}\n${result.message}`
    );
    process.exit(1);
  }
  return result;
}
