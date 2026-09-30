#!/usr/bin/env node
/**
 * Generate random values for production .env secrets (stdout only — never writes .env).
 * Usage: node scripts/generate-prod-secrets.mjs
 */
import { randomBytes } from "crypto";

function hex(n) {
  return randomBytes(n).toString("hex");
}

const out = {
  JWT_SECRET: hex(32),
  INTERNAL_API_TOKEN: hex(32),
  LANGFUSE_NEXTAUTH_SECRET: hex(32),
  LANGFUSE_SALT: hex(16),
  POSTGRES_PASSWORD: hex(16),
  CABINET_DIRECTOR_PASSWORD: `Dir!${hex(4)}`,
  CABINET_MANAGER_PASSWORD: `Mgr!${hex(4)}`,
};

console.log("# Paste into .env (production). Do NOT commit.\n");
for (const [k, v] of Object.entries(out)) {
  console.log(`${k}=${v}`);
}
console.log("\n# After setting POSTGRES_PASSWORD, update DATABASE_URL, e.g.:");
console.log(
  `DATABASE_URL=postgresql://alo:${out.POSTGRES_PASSWORD}@postgres:5432/autologistics`
);
console.log("\n# License: pnpm license:mint");
console.log("# Audit:   node scripts/audit-env.mjs");
