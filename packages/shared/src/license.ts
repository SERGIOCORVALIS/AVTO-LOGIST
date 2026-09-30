import crypto from "crypto";
import fs from "fs";
import path from "path";
import readline from "readline";

/** Trial length after first install/launch. */
export const LICENSE_TRIAL_MONTHS = 12;

/**
 * Issuer HMAC secret used to sign LICENSE_KEY tokens.
 * Keys are created with: node scripts/generate-license.mjs
 */
const ISSUER_SECRET =
  process.env.ALO_LICENSE_ISSUER_SECRET ||
  "alo-psv-2026-proprietary-issuer-v1-7f3c9e2a1b8d4f06";

const INSTALL_FILE = ".alo_install.json";
const LICENSE_FILE = ".alo_license";

export type LicenseStatus =
  | { ok: true; mode: "trial"; installedAt: string; trialEndsAt: string; daysLeft: number }
  | { ok: true; mode: "licensed"; subject?: string; expiresAt?: string }
  | { ok: false; reason: string; installedAt?: string; trialEndsAt?: string };

function findRepoRoot(): string {
  const envRoot = process.env.ALO_ROOT || process.env.LICENSE_DATA_DIR;
  if (envRoot && fs.existsSync(envRoot)) return path.resolve(envRoot);

  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (
      fs.existsSync(path.join(dir, "pnpm-workspace.yaml")) ||
      (fs.existsSync(path.join(dir, "package.json")) &&
        fs.existsSync(path.join(dir, "apps")))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function dataDir(): string {
  const root = findRepoRoot();
  const dir = path.join(root, "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function b64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "utf8");
  return b.toString("base64url");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function signPayload(payloadB64: string): string {
  return b64url(
    crypto.createHmac("sha256", ISSUER_SECRET).update(payloadB64).digest()
  );
}

export function ensureInstallStamp(now = new Date()): {
  installedAt: string;
  created: boolean;
} {
  const file = path.join(dataDir(), INSTALL_FILE);
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
        installedAt?: string;
      };
      if (raw.installedAt) {
        return { installedAt: raw.installedAt, created: false };
      }
    } catch {
      /* recreate */
    }
  }
  const installedAt = now.toISOString();
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        installedAt,
        product: "AutoLogistics OS",
        copyright: "Copyright (c) 2026 Pankov Sergey Vladimirovich",
      },
      null,
      2
    ),
    "utf8"
  );
  return { installedAt, created: true };
}

export function trialEndsAt(installedAtIso: string): Date {
  const d = new Date(installedAtIso);
  d.setMonth(d.getMonth() + LICENSE_TRIAL_MONTHS);
  return d;
}

function readStoredLicenseKey(): string {
  const fromEnv = (process.env.LICENSE_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const file = path.join(dataDir(), LICENSE_FILE);
  if (fs.existsSync(file)) {
    return fs.readFileSync(file, "utf8").trim();
  }
  return "";
}

export function saveLicenseKey(key: string): void {
  const file = path.join(dataDir(), LICENSE_FILE);
  fs.writeFileSync(file, key.trim() + "\n", "utf8");
}

type KeyPayload = {
  sub?: string;
  exp?: number | null;
  iat?: number;
};

export function verifyLicenseKey(key: string, now = new Date()): {
  valid: boolean;
  subject?: string;
  expiresAt?: string;
  reason?: string;
} {
  const raw = key.trim();
  if (!raw) return { valid: false, reason: "empty_key" };

  const parts = raw.split(".");
  if (parts.length !== 3 || parts[0] !== "ALO1") {
    return { valid: false, reason: "invalid_format" };
  }
  const [, payloadB64, sig] = parts;
  const expected = signPayload(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: "bad_signature" };
  }

  let payload: KeyPayload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString("utf8")) as KeyPayload;
  } catch {
    return { valid: false, reason: "bad_payload" };
  }

  if (payload.exp != null && payload.exp > 0) {
    const expMs = payload.exp * 1000;
    if (now.getTime() > expMs) {
      return {
        valid: false,
        reason: "key_expired",
        subject: payload.sub,
        expiresAt: new Date(expMs).toISOString(),
      };
    }
    return {
      valid: true,
      subject: payload.sub,
      expiresAt: new Date(expMs).toISOString(),
    };
  }

  return { valid: true, subject: payload.sub };
}

