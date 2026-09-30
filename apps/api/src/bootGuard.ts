import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { isProduction } from "./auth";

const DEV_JWT_FALLBACK = "dev-transinvest-cabinet-secret";

function envOn(name: string): boolean {
  const v = (process.env[name] || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function envOff(name: string): boolean {
  const v = (process.env[name] || "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "no" || v === "off";
}

/** JWT secret: hard-fail in production if unset. */
export function resolveJwtSecret(): string {
  const secret = (process.env.JWT_SECRET || "").trim();
  if (secret) return secret;
  if (isProduction()) {
    throw new Error(
      "JWT_SECRET is required when ALO_ENV/NODE_ENV=production. Generate one: openssl rand -hex 32"
    );
  }
  return DEV_JWT_FALLBACK;
}

/**
 * Cabinet auth: default ON in production, OFF in development.
 * Explicit CABINET_AUTH_REQUIRED=false in production requires ALLOW_INSECURE_CABINET=true.
 */
export function cabinetAuthRequired(): boolean {
  const raw = process.env.CABINET_AUTH_REQUIRED;
  if (raw !== undefined && String(raw).trim() !== "") {
    if (envOn("CABINET_AUTH_REQUIRED")) return true;
    if (envOff("CABINET_AUTH_REQUIRED")) {
      if (isProduction() && !envOn("ALLOW_INSECURE_CABINET")) {
        throw new Error(
          "CABINET_AUTH_REQUIRED=false is blocked in production. Set CABINET_AUTH_REQUIRED=true " +
            "or ALLOW_INSECURE_CABINET=true (emergency only)."
        );
      }
      return false;
    }
  }
  return isProduction();
}

function emailListConfigured(value: string | undefined): boolean {
  return Boolean(value && value.includes("@"));
}

/** True if any supplier/partner quote email channel is configured. */
export function hasSupplierEmailChannels(): boolean {
  if (emailListConfigured(process.env.SUPPLIER_QUOTE_EMAILS)) return true;
  if (emailListConfigured(process.env.PARTNER_QUOTE_EMAILS)) return true;
  if (emailListConfigured(process.env.SOURCING_QUOTE_EMAILS)) return true;
  for (const [key, val] of Object.entries(process.env)) {
    if (
      (key.startsWith("SUPPLIER_EMAIL_") || key.startsWith("PARTNER_EMAIL_")) &&
      emailListConfigured(val)
    ) {
      return true;
    }
  }
  return false;
}

/** True if any SUPPLIER_HTTP_* / PARTNER_HTTP_* quote URL is set. */
export function hasHttpPartnerChannels(): boolean {
  for (const [key, val] of Object.entries(process.env)) {
    if (
      (key.startsWith("SUPPLIER_HTTP_") || key.startsWith("PARTNER_HTTP_")) &&
      typeof val === "string" &&
      val.startsWith("http")
    ) {
      return true;
    }
  }
  return false;
}

function partnerTariffsDir(): string {
  return join(__dirname, "..", "..", "..", "data", "partner_tariffs");
}

/** Non-example JSON tariff files on disk. */
export function listActiveTariffFiles(): string[] {
  const dir = partnerTariffsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(
    (name) =>
      name.endsWith(".json") &&
      !name.startsWith("example") &&
      !name.endsWith(".example.json")
  );
}

export function hasFileTariffChannels(): boolean {
  if (!envOn("ALLOW_FILE_TARIFFS")) return false;
  return listActiveTariffFiles().length > 0;
}

export function hasPartnerChannels(): boolean {
  return (
    hasSupplierEmailChannels() ||
    hasHttpPartnerChannels() ||
    hasFileTariffChannels()
  );
}

export type BootReport = {
  production: boolean;
  cabinetAuthRequired: boolean;
  partnerChannels: {
    email: boolean;
    http: boolean;
    fileTariffs: boolean;
    tariffFiles: string[];
  };
  mockRates: boolean;
};

export function inspectBootConfig(): BootReport {
  return {
    production: isProduction(),
    cabinetAuthRequired: (() => {
      try {
        return cabinetAuthRequired();
      } catch {
        return true;
      }
    })(),
    partnerChannels: {
      email: hasSupplierEmailChannels(),
      http: hasHttpPartnerChannels(),
      fileTariffs: hasFileTariffChannels(),
      tariffFiles: listActiveTariffFiles(),
    },
    mockRates: envOn("ALLOW_MOCK_RATES"),
  };
}

/**
 * Fail fast on insecure / incomplete production config.
 * Call before listen().
 */
export function assertProductionReady(log: {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
}): BootReport {
  const report = inspectBootConfig();

  if (!isProduction()) {
    log.info("boot_guard_dev", report as unknown as Record<string, unknown>);
    if (!hasPartnerChannels() && !envOn("ALLOW_MOCK_RATES")) {
      log.warn(
        "No supplier email/HTTP/file-tariff channels and ALLOW_MOCK_RATES=false — quotes will escalate missing_partner_channels"
      );
    }
    return report;
  }

  // Side-effect: validate auth flags (throws if insecure)
  cabinetAuthRequired();
  resolveJwtSecret();

  const token = (process.env.INTERNAL_API_TOKEN || "").trim();
  if (!token || token.length < 16) {
    throw new Error(
      "INTERNAL_API_TOKEN is required in production (min 16 chars). Generate: openssl rand -hex 32"
    );
  }

  if (envOn("ALLOW_MOCK_RATES")) {
    throw new Error(
      "ALLOW_MOCK_RATES=true is forbidden in production. Use SUPPLIER_QUOTE_EMAILS, PARTNER_HTTP_*, or ALLOW_FILE_TARIFFS + data/partner_tariffs/*.json"
    );
  }

  if (!hasPartnerChannels()) {
    throw new Error(
      "Production requires at least one partner channel: SUPPLIER_QUOTE_EMAILS / SUPPLIER_EMAIL_* / PARTNER_HTTP_* / or ALLOW_FILE_TARIFFS=true with non-example JSON under data/partner_tariffs/"
    );
  }

  const directorPass = process.env.CABINET_DIRECTOR_PASSWORD || "";
  if (
    directorPass === "TransinvestDir!2026" ||
    directorPass === "changeme" ||
    directorPass === "password"
  ) {
    throw new Error(
      "CABINET_DIRECTOR_PASSWORD is still a default/insecure value — set a unique password before production"
    );
  }

  log.info("boot_guard_production_ok", report as unknown as Record<string, unknown>);
  return report;
}
