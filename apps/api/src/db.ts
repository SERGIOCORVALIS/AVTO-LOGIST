import { Pool } from "pg";

/** Rewrite localhost → 127.0.0.1 so Windows does not try ::1 first. */
export function preferIpv4Loopback(url: string): string {
  return url.replace(
    new RegExp("(://|@)localhost(?=[:/?#]|$)", "g"),
    (_m, prefix: string) => `${prefix}127.0.0.1`
  );
}

export const pool = new Pool({
  connectionString: preferIpv4Loopback(
    process.env.DATABASE_URL ||
      "postgresql://alo:alo@127.0.0.1:5432/autologistics"
  ),
});

export async function withIdempotency<T>(
  key: string,
  scope: string,
  ttlSeconds: number,
  fn: () => Promise<T>
): Promise<{ cached: boolean; result: T }> {
  const existing = await pool.query(
    `SELECT result FROM idempotency_keys WHERE key = $1 AND expires_at > NOW()`,
    [key]
  );
  if (existing.rows[0]) {
    return { cached: true, result: existing.rows[0].result as T };
  }
  const result = await fn();
  await pool.query(
    `INSERT INTO idempotency_keys (key, scope, result, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' seconds')::interval)
     ON CONFLICT (key) DO NOTHING`,
    [key, scope, JSON.stringify(result), String(ttlSeconds)]
  );
  return { cached: false, result };
}