/** Author-side helper: mint a signed key. */
export function mintLicenseKey(opts: {
  subject?: string;
  daysValid?: number | null;
  perpetual?: boolean;
}): string {
  const iat = Math.floor(Date.now() / 1000);
  let exp: number | null = null;
  if (!opts.perpetual && opts.daysValid != null) {
    exp = iat + Math.floor(opts.daysValid * 86400);
  } else if (!opts.perpetual && opts.daysValid === undefined) {
    exp = iat + 365 * 86400;
  }
  const payload: KeyPayload = {
    sub: opts.subject || "licensee",
    exp,
    iat,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  return `ALO1.${payloadB64}.${signPayload(payloadB64)}`;
}

export function checkLicense(now = new Date()): LicenseStatus {
  const { installedAt } = ensureInstallStamp(now);
  const ends = trialEndsAt(installedAt);
  const key = readStoredLicenseKey();

  if (key) {
    const v = verifyLicenseKey(key, now);
    if (v.valid) {
      return {
        ok: true,
        mode: "licensed",
        subject: v.subject,
        expiresAt: v.expiresAt,
      };
    }
  }

  if (now.getTime() <= ends.getTime()) {
    const daysLeft = Math.max(
      0,
      Math.ceil((ends.getTime() - now.getTime()) / 86400000)
    );
    return {
      ok: true,
      mode: "trial",
      installedAt,
      trialEndsAt: ends.toISOString(),
      daysLeft,
    };
  }

  const reason = key
    ? "Пробный период закончился, а LICENSE_KEY недействителен."
    : "Пробный период 12 месяцев закончился. Требуется LICENSE_KEY.";

  return {
    ok: false,
    reason,
    installedAt,
    trialEndsAt: ends.toISOString(),
  };
}

async function promptForKey(): Promise<string> {
  if (!process.stdin.isTTY) return "";
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      "\nВведите LICENSE_KEY (или оставьте пустым для выхода): ",
      (v) => resolve(v.trim())
    );
  });
  rl.close();
  return answer;
}

export async function enforceLicense(opts?: {
  service?: string;
  allowPrompt?: boolean;
}): Promise<LicenseStatus> {
  const service = opts?.service || "app";
  const allowPrompt = opts?.allowPrompt ?? Boolean(process.stdin.isTTY);

  let status = checkLicense();
  if (status.ok) {
    if (status.mode === "trial" && status.daysLeft <= 14) {
      console.warn(
        `[license:${service}] Пробный период: осталось ~${status.daysLeft} дн. (до ${status.trialEndsAt}). После этого нужен LICENSE_KEY.`
      );
    } else if (status.mode === "licensed") {
      console.info(
        `[license:${service}] Лицензия активна` +
          (status.subject ? ` (${status.subject})` : "") +
          (status.expiresAt ? `, до ${status.expiresAt}` : "")
      );
    }
    return status;
  }

  console.error("============================================================");
  console.error(" AutoLogistics OS — требуется лицензионный ключ");
  console.error(" Copyright (c) 2026 Pankov Sergey Vladimirovich");
  console.error("============================================================");
  console.error(status.reason);
  if (status.trialEndsAt) {
    console.error(`Пробный период истёк: ${status.trialEndsAt}`);
  }
  console.error(
    "Укажите ключ в .env (LICENSE_KEY=...) или в data/.alo_license"
  );
  console.error("Ключ выдаёт автор ПО по письменному соглашению.");
  console.error("============================================================");

  if (allowPrompt) {
    const entered = await promptForKey();
    if (entered) {
      const v = verifyLicenseKey(entered);
      if (v.valid) {
        saveLicenseKey(entered);
        process.env.LICENSE_KEY = entered;
        console.info("[license] Ключ принят и сохранён в data/.alo_license");
        return checkLicense();
      }
      console.error("[license] Ключ отклонён:", v.reason || "invalid");
    }
  }

  process.exit(78); // EX_CONFIG
}
