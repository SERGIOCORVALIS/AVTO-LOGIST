import type { Pool } from "pg";

export async function buildDailyDigest(pool: Pool): Promise<string> {
  const byStatus = await pool.query(`
    SELECT status, COUNT(*)::int AS n,
           COALESCE(AVG(margin_pct),0)::float AS avg_margin,
           COALESCE(SUM(amount_rub),0)::float AS revenue
    FROM deals GROUP BY status ORDER BY n DESC
  `);
  const won = await pool.query(`
    SELECT COUNT(*)::int AS n, COALESCE(AVG(margin_pct),0)::float AS m,
           COALESCE(SUM(amount_rub),0)::float AS rev
    FROM deals WHERE status = 'closed_won'
      AND closed_at >= NOW() - INTERVAL '1 day'
  `);
  const esc = await pool.query(
    `SELECT COUNT(*)::int AS n FROM escalations WHERE status = 'pending'`
  );
  const learning = await pool.query(`
    SELECT COUNT(*)::int AS n FROM playbook_versions WHERE status = 'pending_approve'
  `);

  // A/B playbook lanes (last 7 days)
  const ab = await pool.query(`
    SELECT
      COALESCE(playbook_version, 'unknown') AS lane,
      COUNT(*) FILTER (WHERE status = 'closed_won')::int AS won,
      COUNT(*) FILTER (WHERE status = 'closed_lost')::int AS lost,
      COALESCE(AVG(margin_pct) FILTER (WHERE status = 'closed_won'),0)::float AS avg_margin
    FROM deals
    WHERE closed_at >= NOW() - INTERVAL '7 days'
      AND status IN ('closed_won','closed_lost')
    GROUP BY 1
    ORDER BY won DESC
  `);

  const canary = await pool.query(`
    SELECT name, version, status, canary_pct
    FROM playbook_versions
    WHERE status IN ('canary','active','pending_approve')
    ORDER BY created_at DESC LIMIT 5
  `);

  const lines = [
    "📊 CEO DIGEST — AutoLogistics OS",
    `time: ${new Date().toISOString()}`,
    "",
    "By status:",
    ...byStatus.rows.map(
      (r) =>
        `• ${r.status}: ${r.n} | avg margin ${Number(r.avg_margin).toFixed(1)}% | rev ${Number(r.revenue).toFixed(0)}`
    ),
    "",
    `Last 24h won: ${won.rows[0]?.n ?? 0} | margin ${Number(won.rows[0]?.m ?? 0).toFixed(1)}% | rev ${Number(won.rows[0]?.rev ?? 0).toFixed(0)}`,
    `Pending escalations: ${esc.rows[0]?.n ?? 0}`,
    `Learning proposals awaiting approve: ${learning.rows[0]?.n ?? 0}`,
    "",
    "A/B playbooks (7d):",
    ...(ab.rows.length
      ? ab.rows.map((r) => {
          const total = Number(r.won) + Number(r.lost);
          const wr = total ? ((100 * Number(r.won)) / total).toFixed(0) : "—";
          return `• ${r.lane}: won ${r.won}/lost ${r.lost} | winrate ${wr}% | margin ${Number(r.avg_margin).toFixed(1)}%`;
        })
      : ["• no closed deals yet"]),
    "",
    "Playbook versions:",
    ...canary.rows.map(
      (r) => `• ${r.status}: ${r.name}@${r.version} (canary ${r.canary_pct}%)`
    ),
    "",
    "Actions: /escalations · /playbooks · /deal <id> · review floor breaches",
  ];
  return lines.join("\n");
}
