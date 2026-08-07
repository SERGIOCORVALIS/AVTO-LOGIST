import type { FastifyInstance } from "fastify";
import { pool } from "../db";

function icsEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function toIcsDate(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function registerCalendarRoutes(app: FastifyInstance) {
  app.get("/calendar/export.ics", async (_req, reply) => {
    const r = await pool.query(
      `SELECT id, deal_id, kind, title, due_at, done
       FROM calendar_events
       WHERE done = FALSE AND due_at > NOW() - INTERVAL '1 day'
       ORDER BY due_at ASC
       LIMIT 200`
    );
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//AutoLogistics OS//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
    ];
    for (const row of r.rows) {
      const start = new Date(row.due_at);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      lines.push(
        "BEGIN:VEVENT",
        `UID:${row.id}@alo`,
        `DTSTAMP:${toIcsDate(new Date())}`,
        `DTSTART:${toIcsDate(start)}`,
        `DTEND:${toIcsDate(end)}`,
        `SUMMARY:${icsEscape(row.title || row.kind)}`,
        `DESCRIPTION:${icsEscape(`deal=${row.deal_id || "-"} kind=${row.kind}`)}`,
        "END:VEVENT"
      );
    }
    lines.push("END:VCALENDAR");
    return reply
      .header("Content-Type", "text/calendar; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="alo-sla.ics"')
      .send(lines.join("\r\n"));
  });
}
