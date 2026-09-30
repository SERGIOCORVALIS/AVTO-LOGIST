import type { Pool } from "pg";
import { formatMoneyRub, formatWhen, statusRu } from "@alo/shared";

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
  const quotingStuck = await pool.query(`
    SELECT COUNT(*)::int AS n FROM deals
    WHERE status = 'quoting' AND updated_at < NOW() - INTERVAL '2 hours'
  `);
  const learning = await pool.query(`
    SELECT COUNT(*)::int AS n FROM playbook_versions WHERE status = 'pending_approve'
  `);

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

  const playbookStatusRu: Record<string, string> = {
    canary: "канарейка",
    active: "боевой",
    pending_approve: "ждёт одобрения",
  };

  const silentSuppliers = await pool.query(`
    SELECT COUNT(*)::int AS n FROM suppliers
    WHERE silent AND active AND NOT left_market
  `);

  const wonN = Number(won.rows[0]?.n ?? 0);
  const wonRev = Number(won.rows[0]?.rev ?? 0);
  const pendingEsc = Number(esc.rows[0]?.n ?? 0);
  const stuck = Number(quotingStuck.rows[0]?.n ?? 0);
  const learnN = Number(learning.rows[0]?.n ?? 0);
  const silentN = Number(silentSuppliers.rows[0]?.n ?? 0);

  const lines = [
    "📊 Сводка за сутки — AutoLogistics",
    formatWhen(new Date()),
    "",
    "Сделки по стадиям:",
    ...(byStatus.rows.length
      ? byStatus.rows.map(
          (r) =>
            `• ${statusRu(r.status)}: ${r.n} шт · ср. маржа ${Number(r.avg_margin).toFixed(1)}% · ${formatMoneyRub(Number(r.revenue))}`
        )
      : ["• пока нет сделок"]),
    "",
    `Выиграно за 24 ч: ${wonN} шт · маржа ${Number(won.rows[0]?.m ?? 0).toFixed(1)}% · ${formatMoneyRub(wonRev)}`,
    `Ждут решения: ${pendingEsc}`,
    `Зависли на ставках > 2 ч: ${stuck}`,
    `Поставщики «не отвечают»: ${silentN}`,
    `Плейбуки на одобрение: ${learnN}`,
    "",
    "Плейбуки за 7 дней:",
    ...(ab.rows.length
      ? ab.rows.map((r) => {
          const total = Number(r.won) + Number(r.lost);
          const wr = total ? ((100 * Number(r.won)) / total).toFixed(0) : "—";
          const lane = r.lane === "unknown" ? "без версии" : r.lane;
          return `• ${lane}: выиграно ${r.won} / проиграно ${r.lost} · winrate ${wr}% · маржа ${Number(r.avg_margin).toFixed(1)}%`;
        })
      : ["• закрытых сделок за неделю нет"]),
    "",
    "Версии плейбуков:",
    ...(canary.rows.length
      ? canary.rows.map(
          (r) =>
            `• ${playbookStatusRu[r.status] || r.status}: ${r.name} ${r.version} (canary ${r.canary_pct}%)`
        )
      : ["• нет активных версий"]),
    "",
    "Команды: /escalations · /playbooks · /deal <id>",
  ];
  return lines.join("\n");
}

export type SilentSupplierRow = {
  name: string;
  email: string | null;
  no_reply_streak: number;
  last_rfq_at: string | null;
  silent_note: string | null;
};

export async function fetchSilentSuppliers(
  pool: Pool,
  limit = 15
): Promise<SilentSupplierRow[]> {
  const r = await pool.query(
    `
    SELECT p.name,
           (SELECT pc.email FROM partner_contacts pc
            WHERE pc.partner_id = p.id AND pc.email IS NOT NULL
            ORDER BY pc.created_at LIMIT 1) AS email,
           COALESCE(s.no_reply_streak, 0)::int AS no_reply_streak,
           s.last_rfq_at,
           s.silent_note
    FROM suppliers s
    JOIN partners p ON p.id = s.partner_id
    WHERE s.silent = TRUE
      AND s.active = TRUE
      AND COALESCE(s.left_market, FALSE) = FALSE
    ORDER BY s.last_rfq_at DESC NULLS LAST
    LIMIT $1
    `,
    [limit]
  );
  return r.rows.map((row) => ({
    name: String(row.name || "—"),
    email: row.email ? String(row.email) : null,
    no_reply_streak: Number(row.no_reply_streak ?? 0),
    last_rfq_at: row.last_rfq_at ? String(row.last_rfq_at) : null,
    silent_note: row.silent_note ? String(row.silent_note) : null,
  }));
}

export function formatWeeklySilentReview(
  rows: SilentSupplierRow[],
  when = new Date()
): string {
  const lines = [
    "📋 Еженедельный разбор «не отвечают»",
    formatWhen(when),
    "",
    rows.length
      ? `Всего в списке: ${rows.length} (топ по последнему RFQ)`
      : "Сейчас нет поставщиков в статусе «не отвечают».",
    "",
  ];
  if (rows.length) {
    for (const row of rows) {
      const rfq = row.last_rfq_at
        ? formatWhen(new Date(row.last_rfq_at))
        : "RFQ неизвестен";
      lines.push(
        `• ${row.name}${row.email ? ` (${row.email})` : ""}`,
        `  streak ${row.no_reply_streak} · последний RFQ: ${rfq}`,
        row.silent_note ? `  ${row.silent_note}` : ""
      );
    }
    lines.push("", "Кабинет → Поставщики → вкладка «Не отвечают».");
  }
  return lines.filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1].length > 0)).join("\n");
}

export async function buildWeeklySilentReview(pool: Pool): Promise<string> {
  const rows = await fetchSilentSuppliers(pool, 15);
  return formatWeeklySilentReview(rows);
}
