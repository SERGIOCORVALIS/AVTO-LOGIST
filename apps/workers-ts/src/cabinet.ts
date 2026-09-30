/**
 * Cabinet RFQ is not a quote HTTP API.
 * FESCO / iSales login pages must never be called as /quote.
 *
 * TZ v1: ПЭК / Деловые Линии / Байкал-Сервис may be groupage suppliers —
 * cabinet RFQ is allowed when CABINET_HTTP_* / credentials are set.
 * CDEK and Keycloak login URLs stay blocked (not quote channels).
 *
 * Default: write an operator task under logs/cabinets.
 * CABINET_PLAYWRIGHT=true: login with PARTNER_/CABINET_ credentials, paste RFQ, screenshot.
 * HTTPS: CABINET_SSL_VERIFY (default true) + CABINET_HTTP_TIMEOUT_SEC (default 60).
 * Does not invent a freight price from the portal.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as https from "node:https";

export type CabinetRfqPayload = {
  deal_id?: string;
  code?: string;
  url?: string;
  user?: string;
  route_summary?: string;
  cargo_summary?: string;
  weight_kg?: number;
  volume_m3?: number;
  corridor?: string;
  transport_mode?: string;
  ready_date?: string;
};

/** Not auto-cabinet quote channels (courier / IdP), not groupage suppliers. */
const FORBIDDEN = new Set(["cdek", "keycloak"]);

function envOn(name: string, fallback = false): boolean {
  const raw = (process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function cabinetSslVerify(): boolean {
  if ((process.env.CABINET_SSL_VERIFY || "").trim()) {
    return envOn("CABINET_SSL_VERIFY", true);
  }
  if ((process.env.PARTNER_SSL_VERIFY || "").trim()) {
    return envOn("PARTNER_SSL_VERIFY", true);
  }
  return true;
}

function cabinetTimeoutMs(): number {
  const raw = (
    process.env.CABINET_HTTP_TIMEOUT_SEC ||
    process.env.PARTNER_HTTP_TIMEOUT_SEC ||
    "60"
  ).trim();
  const sec = Number(raw);
  if (!Number.isFinite(sec) || sec <= 0) return 60_000;
  return Math.round(sec * 1000);
}

function envCreds(code: string): { user: string; password: string } {
  const u = code.toUpperCase();
  const user = (
    process.env[`CABINET_USERNAME_${u}`] ||
    process.env[`PARTNER_USERNAME_${u}`] ||
    process.env[`SUPPLIER_USERNAME_${u}`] ||
    ""
  ).trim();
  const password = (
    process.env[`CABINET_PASSWORD_${u}`] ||
    process.env[`PARTNER_PASSWORD_${u}`] ||
    process.env[`SUPPLIER_PASSWORD_${u}`] ||
    ""
  ).trim();
  return { user, password };
}

function rfqText(data: CabinetRfqPayload): string {
  return [
    `RFQ deal ${data.deal_id || "—"}`,
    data.route_summary || "",
    data.cargo_summary || "",
    data.corridor ? `corridor: ${data.corridor}` : "",
    data.transport_mode ? `mode: ${data.transport_mode}` : "",
    data.weight_kg != null ? `weight: ${data.weight_kg} kg` : "",
    data.volume_m3 != null ? `volume: ${data.volume_m3} m3` : "",
    data.ready_date ? `ready: ${data.ready_date}` : "",
    "Need: price, transit time, extras, validity.",
  ]
    .filter(Boolean)
    .join("\n");
}

function taskDir(): string {
  const dir = join(process.cwd(), "logs", "cabinets");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeOperatorTask(data: CabinetRfqPayload, extra: Record<string, unknown>) {
  const dir = taskDir();
  const code = (data.code || "cabinet").toLowerCase();
  const name = `${code}-${data.deal_id || "nodeal"}-${Date.now()}.json`;
  const path = join(dir, name);
  writeFileSync(
    path,
    JSON.stringify(
      {
        ...extra,
        code,
        url: data.url,
        deal_id: data.deal_id,
        rfq: rfqText(data),
        user_set: Boolean(envCreds(code).user),
        ssl_verify: cabinetSslVerify(),
        timeout_ms: cabinetTimeoutMs(),
      },
      null,
      2
    ),
    "utf8"
  );
  return path;
}

/** Lightweight HTTPS reachability probe (rates path uses Playwright for login UIs). */
export function probeCabinetHttps(
  url: string,
  opts?: { timeoutMs?: number; sslVerify?: boolean }
): Promise<{ ok: boolean; status?: number; error?: string; ms: number }> {
  const timeoutMs = opts?.timeoutMs ?? cabinetTimeoutMs();
  const sslVerify = opts?.sslVerify ?? cabinetSslVerify();
  const started = Date.now();
  return new Promise((resolve) => {
    try {
      const req = https.request(
        url,
        {
          method: "GET",
          timeout: timeoutMs,
          rejectUnauthorized: sslVerify,
        },
        (res) => {
          res.resume();
          resolve({ ok: true, status: res.statusCode, ms: Date.now() - started });
        }
      );
      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, error: "timeout", ms: Date.now() - started });
      });
      req.on("error", (e) => {
        resolve({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          ms: Date.now() - started,
        });
      });
      req.end();
    } catch (e) {
      resolve({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        ms: Date.now() - started,
      });
    }
  });
}

