/** Trigger orchestrator re-quote after OCR / IMAP updates. */

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
