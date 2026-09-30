/**
 * HTTP integration tests with Postgres: login + deals CRUD.
 * Requires DATABASE_URL (e.g. CI e2e-smoke after migrate).
 * Run: pnpm --filter @alo/api exec tsx src/http.db.test.ts
 */
process.env.ALO_ENV = "development";
process.env.NODE_ENV = "development";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-db-suite-32b";
process.env.CABINET_AUTH_REQUIRED = "true";
process.env.CABINET_DIRECTOR_EMAIL = "ci-db-director@autologistics.local";
process.env.CABINET_DIRECTOR_PASSWORD = "CiDbTestDir!2026";
process.env.CABINET_DIRECTOR_NAME = "CI Director";

import { createApp } from "./app";
import { seedStaffUsers } from "./auth";
import { pool } from "./db";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("http.db.test.ts: skip (no DATABASE_URL)");
    process.exit(0);
  }

  await seedStaffUsers();
  const app = await createApp({ logger: false });
  let dealId: string | null = null;

  try {
    const badLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "ci-db-director@autologistics.local", password: "wrong" },
    });
    assert(badLogin.statusCode === 401, `bad login expected 401 got ${badLogin.statusCode}`);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: "ci-db-director@autologistics.local",
        password: "CiDbTestDir!2026",
      },
    });
    assert(login.statusCode === 200, `login expected 200 got ${login.statusCode}`);
    const { token, user } = login.json() as { token: string; user: { role: string } };
    assert(Boolean(token), "token missing");
    assert(user.role === "director", "director role");

    const auth = { authorization: `Bearer ${token}` };

    const me = await app.inject({ method: "GET", url: "/auth/me", headers: auth });
    assert(me.statusCode === 200, "auth/me");

    const created = await app.inject({
      method: "POST",
      url: "/deals",
      headers: auth,
      payload: {
        client_name: "CI DB Test Client",
        cargo: { name: "boxes", quantity: 10 },
        route: { origin_city: "Guangzhou", destination_city: "Moscow" },
      },
    });
    assert(created.statusCode === 201, `create deal ${created.statusCode}`);
    const deal = created.json() as { id: string; client_name: string };
    dealId = deal.id;
    assert(deal.client_name === "CI DB Test Client", "client_name");

    const one = await app.inject({ method: "GET", url: `/deals/${dealId}`, headers: auth });
    assert(one.statusCode === 200, "get deal");
    assert((one.json() as { id: string }).id === dealId, "deal id match");

    const list = await app.inject({ method: "GET", url: "/deals?limit=5", headers: auth });
    assert(list.statusCode === 200, "list deals");
    const rows = list.json() as Array<{ id: string }>;
    assert(rows.some((r) => r.id === dealId), "deal in list");
  } finally {
    if (dealId) {
      await pool.query(`DELETE FROM deals WHERE id = $1`, [dealId]);
    }
    await app.close();
    await pool.end();
  }

  console.log("http.db.test.ts: ok");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
