import "dotenv/config";
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../scripts/load-secrets.cjs");
} catch {
  /* optional */
}

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { resolve } from "path";
import { config as loadEnv } from "dotenv";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import input from "input";

// Monorepo root .env (pnpm --filter runs with cwd = apps/tg-gateway)
loadEnv({ path: resolve(__dirname, "../../../.env") });

const CODE_FILE = resolve(__dirname, "../.tg-phone-code");

async function readPhone(): Promise<string> {
  const fromEnv = (process.env.TG_PHONE || process.env.TG_LOGIN_PHONE || "").trim();
  if (fromEnv) {
    console.log(`Using TG_PHONE=${fromEnv}`);
    return fromEnv;
  }
  return input.text("Phone (+7...): ");
}

async function read2fa(): Promise<string> {
  const fromEnv = (process.env.TG_2FA_PASSWORD || process.env.TG_PASSWORD || "").trim();
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    console.log("No TG_2FA_PASSWORD in env; assuming no 2FA");
    return "";
  }
  return input.text("2FA password (if any, else Enter): ");
}

async function readCode(): Promise<string> {
  const fromEnv = (process.env.TG_PHONE_CODE || process.env.TG_CODE || "").trim();
  if (fromEnv) {
    console.log("Using TG_PHONE_CODE from env");
    return fromEnv;
  }

  console.log("");
  console.log("Telegram sent a login code.");
  console.log(`Put it into: ${CODE_FILE}`);
  console.log("  or set TG_PHONE_CODE and re-run");
  console.log("Waiting for code file (timeout 5 min)...");

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    if (existsSync(CODE_FILE)) {
      const code = readFileSync(CODE_FILE, "utf8").trim().replace(/\s+/g, "");
      try {
        unlinkSync(CODE_FILE);
      } catch {
        /* ignore */
      }
      if (code) {
        console.log("Code loaded from file");
        return code;
      }
    }
    if (process.stdin.isTTY) {
      // Interactive fallback if someone is at the terminal
      const typed = await input.text("Code (or wait for .tg-phone-code file): ");
      if (typed.trim()) return typed.trim();
    } else {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error("Timed out waiting for phone code");
}

async function login() {
  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH || "";
  if (!apiId || !apiHash) {
    console.error("Set TG_API_ID and TG_API_HASH in repo-root .env");
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: readPhone,
    password: read2fa,
    phoneCode: readCode,
    onError: (err) => console.error(err),
  });

  const session = String(client.session.save());
  console.log("\nTG_STRING_SESSION=");
  console.log(session);

  const outFile = resolve(__dirname, "../.tg-string-session");
  writeFileSync(outFile, session, "utf8");
  console.log(`\nAlso saved to ${outFile}`);

  await client.disconnect();
}

login().catch((e) => {
  console.error(e);
  process.exit(1);
});
