import type { Pool } from "pg";

async function googleAccessToken(): Promise<string | null> {
  const clientId =
    process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.MAIL_OAUTH_CLIENT_ID;
  const clientSecret =
    process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.MAIL_OAUTH_CLIENT_SECRET;
  const refresh =
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN || process.env.MAIL_OAUTH_REFRESH_TOKEN;
  const tokenUrl =
    process.env.GOOGLE_OAUTH_TOKEN_URL ||
    process.env.MAIL_OAUTH_TOKEN_URL ||
    "https://oauth2.googleapis.com/token";
  if (!clientId || !clientSecret || !refresh) return null;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refresh,
    grant_type: "refresh_token",
  });
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    console.error("[gcal] token refresh failed", await res.text());
    return null;
  }
  const data = (await res.json()) as { access_token?: string };
  return data.access_token || null;
}

function calendarEnabled(): boolean {
  return (
    process.env.GOOGLE_CALENDAR_ENABLED === "true" &&
    Boolean(process.env.GOOGLE_CALENDAR_ID)
  );
}

async function upsertGoogleEvent(
  token: string,
  calendarId: string,
  event: {
    summary: string;
    description?: string;
    start: string;
    end: string;
    eventId?: string;
  }
): Promise<string | null> {
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const payload = {
    summary: event.summary,
    description: event.description || "",
    start: { dateTime: event.start },
    end: { dateTime: event.end },
  };
  if (event.eventId) {
    const res = await fetch(`${base}/${encodeURIComponent(event.eventId)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error("[gcal] patch failed", await res.text());
      return null;
    }
    const data = (await res.json()) as { id?: string };
    return data.id || event.eventId;
  }
  const res = await fetch(base, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error("[gcal] insert failed", await res.text());
    return null;
  }
  const data = (await res.json()) as { id?: string };
  return data.id || null;
}

async function deleteGoogleEvent(
  token: string,
  calendarId: string,
  eventId: string
): Promise<void> {
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`;
  await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Sync pending calendar_events rows to Google Calendar. Returns count synced. */
export async function syncCalendarEvents(pool: Pool): Promise<number> {
  if (!calendarEnabled()) return 0;
  const token = await googleAccessToken();
  if (!token) return 0;
  const calendarId = process.env.GOOGLE_CALENDAR_ID || "";

  const pending = await pool.query(
    `SELECT id, deal_id, kind, title, due_at, done, metadata
     FROM calendar_events
     WHERE due_at > NOW() - INTERVAL '7 days'
       AND (
         metadata->>'google_event_id' IS NULL
         OR (done = TRUE AND metadata->>'google_cancelled' IS NULL AND metadata->>'google_event_id' IS NOT NULL)
       )
     ORDER BY due_at ASC
     LIMIT 50`
  );

  let n = 0;
  for (const row of pending.rows) {
    const meta = row.metadata || {};
    const existingId = meta.google_event_id as string | undefined;
    if (row.done && existingId) {
      await deleteGoogleEvent(token, calendarId, existingId);
      await pool.query(
        `UPDATE calendar_events
         SET metadata = metadata || '{"google_cancelled":true}'::jsonb
         WHERE id = $1`,
        [row.id]
      );
      n++;
      continue;
    }
    if (row.done) continue;

    const start = new Date(row.due_at);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    const gId = await upsertGoogleEvent(token, calendarId, {
      summary: row.title,
      description: `ALO ${row.kind} deal=${row.deal_id || "-"}`,
      start: start.toISOString(),
      end: end.toISOString(),
      eventId: existingId,
    });
    if (!gId) continue;
    await pool.query(
      `UPDATE calendar_events
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
       WHERE id = $1`,
      [row.id, JSON.stringify({ google_event_id: gId, google_synced_at: new Date().toISOString() })]
    );
    n++;
  }
  return n;
}
