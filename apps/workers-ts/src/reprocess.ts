/** Cabinet/operator did not return a freight rate — pull partner HTTP/API quotes. */
export async function triggerApiQuoteFallback(opts: {
  dealId: string;
  reason?: string;
}): Promise<{ ok: boolean; status?: number; detail?: string; priced?: boolean }> {
  const api = (process.env.API_URL || "http://localhost:3000").replace(/\/$/, "");
  const orch =
    (process.env.ORCHESTRATOR_URL || "http://localhost:8000").replace(/\/$/, "");
  const token = process.env.INTERNAL_API_TOKEN || "";
  const reason = opts.reason || "cabinet_no_reply";
  const urls = [
    `${orch}/deals/${opts.dealId}/api-quote-fallback`,
    `${api}/orchestrator/deals/${opts.dealId}/api-quote-fallback`,
  ];
  let lastErr = "unreachable";
  for (const url of urls) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) headers["x-internal-token"] = token;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ reason }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        priced?: boolean;
        error?: string;
      };
      if (res.ok) {
        return {
          ok: true,
          status: res.status,
          priced: Boolean(data.priced),
        };
      }
      lastErr = data.error || `http_${res.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, detail: lastErr };
}

export async function triggerDealReprocess(opts: {
  dealId: string;
  idempotencyKey: string;
  reason: string;
}): Promise<{ ok: boolean; status?: number; detail?: string }> {
  const api = (process.env.API_URL || "http://localhost:3000").replace(/\/$/, "");
  const orch =
    (process.env.ORCHESTRATOR_URL || "http://localhost:8000").replace(/\/$/, "");
  const token = process.env.INTERNAL_API_TOKEN || "";

  const payload = {
    deal_id: opts.dealId,
    channel: "email" as const,
    text: `[system] ${opts.reason} — пересчитать КП`,
    idempotency_key: opts.idempotencyKey,
    full_quote: true,
  };

  // Prefer API proxy (same as gateways); fall back to orchestrator direct
  const urls = [`${api}/orchestrator/process`, `${orch}/process`];
  let lastErr = "unreachable";
  for (const url of urls) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) headers["x-internal-token"] = token;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      if (res.ok) return { ok: true, status: res.status };
      lastErr = `http_${res.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, detail: lastErr };
}

export interface OrchestratorProcessResult {
  ok: boolean;
  deal_id?: string;
  replies?: string[];
  status?: number;
  detail?: string;
}

/** Client (or supplier clarification) message → GPT concierge via orchestrator. */
export async function processEmailWithGpt(opts: {
  text: string;
  clientEmail?: string;
  dealId?: string;
  subject?: string;
  idempotencyKey: string;
  fullQuote?: boolean;
}): Promise<OrchestratorProcessResult> {
  const api = (process.env.API_URL || "http://localhost:3000").replace(/\/$/, "");
  const orch =
    (process.env.ORCHESTRATOR_URL || "http://localhost:8000").replace(/\/$/, "");
  const token = process.env.INTERNAL_API_TOKEN || "";

  const bodyText = [
    opts.subject ? `Тема: ${opts.subject}` : null,
    opts.text,
  ]
    .filter(Boolean)
    .join("\n\n");

  const payload: Record<string, unknown> = {
    channel: "email",
    text: bodyText.slice(0, 12000),
    idempotency_key: opts.idempotencyKey,
    full_quote: Boolean(opts.fullQuote),
  };
  if (opts.dealId) payload.deal_id = opts.dealId;
  if (opts.clientEmail) {
    payload.client_email = opts.clientEmail;
    payload.external_id = opts.clientEmail;
  }

  const urls = [`${api}/orchestrator/process`, `${orch}/process`];
  let lastErr = "unreachable";
  for (const url of urls) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) headers["x-internal-token"] = token;
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as {
        deal_id?: string;
        replies?: string[];
        fallback_replies?: string[];
        error?: string;
      };
      if (res.ok) {
        return {
          ok: true,
          status: res.status,
          deal_id: data.deal_id,
          replies: data.replies || data.fallback_replies || [],
        };
      }
      lastErr = data.error || `http_${res.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, detail: lastErr };
}
