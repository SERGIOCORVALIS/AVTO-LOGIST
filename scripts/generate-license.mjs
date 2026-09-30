#!/usr/bin/env node
/**
 * Author tool: mint LICENSE_KEY for a customer.
 *
 *   node scripts/generate-license.mjs --subject "ООО Клиент" --days 365
 *   node scripts/generate-license.mjs --subject "ООО Клиент" --perpetual
 *
 * Optional: set ALO_LICENSE_ISSUER_SECRET to override the embedded issuer secret.
 */
import crypto from "crypto";

const ISSUER_SECRET =
  process.env.ALO_LICENSE_ISSUER_SECRET ||
  "alo-psv-2026-proprietary-issuer-v1-7f3c9e2a1b8d4f06";

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function parseArgs(argv) {
  const out = { subject: "licensee", days: 365, perpetual: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--subject" || a === "-s") out.subject = argv[++i];
    else if (a === "--days" || a === "-d") out.days = Number(argv[++i]);
    else if (a === "--perpetual" || a === "-p") out.perpetual = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log(`Usage:
  node scripts/generate-license.mjs --subject "Name" --days 365
  node scripts/generate-license.mjs --subject "Name" --perpetual
`);
  process.exit(0);
}

const iat = Math.floor(Date.now() / 1000);
const payload = {
  sub: args.subject,
  exp: args.perpetual ? null : iat + Math.floor(args.days * 86400),
  iat,
};
const payloadB64 = b64url(JSON.stringify(payload));
const sig = b64url(
  crypto.createHmac("sha256", ISSUER_SECRET).update(payloadB64).digest()
);
const key = `ALO1.${payloadB64}.${sig}`;

console.log(key);
console.error("subject:", payload.sub);
console.error(
  "expires:",
  payload.exp ? new Date(payload.exp * 1000).toISOString() : "never"
);
