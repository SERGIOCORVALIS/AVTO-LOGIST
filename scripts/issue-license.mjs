#!/usr/bin/env node
/**
 * Issue a signed LICENSE_KEY for AutoLogistics OS.
 *
 * Usage:
 *   node scripts/issue-license.mjs
 *   node scripts/issue-license.mjs --days 180 --note "customer-x"
 *   LICENSE_ISSUER_SECRET=... node scripts/issue-license.mjs
 *
 * Paste the printed key into .env as LICENSE_KEY=...
 */
import crypto from "crypto";

const daysArg = process.argv.includes("--days")
  ? Number(process.argv[process.argv.indexOf("--days") + 1])
  : 180;
const noteArg = process.argv.includes("--note")
  ? String(process.argv[process.argv.indexOf("--note") + 1] || "")
  : "";

const secret =
  process.env.LICENSE_ISSUER_SECRET?.trim() ||
  "ALO-PANKOV-SV-2026-PROPRIETARY-ISSUER-v1";

const days = Number.isFinite(daysArg) && daysArg > 0 ? daysArg : 180;
const iat = Math.floor(Date.now() / 1000);
const exp = iat + days * 24 * 60 * 60;
const payload = Buffer.from(
  JSON.stringify({ v: 1, iat, exp, note: noteArg }),
  "utf8"
).toString("base64url");
const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
const key = `ALO1.${payload}.${sig}`;

console.log("LICENSE_KEY=" + key);
console.log("# valid_days=" + days);
console.log("# expires_utc=" + new Date(exp * 1000).toISOString());
if (noteArg) console.log("# note=" + noteArg);
