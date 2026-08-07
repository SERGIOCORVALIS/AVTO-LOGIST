import { Bot, InlineKeyboard } from "grammy";

interface Opts {
  token: string;
  apiBase: string;
  voiceGatewayUrl?: string;
  managerIds: number[];
  onAudit?: (msg: string, meta?: Record<string, unknown>) => void;
  listAccounts?: () => Array<{ id: string; label?: string; manager_user_id?: number }>;
}

function isManager(opts: Opts, userId?: number) {
  if (!opts.managerIds.length) return true;
  return !!userId && opts.managerIds.includes(userId);
}

function audit(opts: Opts, msg: string, meta?: Record<string, unknown>) {
  opts.onAudit?.(msg, meta);
}

export async function startManagementBot(opts: Opts) {
  const bot = new Bot(opts.token);

  bot.command("start", async (ctx) => {
    await ctx.reply(
      [
        "AutoLogistics Management Bot",
        "Полный список: /help",
        "Быстрые: /status /deal /escalations /playbooks /accounts",
      ].join("\n")
    );
  });

  bot.command("help", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return ctx.reply("Access denied");
    await ctx.reply(
      [
        "Команды Management Bot:",
        "/help — это сообщение",
        "/status — сводка сделок и маржи",
        "/policy — текущая политика",
        "/margin <n> — целевая маржа %",
        "/floor <n> — минимальная маржа %",
        "/deal <uuid> — карточка сделки + кнопки",
        "/pause <uuid> — пауза AI",
        "/resume <uuid> — снять паузу",
        "/takeover <uuid> — человек ведёт чат",
        "/call <uuid> — активный звонок и транскрипт",
        "/escalations — pending approve/reject",
        "/playbooks — canary/reject предложений AI",
        "/accounts — Telegram user-аккаунты",
        "/learn_on | /learn_off — самообучение",
        "",
        "Кнопки /deal: Approve KP · Cut −3% · Takeover · Reject",
      ].join("\n")
    );
  });

  bot.command("accounts", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return ctx.reply("Access denied");
    const list = opts.listAccounts?.() || [];
    if (!list.length) return ctx.reply("Нет сконфигурированных TG_ACCOUNTS / TG_STRING_SESSION");
    await ctx.reply(
      list.map((a) => `• ${a.id}${a.label ? ` (${a.label})` : ""} mgr=${a.manager_user_id ?? "—"}`).join("\n")
    );
  });

  bot.command("status", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return ctx.reply("Access denied");
    const res = await fetch(`${opts.apiBase}/stats/summary`);
    const data = await res.json();
    await ctx.reply("```json\n" + JSON.stringify(data, null, 2).slice(0, 3500) + "\n```", {
      parse_mode: "Markdown",
    });
  });

  bot.command("policy", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return ctx.reply("Access denied");
    const res = await fetch(`${opts.apiBase}/policy`);
    const data = await res.json();
    await ctx.reply("```json\n" + JSON.stringify(data, null, 2) + "\n```", {
      parse_mode: "Markdown",
    });
  });

  bot.command("margin", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return ctx.reply("Access denied");
    const val = Number(ctx.match);
    if (!Number.isFinite(val)) return ctx.reply("Usage: /margin 18");
    await fetch(`${opts.apiBase}/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_margin_pct: val }),
    });
    audit(opts, "policy_margin", { target_margin_pct: val, by: ctx.from?.id });
    await ctx.reply(`target_margin_pct = ${val}`);
  });

  bot.command("floor", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return ctx.reply("Access denied");
    const val = Number(ctx.match);
    if (!Number.isFinite(val)) return ctx.reply("Usage: /floor 10");
    await fetch(`${opts.apiBase}/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ floor_margin_pct: val }),
    });
    await ctx.reply(`floor_margin_pct = ${val}`);
  });

  bot.command("learn_on", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return ctx.reply("Access denied");
    await fetch(`${opts.apiBase}/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ learning_enabled: true }),
    });
    await ctx.reply("Learning ON");
  });

  bot.command("learn_off", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return ctx.reply("Access denied");
    await fetch(`${opts.apiBase}/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ learning_enabled: false }),
    });
    await ctx.reply("Learning OFF");
  });

  bot.command("pause", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return ctx.reply("Access denied");
    const dealId = String(ctx.match || "").trim();
    if (!dealId) return ctx.reply("Usage: /pause <deal_id>");
    await fetch(`${opts.apiBase}/deals/${dealId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    await ctx.reply(`Paused ${dealId}`);
  });

  bot.command("resume", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return ctx.reply("Access denied");
    const dealId = String(ctx.match || "").trim();
    if (!dealId) return ctx.reply("Usage: /resume <deal_id>");
    await fetch(`${opts.apiBase}/deals/${dealId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: false, takeover: false }),
    });
    await ctx.reply(`Resumed ${dealId}`);
  });

  bot.command("takeover", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return ctx.reply("Access denied");
    const dealId = String(ctx.match || "").trim();
    if (!dealId) return ctx.reply("Usage: /takeover <deal_id>");
    await fetch(`${opts.apiBase}/deals/${dealId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ takeover: true, paused: true }),
    });
    const voiceBase = opts.voiceGatewayUrl || process.env.VOICE_GATEWAY_URL || "http://localhost:3010";
    try {
      const tr = await fetch(`${voiceBase}/internal/takeover/${dealId}`, { method: "POST" });
      if (tr.ok) {
        await ctx.reply(`Takeover enabled for ${dealId}. Active voice call transferred to manager.`);
        return;
      }
    } catch {
      /* no voice gateway */
    }
    await ctx.reply(`Takeover enabled for ${dealId}. AI replies paused.`);
  });

  bot.command("call", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return ctx.reply("Access denied");
    const dealId = String(ctx.match || "").trim();
    if (!dealId) return ctx.reply("Usage: /call <deal_id>");
    const res = await fetch(`${opts.apiBase}/calls/deal/${dealId}`);
    if (!res.ok) return ctx.reply("Call info not found");
    const data = (await res.json()) as {
      active?: {
        id: string;
        phone: string;
        status: string;
        transcript?: Array<{ role: string; text: string; ts?: string }>;
        started_at?: string;
      } | null;
      recent?: Array<{ id: string; status: string; phone: string; started_at?: string }>;
    };
    const active = data.active;
    if (!active) {
      const recent = (data.recent || [])
        .slice(0, 3)
        .map((c) => `• ${c.status} ${c.phone} ${c.started_at ?? ""}`)
        .join("\n");
      return ctx.reply(`No active call for deal ${dealId}.\nRecent:\n${recent || "—"}`);
    }
    const lines = (active.transcript || []).slice(-6).map((t) => `${t.role}: ${t.text}`);
    await ctx.reply(
      [
        `CALL ${active.id}`,
        `deal: ${dealId}`,
        `phone: ${active.phone}`,
        `status: ${active.status}`,
        "",
        "Transcript (last):",
        lines.join("\n") || "—",
      ].join("\n")
    );
  });

  bot.command("deal", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return ctx.reply("Access denied");
    const dealId = String(ctx.match || "").trim();
    if (!dealId) return ctx.reply("Usage: /deal <deal_id>");
    const res = await fetch(`${opts.apiBase}/deals/${dealId}`);
    if (!res.ok) return ctx.reply("Deal not found");
    const d = (await res.json()) as {
      id: string;
      status: string;
      client_name?: string;
      cargo?: { name?: string };
      route?: { origin_city?: string; destination_city?: string };
      margin_pct?: number;
      amount_rub?: number;
      offer?: { price?: number; currency?: string; eta_days_min?: number; eta_days_max?: number };
      risks?: Array<{ code?: string; severity?: string }>;
      escalate?: boolean;
      takeover?: boolean;
      paused?: boolean;
    };
    const risks = (d.risks || [])
      .slice(0, 3)
      .map((r) => `${r.severity}:${r.code}`)
      .join(", ");
    const text = [
      `DEAL ${d.id}`,
      `status: ${d.status}${d.escalate ? " | ESCALATED" : ""}${d.takeover ? " | TAKEOVER" : ""}${d.paused ? " | PAUSED" : ""}`,
      `client: ${d.client_name || "—"}`,
      `cargo: ${d.cargo?.name || "—"}`,
      `route: ${d.route?.origin_city || "?"} → ${d.route?.destination_city || "?"}`,
      `offer: ${d.offer?.price ?? d.amount_rub ?? "—"} ${d.offer?.currency || "RUB"}`,
      `margin: ${d.margin_pct ?? "—"}%`,
      `eta: ${d.offer?.eta_days_min ?? "?"}–${d.offer?.eta_days_max ?? "?"} d`,
      `risks: ${risks || "—"}`,
    ].join("\n");
    const kb = new InlineKeyboard()
      .text("Approve KP", `deal:approve_kp:${d.id}`)
      .text("Cut −3%", `deal:cut3:${d.id}`)
      .row()
      .text("Takeover", `deal:takeover:${d.id}`)
      .text("Reject", `deal:reject:${d.id}`);
    await ctx.reply(text, { reply_markup: kb });
  });

  bot.callbackQuery(/^deal:(approve_kp|cut3|takeover|reject):(.+)$/, async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return ctx.answerCallbackQuery("Denied");
    const action = ctx.match![1];
    const id = ctx.match![2];
    if (action === "takeover") {
      await fetch(`${opts.apiBase}/deals/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ takeover: true, paused: true }),
      });
      const voiceBase = opts.voiceGatewayUrl || process.env.VOICE_GATEWAY_URL || "http://localhost:3010";
      try {
        await fetch(`${voiceBase}/internal/takeover/${id}`, { method: "POST" });
      } catch {
        /* optional */
      }
      await ctx.answerCallbackQuery("Takeover");
      await ctx.editMessageText((ctx.callbackQuery.message as { text?: string })?.text + "\n→ TAKEOVER");
      return;
    }
    if (action === "reject") {
      await fetch(`${opts.apiBase}/deals/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cancelled", escalate: false }),
      });
      await ctx.answerCallbackQuery("Rejected");
      await ctx.editMessageText(`Deal ${id} cancelled by manager`);
      return;
    }
    if (action === "cut3") {
      const res = await fetch(`${opts.apiBase}/deals/${id}`);
      const d = (await res.json()) as {
        amount_rub?: number;
        offer?: { price?: number; currency?: string };
        cost_breakdown?: { total?: number };
      };
      const price = Number(d.offer?.price || d.amount_rub || 0) * 0.97;
      const cost = Number(d.cost_breakdown?.total || 0);
      const margin = price > 0 ? ((price - cost) / price) * 100 : 0;
      await fetch(`${opts.apiBase}/deals/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount_rub: price,
          margin_pct: margin,
          offer: { ...(d.offer || {}), price, is_estimate: true },
          escalate: false,
          status: "negotiation",
        }),
      });
      await ctx.answerCallbackQuery("Price −3%");
      await ctx.reply(`Deal ${id}: new price ${price.toFixed(0)} (margin ${margin.toFixed(1)}%)`);
      return;
    }
    // approve_kp
    await fetch(`${opts.apiBase}/deals/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        escalate: false,
        status: "contract",
        paused: false,
      }),
    });
    await ctx.answerCallbackQuery("KP approved");
    await ctx.reply(`Deal ${id}: KP approved → contract`);
  });

  bot.command("escalations", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return ctx.reply("Access denied");
    const res = await fetch(`${opts.apiBase}/escalations?status=pending`);
    const rows = (await res.json()) as Array<{
      id: string;
      deal_id: string;
      reason: string;
      summary: string;
    }>;
    if (!rows.length) return ctx.reply("No pending escalations");
    for (const e of rows.slice(0, 10)) {
      const kb = new InlineKeyboard()
        .text("Approve", `esc:approve:${e.id}`)
        .text("Reject", `esc:reject:${e.id}`);
      await ctx.reply(
        `ESC ${e.id}\ndeal ${e.deal_id}\n${e.reason}\n${e.summary}`,
        { reply_markup: kb }
      );
    }
  });

  bot.callbackQuery(/^esc:(approve|reject):(.+)$/, async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return ctx.answerCallbackQuery("Denied");
    const decision = ctx.match![1] === "approve" ? "approved" : "rejected";
    const id = ctx.match![2];
    await fetch(`${opts.apiBase}/escalations/${id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    audit(opts, "escalation_decision", { id, decision, by: ctx.from?.id });
    await ctx.editMessageText(`Escalation ${id} → ${decision}`);
    await ctx.answerCallbackQuery(`Marked ${decision}`);
  });

  bot.command("playbooks", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return ctx.reply("Access denied");
    const res = await fetch(`${opts.apiBase}/playbooks?status=pending_approve`);
    const rows = (await res.json()) as Array<{
      id: string;
      name: string;
      version: string;
      body: unknown;
    }>;
    if (!rows.length) return ctx.reply("No pending playbooks");
    for (const p of rows.slice(0, 10)) {
      const kb = new InlineKeyboard()
        .text("Canary", `pb:canary:${p.id}`)
        .text("Reject", `pb:rejected:${p.id}`);
      await ctx.reply(
        `Playbook ${p.name} ${p.version}\n${JSON.stringify(p.body).slice(0, 500)}`,
        { reply_markup: kb }
      );
    }
  });

  bot.callbackQuery(/^pb:(canary|rejected|active):(.+)$/, async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return ctx.answerCallbackQuery("Denied");
    const decision = ctx.match![1];
    const id = ctx.match![2];
    await fetch(`${opts.apiBase}/playbooks/${id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    await ctx.editMessageText(`Playbook ${id} → ${decision}`);
    await ctx.answerCallbackQuery(`Marked ${decision}`);
  });

  bot.start({
    onStart: () => console.log("[management-bot] polling"),
  });
}