async function playwrightSubmit(data: CabinetRfqPayload) {
  const code = (data.code || "cabinet").toLowerCase();
  const url = data.url || "";
  const { user, password } = envCreds(code);
  const timeoutMs = cabinetTimeoutMs();
  const sslVerify = cabinetSslVerify();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pw: any;
  try {
    pw = await import("playwright");
  } catch {
    return { ok: true, mode: "playwright_missing" as const, code };
  }
  if (!url.startsWith("http")) {
    return { ok: false, mode: "no_url" as const, code };
  }

  const probe = await probeCabinetHttps(url, { timeoutMs, sslVerify });
  console.log(
    `[cabinet] https_probe code=${code} ok=${probe.ok} status=${probe.status ?? ""} ms=${probe.ms} ssl_verify=${sslVerify}${probe.error ? ` err=${probe.error}` : ""}`
  );

  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: !sslVerify,
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    if (user) {
      const userBox = page
        .locator(
          'input[type="email"], input[name*="login" i], input[name*="user" i], input[id*="login" i], input[id*="user" i], input[type="text"]'
        )
        .first();
      if (await userBox.count()) await userBox.fill(user, { timeout: 8_000 });
    }
    if (password) {
      const passBox = page.locator('input[type="password"]').first();
      if (await passBox.count()) await passBox.fill(password, { timeout: 8_000 });
      const submit = page
        .locator('button[type="submit"], input[type="submit"], button:has-text("Войти"), button:has-text("Login")')
        .first();
      if (await submit.count()) await submit.click({ timeout: 8_000 });
      await page.waitForTimeout(2500);
    }
    const box = page.locator("textarea").first();
    if (await box.count()) {
      await box.fill(rfqText(data), { timeout: 5_000 });
    }
    const shot = join(taskDir(), `${code}-${data.deal_id || "nodeal"}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    const task = writeOperatorTask(data, {
      mode: "playwright_login",
      screenshot: shot,
      page_url: page.url(),
      https_probe: probe,
    });
    console.log(`[cabinet] playwright ${code} screenshot=${shot} task=${task}`);
    return { ok: true, mode: "playwright_login" as const, code, screenshot: shot, probe };
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function submitCabinetRfq(data: CabinetRfqPayload) {
  const code = (data.code || "cabinet").toLowerCase();
  if (FORBIDDEN.has(code)) {
    console.warn(`[cabinet] refused non-quote channel code=${code}`);
    return { ok: false, mode: "refused" as const, code };
  }

  const enabled =
    envOn("CABINET_RFQ_ENABLED", false) || envOn("CABINET_PLAYWRIGHT", false);
  if (!enabled) {
    console.log(
      `[cabinet] skipped code=${code} deal=${data.deal_id || ""} (set CABINET_RFQ_ENABLED or CABINET_PLAYWRIGHT)`
    );
    return { ok: true, mode: "skipped_disabled" as const, code };
  }

  console.log(
    `[cabinet] queued code=${code} deal=${data.deal_id || ""} url=${data.url || ""} ssl_verify=${cabinetSslVerify()} timeout_ms=${cabinetTimeoutMs()}`
  );
  const task = writeOperatorTask(data, { mode: "operator_queue" });

  if (process.env.CABINET_PLAYWRIGHT === "true") {
    try {
      return await playwrightSubmit(data);
    } catch (e) {
      console.warn(
        "[cabinet] playwright failed",
        e instanceof Error ? e.message : e
      );
      return { ok: true, mode: "playwright_error" as const, code, task };
    }
  }

  // Even without Playwright, probe HTTPS so operators see SSL/timeout from this host.
  if (data.url?.startsWith("http")) {
    const probe = await probeCabinetHttps(data.url);
    writeOperatorTask(data, { mode: "operator_queue", https_probe: probe });
    console.log(
      `[cabinet] https_probe code=${code} ok=${probe.ok} status=${probe.status ?? ""} ms=${probe.ms}${probe.error ? ` err=${probe.error}` : ""}`
    );
  }

  return { ok: true, mode: "operator_queue" as const, code, task };
}
