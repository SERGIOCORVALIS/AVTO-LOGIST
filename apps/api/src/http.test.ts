/**
 * HTTP tests without Postgres: auth 401, security headers, rate limit.
 * Run: pnpm --filter @alo/api exec tsx src/http.test.ts
 */
process.env.ALO_ENV = "development";
process.env.NODE_ENV = "development";
process.env.JWT_SECRET = "test-jwt-secret-for-http-suite-32b";
process.env.CABINET_AUTH_REQUIRED = "true";
process.env.ALLOW_INSECURE_CABINET = "false";
process.env.API_RATE_LIMIT_MAX = "8";
process.env.API_RATE_LIMIT_WINDOW_MS = "60000";

import { createApp } from "./app";
import { pool } from "./db";
import { resetRateLimitForTests } from "./security";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  resetRateLimitForTests();
  const app = await createApp({ logger: false });
  try {
    const denied = await app.inject({ method: "GET", url: "/stats/summary" });
    assert(denied.statusCode === 401, `stats expected 401 got ${denied.statusCode}`);
    assert(denied.headers["x-content-type-options"] === "nosniff", "nosniff");
    assert(denied.headers["x-frame-options"] === "DENY", "frame deny");
    assert(denied.headers["referrer-policy"] === "no-referrer", "referrer");

    const deals = await app.inject({ method: "GET", url: "/deals" });
    assert(deals.statusCode === 401, "deals 401");

    const policy = await app.inject({ method: "GET", url: "/policy" });
    assert(policy.statusCode === 401, "policy 401");

    resetRateLimitForTests();
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await app.inject({ method: "GET", url: "/deals" })).statusCode;
    }
    assert(last === 429, `expected 429 after burst, got ${last}`);
  } finally {
    await app.close();
    await pool.end();
  }
  console.log("http.test.ts: ok");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
