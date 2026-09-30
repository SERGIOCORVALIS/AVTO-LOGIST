#!/usr/bin/env node
/**
 * CI smoke: POST orchestrator /process with gold_intake payload.
 * Usage: node scripts/ci-e2e-rfq.mjs [baseUrl]
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const base = process.argv[2] || process.env.ORCHESTRATOR_URL || "http://localhost:8000";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const casePath = join(root, "tests", "evals", "gold_intake.json");
const caseDef = JSON.parse(readFileSync(casePath, "utf8"));

const payload = {
  chat_id: caseDef.input.chat_id,
  text: caseDef.input.text,
  idempotency_key: `ci-e2e:${caseDef.name}:${randomUUID()}`,
};

const res = await fetch(`${base.replace(/\/$/, "")}/process`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

if (!res.ok) {
  const body = await res.text();
  console.error(`ci-e2e-rfq: HTTP ${res.status}`, body.slice(0, 500));
  process.exit(1);
}

const data = await res.json();
const exp = caseDef.expect || {};

if (exp.has_replies && !(data.replies && data.replies.length)) {
  console.error("ci-e2e-rfq: no replies", JSON.stringify(data).slice(0, 500));
  process.exit(1);
}
if (exp.status_in && !exp.status_in.includes(data.status)) {
  console.error(`ci-e2e-rfq: status ${data.status} not in`, exp.status_in);
  process.exit(1);
}

console.log("ci-e2e-rfq: ok", { status: data.status, replies: data.replies?.length ?? 0 });
