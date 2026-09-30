import { Bot, InlineKeyboard, type Context } from "grammy";
import {
  dealSnippetFromRow,
  formatDealCardStaff,
  formatEscalationStaff,
  grammyProxyFetch,
} from "@alo/shared";
import {
  parseOpsHint,
  pickOpenDealsForOpsHint,
  safeOpsRerunRfq,
  shouldHandleStaffPeer,
  staffPeerClarify,
  staffPeerHelpText,
  staffTrainingKind,
  type OpsHintPatch,
  type StaffPeerRequest,
} from "./staffPeer";
import { resolveStaffPeerRequest } from "./staffPeerGpt";
import {
  dispatchStaffGroup,
  rememberStaffOutbound,
  sameStaffChat,
  setStaffGroupDispatcher,
  type StaffGroupInbound,
} from "./staffListen";
import { composeInboundText, transcribeAudio } from "./media";
import {
  ensureStaffTopics,
  resolveTopicKindByThreadId,
  threadIdForReply,
} from "./staffTopics";
import { runStaffHistoryIngest, staffHistoryMarkerInfo } from "./staffHistoryIngest";
import type { TelegramClient } from "telegram";

/** Latest GramJS client for /staff_sync (set from userClient). */
let staffUserClient: TelegramClient | null = null;

export function setStaffUserClient(client: TelegramClient | null): void {
  staffUserClient = client;
}

export function getStaffUserClient(): TelegramClient | null {
  return staffUserClient;
}

interface Opts {
  token: string;
  apiBase: string;
  voiceGatewayUrl?: string;
  managerIds: number[];
  onAudit?: (msg: string, meta?: Record<string, unknown>) => void;
  listAccounts?: () => Array<{ id: string; label?: string; manager_user_id?: number }>;
}

type StaffReplyExtra = {
  reply_markup?: InlineKeyboard;
  message_thread_id?: number;
  reply_to_message_id?: number;
};

type StaffReply = (text: string, extra?: StaffReplyExtra) => Promise<void>;

type StaffPeerCtx = {
  fromId?: number;
  chatId: number;
  text: string;
  replyText?: string;
  messageThreadId?: number;
  replyToMessageId?: number;
  messageId?: number;
  reply: StaffReply;
};

let managementBotRef: Bot | null = null;

export function getManagementBot(): Bot | null {
  return managementBotRef;
}

function ctxThreadExtra(ctx: Context): { message_thread_id?: number } {
  const tid = ctx.message?.message_thread_id;
  return tid && tid > 0 ? { message_thread_id: tid } : {};
}

function isManager(opts: Opts, userId?: number) {
  if (!opts.managerIds.length) return true;
  return !!userId && opts.managerIds.includes(userId);
}

/** In staff room every human is a coach/voice (listen + train). */
function canStaffTalk(opts: Opts, chatId: number, userId?: number): boolean {
  const esc = Number(
    String(process.env.TG_STAFF_CHAT_ID || process.env.TG_ESCALATION_CHAT_ID || "").trim()
  );
  if (Number.isFinite(esc) && esc !== 0 && sameStaffChat(chatId, esc)) return true;
  return isManager(opts, userId);
}

function audit(opts: Opts, msg: string, meta?: Record<string, unknown>) {
  opts.onAudit?.(msg, meta);
}

function denied(ctx: Context) {
  return ctx.reply("Нет доступа. Добавьте ваш Telegram id в TG_MANAGER_IDS.");
}

function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = (process.env.INTERNAL_API_TOKEN || "").trim();
  const headers = new Headers(init?.headers);
  if (token && !headers.has("x-internal-token")) {
    headers.set("x-internal-token", token);
  }
  return fetch(url, { ...init, headers });
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await apiFetch(url, init);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function resolveDealId(
  apiBase: string,
  req: StaffPeerRequest
): Promise<string | undefined> {
  if (req.dealId && req.dealId.includes("-")) return req.dealId;
  if (req.dealId && req.dealId.length >= 8) {
    const rows =
      (await fetchJson<Array<{ id: string }>>(
        `${apiBase}/deals?q=${encodeURIComponent(req.dealId)}&limit=5`
      )) || [];
    const hit = rows.find((r) => String(r.id).startsWith(req.dealId!));
    if (hit) return hit.id;
  }
  if (req.query) {
    const rows =
      (await fetchJson<Array<{ id: string }>>(
        `${apiBase}/deals?q=${encodeURIComponent(req.query)}&limit=5`
      )) || [];
    if (rows.length === 1) return rows[0].id;
  }
  return req.dealId;
}

async function applyOpsHintToDeal(
  opts: Opts,
  peer: StaffPeerCtx,
  dealId: string,
  patch: OpsHintPatch,
  _rawText: string,
  flags?: { silent?: boolean }
): Promise<void> {
  const deal = await fetchJson<{
    id: string;
    cargo?: Record<string, unknown>;
    route?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }>(`${opts.apiBase}/deals/${dealId}`);
  if (!deal) {
    if (!flags?.silent) await peer.reply("Сделку не нашла — подсказку не применила.");
    return;
  }
  const nextRoute = { ...(deal.route || {}), ...(patch.route || {}) };
  const nextMeta: Record<string, unknown> = {
    ...(deal.metadata || {}),
    ...(patch.metadata || {}),
    staff_ops_hint_at: new Date().toISOString(),
  };
  const nextCargo = { ...(deal.cargo || {}) };
  if (typeof nextMeta.staff_cargo_name === "string" && nextMeta.staff_cargo_name.trim()) {
    nextCargo.name = String(nextMeta.staff_cargo_name).trim();
    nextCargo.description = [
      String(nextMeta.staff_cargo_name).trim(),
      nextMeta.consignee ? `получатель ${nextMeta.consignee}` : "",
    ]
      .filter(Boolean)
      .join(", ");
  }
  const weightVariants = Array.isArray(nextMeta.staff_weight_kg_variants)
    ? (nextMeta.staff_weight_kg_variants as number[]).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  if (weightVariants.length === 1) {
    nextCargo.weight_kg = weightVariants[0];
  } else if (weightVariants.length >= 2) {
    // Two Vladivostok cards: map by consignee order / existing weight if any.
    const consignee = String(nextMeta.consignee || "").toLowerCase();
    if (consignee.includes("помощник")) nextCargo.weight_kg = weightVariants[1] || weightVariants[0];
    else if (consignee.includes("прогресс")) nextCargo.weight_kg = weightVariants[0];
    else nextCargo.weight_kg = weightVariants[0];
  }
  if (nextCargo.cargo_class == null && /контейнер|40|20/i.test(String(nextCargo.name || ""))) {
    nextCargo.cargo_class = "container";
  }

  const holdRfq = Boolean(nextMeta.hold_rfq || nextMeta.consult_manager);
  const managerGate = Boolean(
    nextMeta.manager_gate || nextMeta.require_manager_approve || holdRfq
  );
  const wantRerun = safeOpsRerunRfq({ ...patch, metadata: nextMeta }, _rawText);

  await apiFetch(`${opts.apiBase}/deals/${dealId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      route: nextRoute,
      cargo: nextCargo,
      metadata: nextMeta,
      status: "quoting",
      paused: managerGate ? true : false,
    }),
  });

  const orch = process.env.ORCHESTRATOR_URL || "http://localhost:8000";
  let rfqNote = "карточку обновила";
  const allow = Array.isArray(nextMeta.staff_rfq_emails)
    ? (nextMeta.staff_rfq_emails as string[])
    : [];

  if (holdRfq && !wantRerun) {
    rfqNote = allow.length
      ? `RFQ на паузе. Почты: ${allow.join(", ")}. Напиши «отправляй» — вышлю`
      : "RFQ на паузе — жду текст/почты или «отправляй»";
  } else {
    try {
      const res = await fetch(`${orch.replace(/\/$/, "")}/deals/${dealId}/apply-ops-hint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          route: nextRoute,
          cargo: nextCargo,
          metadata: { ...nextMeta, paused_keep: managerGate },
          rerun_rfq: wantRerun,
        }),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { rfq_sent?: number };
        rfqNote =
          body.rfq_sent != null
            ? `RFQ отправлен (${body.rfq_sent})`
            : "карточку обновила";
      } else {
        rfqNote = "карточку обновила; RFQ — вручную";
      }
    } catch {
      rfqNote = "карточку обновила; оркестратор недоступен для RFQ";
    }
  }

  if (!flags?.silent) {
    await peer.reply(
      [
        `Приняла подсказку по ${dealId.slice(0, 8)}…`,
        patch.summary || "схема/маршрут/почты",
        rfqNote + ".",
      ].join("\n")
    );
  }
}

async function replyDealCard(reply: StaffReply, apiBase: string, dealId: string): Promise<void> {
  const d = await fetchJson<
    Record<string, unknown> & {
      id: string;
      amount_rub?: number;
      offer?: { price?: number; currency?: string; eta_days_min?: number; eta_days_max?: number };
      risks?: Array<{ code?: string; severity?: string }>;
      escalate?: boolean;
      takeover?: boolean;
      paused?: boolean;
    }
  >(`${apiBase}/deals/${dealId}`);
  if (!d) {
    await reply(`Сделку ${dealId} не нашла. Проверь uuid или имя клиента.`);
    return;
  }
  const flags = [
    d.escalate ? "эскалация" : "",
    d.takeover ? "человек ведёт" : "",
    d.paused ? "пауза ИИ" : "",
  ].filter(Boolean);
  const risks = (d.risks || [])
    .slice(0, 3)
    .map((r) => `${r.severity || "?"}:${r.code || "?"}`);
  const text = formatDealCardStaff({
    deal: dealSnippetFromRow(d),
    offerPrice: d.offer?.price ?? d.amount_rub,
    currency: d.offer?.currency,
    etaMin: d.offer?.eta_days_min,
    etaMax: d.offer?.eta_days_max,
    flags,
    risks,
  });
  const kb = new InlineKeyboard()
    .text("Утвердить КП", `deal:approve_kp:${d.id}`)
    .text("Скидка −3%", `deal:cut3:${d.id}`)
    .row()
    .text("Перехватить", `deal:takeover:${d.id}`)
    .text("Отклонить", `deal:reject:${d.id}`);
  await reply(text, { reply_markup: kb });
}

async function handleStaffPeer(opts: Opts, peer: StaffPeerCtx): Promise<void> {
  if (!canStaffTalk(opts, peer.chatId, peer.fromId)) {
    await peer.reply("Нет доступа. Добавьте ваш Telegram id в TG_MANAGER_IDS.");
    return;
  }
  const text = peer.text;
  const replyText = peer.replyText;
  const req = await resolveStaffPeerRequest(text, { replyText });
  let dealId = await resolveDealId(opts.apiBase, req);
  audit(opts, "staff_peer", {
    intent: req.intent,
    dealId,
    source: req.source,
    by: peer.fromId,
    chat: peer.chatId,
  });

  // Managers talking among themselves — learn silently, don't clutter the room.
  if (req.intent === "observe") {
    return;
  }
  if (req.intent === "answer") {
    // Soft coaching: attach as staff_ops_hint on a deal when uuid/reply known.
    const soft = parseOpsHint(text);
    if (soft && dealId) {
      soft.rerun_rfq = false;
      await applyOpsHintToDeal(opts, peer, dealId, soft, text, { silent: true });
      await peer.reply(
        req.colleague_reply ||
          `Поняла, учту по ${dealId.slice(0, 8)}…`
      );
      return;
    }
    await peer.reply(
      req.colleague_reply ||
        "Поняла. Если нужно применить к сделке — кинь uuid или ответь на алерт."
    );
    return;
  }

  if (req.intent === "help") {
    await peer.reply(staffPeerHelpText());
    return;
  }
  if (req.intent === "status") {
    const data = await fetchJson<{
      pending_escalations?: number;
      robot?: {
        awaiting_manager?: number;
        takeover?: number;
        open_deals?: number;
        paused?: number;
      };
    }>(`${opts.apiBase}/stats/summary`);
    if (!data) {
      await peer.reply("Сводку сейчас не достала — API не ответил. Попробуй /status чуть позже.");
      return;
    }
    const r = data.robot || {};
    await peer.reply(
      [
        "Сводка на сейчас:",
        `• открытых сделок: ${r.open_deals ?? "—"}`,
        `• ждут менеджера: ${r.awaiting_manager ?? 0}`,
        `• на takeover: ${r.takeover ?? 0}`,
        `• на паузе ИИ: ${r.paused ?? 0}`,
        `• открытых эскалаций: ${data.pending_escalations ?? 0}`,
        "",
        "Детали JSON: /status · список: «эскалации»",
      ].join("\n")
    );
    return;
  }
  if (req.intent === "escalations") {
    const rows =
      (await fetchJson<
        Array<{
          id: string;
          deal_id: string;
          reason: string;
          summary: string;
          needed_decision?: string;
        }>
      >(`${opts.apiBase}/escalations?status=pending`)) || [];
    if (!rows.length) {
      await peer.reply("Открытых эскалаций нет — чисто.");
      return;
    }
    await peer.reply(
      `Открытых эскалаций: ${rows.length}. Кидаю первые ${Math.min(rows.length, 5)}.`
    );
    for (const e of rows.slice(0, 5)) {
      const kb = new InlineKeyboard()
        .text("Согласовать", `esc:approve:${e.id}`)
        .text("Отклонить", `esc:reject:${e.id}`);
      await peer.reply(
        formatEscalationStaff({
          dealId: e.deal_id,
          reason: e.reason,
          summary: e.summary,
          neededDecision: e.needed_decision,
          deal: { id: e.deal_id },
          extra: [`ID эскалации: ${e.id}`],
        }),
        { reply_markup: kb }
      );
    }
    return;
  }
  if (req.intent === "awaiting") {
    const rows =
      (await fetchJson<Array<Record<string, unknown>>>(
        `${opts.apiBase}/deals?status=awaiting_manager&limit=10`
      )) || [];
    if (!rows.length) {
      await peer.reply("Сделок в статусе «ждёт менеджера» нет.");
      return;
    }
    const lines = rows.slice(0, 8).map((d) => {
      const sn = dealSnippetFromRow(d);
      return `• ${sn.id?.slice(0, 8)}… ${sn.client_name || "—"} · ${sn.origin || "?"}→${sn.destination || "?"}`;
    });
    await peer.reply(["Ждут менеджера:", ...lines, "", "Открой: «карточка <uuid>»"].join("\n"));
    return;
  }

  if (
    ["approve_kp", "reject_deal", "takeover", "pause", "resume", "cut3", "deal_card", "ops_hint", "set_active", "approve_rfq"].includes(
      req.intent
    )
  ) {
    if (!dealId) {
      if (req.intent === "ops_hint" && req.opsPatch) {
        // Try open quoting deal matching destination from hint
        const dest = req.opsPatch.route?.destination_city;
        const q = dest || req.opsPatch.summary || req.raw.slice(0, 80) || "";
        if (q) {
          const rows =
            (await fetchJson<Array<Record<string, unknown>>>(
              `${opts.apiBase}/deals?q=${encodeURIComponent(
                String(dest || q).slice(0, 80)
              )}&limit=10`
            )) || [];
          const mapped = rows.map((d) => ({
            id: String(d.id),
            status: String(d.status || ""),
            route: (d.route || {}) as Record<string, unknown>,
            client_name: String(
              (d as { client_name?: string }).client_name ||
                ((d.metadata || {}) as { client_name?: string }).client_name ||
                ""
            ),
          }));
          const picked = pickOpenDealsForOpsHint({
            pool: mapped,
            patch: req.opsPatch,
            preferDestination: dest,
          });
          if (picked.dealIds.length === 1) {
            dealId = picked.dealIds[0];
          } else if (picked.dealIds.length > 1) {
            const idSet = new Set(picked.dealIds);
            const pool = mapped.filter((d) => idSet.has(d.id));
            const lines = pool.map((d) => {
              const sn = dealSnippetFromRow(
                rows.find((r) => String(r.id) === d.id) || { id: d.id, route: d.route }
              );
              const who = sn.consignee ? ` · ${sn.consignee}` : "";
              return `• ${String(sn.id).slice(0, 8)}… ${sn.client_name || "—"}${who} · ${sn.origin || "?"}→${sn.destination || "?"}`;
            });
            await peer.reply(
              [
                `Подсказку приняла на ${picked.dealIds.length} открытых заказа:`,
                ...lines,
                "Применяю по очереди — каждая карточка отдельный заказ.",
              ].join("\n")
            );
            for (const id of picked.dealIds) {
              await applyOpsHintToDeal(opts, peer, id, req.opsPatch, text, { silent: true });
            }
            await peer.reply("Готово по всем карточкам.");
            return;
          } else if (picked.ambiguous.length > 1) {
            const lines = picked.ambiguous.slice(0, 8).map((d) => {
              const sn = dealSnippetFromRow(
                rows.find((r) => String(r.id) === d.id) || { id: d.id, route: d.route }
              );
              const who = sn.consignee ? ` · ${sn.consignee}` : "";
              return `• ${sn.id} · ${sn.client_name || "—"}${who} · ${sn.origin || "?"}→${sn.destination || "?"}`;
            });
            await peer.reply(
              [
                "Подсказку поняла. Укажи сделку (uuid / получатель) или ответь на алерт:",
                ...lines,
              ].join("\n")
            );
            return;
          }
        }
        // Fallback: single open quoting/intake deal
        if (!dealId) {
          const openRows =
            (await fetchJson<Array<Record<string, unknown>>>(
              `${opts.apiBase}/deals?status=quoting&limit=5`
            )) || [];
          const intake =
            (await fetchJson<Array<Record<string, unknown>>>(
              `${opts.apiBase}/deals?status=intake&limit=5`
            )) || [];
          const merged = [...openRows, ...intake];
          const mapped = merged.map((d) => ({
            id: String(d.id),
            status: String(d.status || ""),
            route: (d.route || {}) as Record<string, unknown>,
          }));
          const picked = pickOpenDealsForOpsHint({
            pool: mapped,
            patch: req.opsPatch,
          });
          if (picked.dealIds.length === 1) {
            dealId = picked.dealIds[0];
          } else if (picked.dealIds.length > 1) {
            for (const id of picked.dealIds) {
              await applyOpsHintToDeal(opts, peer, id, req.opsPatch, text, { silent: true });
            }
            await peer.reply(`Готово по ${picked.dealIds.length} карточкам.`);
            return;
          } else if (picked.ambiguous.length > 1) {
            const uniq = new Map(picked.ambiguous.map((d) => [d.id, d]));
            const lines = [...uniq.values()].slice(0, 8).map((d) => {
              const sn = dealSnippetFromRow(
                merged.find((r) => String(r.id) === d.id) || { id: d.id, route: d.route }
              );
              const who = sn.consignee ? ` · ${sn.consignee}` : "";
              return `• ${sn.id} · ${sn.client_name || "—"}${who} · ${sn.origin || "?"}→${sn.destination || "?"}`;
            });
            await peer.reply(
              [
                "Подсказку поняла. Укажи сделку (uuid / получатель) или ответь на алерт:",
                ...lines,
              ].join("\n")
            );
            return;
          }
        }
        if (!dealId) {
          await peer.reply(staffPeerClarify(req));
          return;
        }
      } else if (req.intent === "deal_card" && req.query) {
        const rows =
          (await fetchJson<Array<Record<string, unknown>>>(
            `${opts.apiBase}/deals?q=${encodeURIComponent(req.query)}&limit=8`
          )) || [];
        const open = rows.filter(
          (d) =>
            !["closed_won", "closed_lost", "cancelled"].includes(String(d.status || ""))
        );
        const pool = open.length ? open : rows;
        if (!pool.length) {
          await peer.reply(`По «${req.query}» сделок не нашла. Уточни имя или uuid.`);
          return;
        }
        if (pool.length > 1) {
          const lines = pool.map((d) => {
            const sn = dealSnippetFromRow(d);
            const who = sn.consignee ? ` · ${sn.consignee}` : "";
            return `• ${sn.id} · ${sn.client_name || "—"}${who} · ${sn.origin || "?"}→${sn.destination || "?"} · ${sn.status || "?"}`;
          });
          await peer.reply(
            ["Нашла несколько заказов (не дубликаты). Укажи uuid или получателя:", ...lines].join(
              "\n"
            )
          );
          return;
        }
        await replyDealCard(peer.reply, opts.apiBase, String(pool[0].id));
        return;
      } else {
        await peer.reply(staffPeerClarify(req));
        return;
      }
    }

    if (!dealId) {
      await peer.reply(staffPeerClarify(req));
      return;
    }

    if (req.intent === "set_active") {
      const orch = process.env.ORCHESTRATOR_URL || "http://localhost:8000";
      try {
        const res = await fetch(
          `${orch.replace(/\/$/, "")}/deals/${dealId}/set-active`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }
        );
        if (!res.ok) {
          await peer.reply(`Не смогла закрепить ${dealId.slice(0, 8)}… — оркестратор ${res.status}.`);
          return;
        }
      } catch {
        await peer.reply("Оркестратор недоступен — активную сделку не закрепила.");
        return;
      }
      await peer.reply(
        `Ок, активная карточка для чата клиента — ${dealId.slice(0, 8)}… Входящие пойдут сюда.`
      );
      return;
    }
    if (req.intent === "approve_rfq") {
      // Clear hold and send using staff allowlist / corrected body if present.
      const deal = await fetchJson<{
        id: string;
        cargo?: Record<string, unknown>;
        route?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
      }>(`${opts.apiBase}/deals/${dealId}`);
      const meta = {
        ...(deal?.metadata || {}),
        hold_rfq: false,
        consult_manager: false,
        require_manager_approve: false,
      };
      await applyOpsHintToDeal(
        opts,
        peer,
        dealId,
        {
          route: deal?.route as Record<string, string | undefined> | undefined,
          metadata: meta,
          summary: "одобрен RFQ менеджером",
          rerun_rfq: true,
        },
        text
      );
      return;
    }
    if (req.intent === "ops_hint") {
      const patch = req.opsPatch || parseOpsHint(req.raw);
      if (!patch) {
        await peer.reply("Похоже на подсказку, но не разобрала схему/города — уточни.");
        return;
      }
      await applyOpsHintToDeal(opts, peer, dealId, patch, text);
      return;
    }
    if (req.intent === "deal_card") {
      await replyDealCard(peer.reply, opts.apiBase, dealId);
      return;
    }
    if (req.intent === "approve_kp") {
      const res = await apiFetch(`${opts.apiBase}/deals/${dealId}/approve-kp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = (await res.json().catch(() => ({}))) as { mode?: string; sent?: number };
      if (body.mode === "release_to_client") {
        await peer.reply(
          `Ок, КП по ${dealId.slice(0, 8)}… утвердила — клиенту ушла цена` +
            (body.sent ? ` (${body.sent} сообщ.)` : "") +
            "."
        );
      } else {
        await peer.reply(`Ок, КП по ${dealId.slice(0, 8)}… утвердила → договор.`);
      }
      return;
    }
    if (req.intent === "reject_deal") {
      await apiFetch(`${opts.apiBase}/deals/${dealId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cancelled", escalate: false }),
      });
      await peer.reply(`Сделку ${dealId.slice(0, 8)}… отменила.`);
      return;
    }
    if (req.intent === "takeover") {
      await apiFetch(`${opts.apiBase}/deals/${dealId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ takeover: true, paused: true }),
      });
      const voiceBase =
        opts.voiceGatewayUrl || process.env.VOICE_GATEWAY_URL || "http://localhost:3010";
      try {
        await fetch(`${voiceBase}/internal/takeover/${dealId}`, { method: "POST" });
      } catch {
        /* optional */
      }
      await peer.reply(`Перехват включён на ${dealId.slice(0, 8)}… — ИИ молчит, ведёшь ты.`);
      return;
    }
    if (req.intent === "pause") {
      await apiFetch(`${opts.apiBase}/deals/${dealId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: true }),
      });
      await peer.reply(`Пауза ИИ на ${dealId.slice(0, 8)}…`);
      return;
    }
    if (req.intent === "resume") {
      await apiFetch(`${opts.apiBase}/deals/${dealId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: false, takeover: false }),
      });
      await peer.reply(`Сняла паузу на ${dealId.slice(0, 8)}… — бот снова в деле.`);
      return;
    }
    if (req.intent === "cut3") {
      const d = await fetchJson<{
        amount_rub?: number;
        offer?: { price?: number; currency?: string };
        cost_breakdown?: { total?: number };
      }>(`${opts.apiBase}/deals/${dealId}`);
      if (!d) {
        await peer.reply("Сделку не нашла — скидку не применила.");
        return;
      }
      const price = Number(d.offer?.price || d.amount_rub || 0) * 0.97;
      const cost = Number(d.cost_breakdown?.total || 0);
      const margin = price > 0 ? ((price - cost) / price) * 100 : 0;
      await apiFetch(`${opts.apiBase}/deals/${dealId}`, {
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
      await peer.reply(
        `Минус 3%: ${price.toFixed(0)} ₽, маржа ~${margin.toFixed(1)}% по ${dealId.slice(0, 8)}…`
      );
      return;
    }
  }

  if (req.colleague_reply) {
    await peer.reply(req.colleague_reply);
    return;
  }
  await peer.reply(staffPeerClarify(req));
}

export async function startManagementBot(opts: Opts) {
  const fetchFn = grammyProxyFetch();
  const bot = new Bot(opts.token, fetchFn ? { client: { fetch: fetchFn } } : {});
  managementBotRef = bot;

  // All ctx.reply in staff forum keep the same topic thread.
  bot.use(async (ctx, next) => {
    const orig = ctx.reply.bind(ctx);
    ctx.reply = ((text: string, other?: Parameters<typeof ctx.reply>[1]) => {
      const thread = ctxThreadExtra(ctx);
      const merged =
        other && typeof other === "object"
          ? { ...thread, ...other }
          : Object.keys(thread).length
            ? thread
            : other;
      return orig(text, merged as never);
    }) as typeof ctx.reply;
    await next();
  });

  void ensureStaffTopics({ bot, client: null }).catch((err) =>
    console.warn("[management-bot] ensureStaffTopics", err)
  );

  bot.command("start", async (ctx) => {
    await ctx.reply(
      [
        "Рабочая группа TRANSINVEST — слушаю менеджеров, учусь и помогаю по сделкам.",
        "Темы: Общее · Эскалации · RFQ · Обучение",
        staffPeerHelpText(),
      ].join("\n\n"),
      ctxThreadExtra(ctx)
    );
  });

  bot.command("help", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return denied(ctx);
    await ctx.reply(
      [
        staffPeerHelpText(),
        "",
        "Слэш-команды:",
        "/status — сводка",
        "/policy /margin /floor — коммерция",
        "/deal <uuid> — карточка + кнопки",
        "/pause /resume /takeover <uuid>",
        "/escalations /playbooks /accounts /call",
        "/staff_sync — перечитать историю всех тем",
        "/learn_on | /learn_off",
      ].join("\n"),
      ctxThreadExtra(ctx)
    );
  });

  bot.command("staff_sync", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return denied(ctx);
    const client = getStaffUserClient();
    if (!client) {
      await ctx.reply(
        "User-сессия ещё не подключена — /staff_sync недоступен. Проверьте TG_STRING_SESSION.",
        ctxThreadExtra(ctx)
      );
      return;
    }
    await ctx.reply(
      `Читаю историю тем (лимит ${process.env.TG_STAFF_HISTORY_LIMIT || 300})… Последний boot-ingest: ${staffHistoryMarkerInfo()}`,
      ctxThreadExtra(ctx)
    );
    try {
      await ensureStaffTopics({ bot, client });
      const stats = await runStaffHistoryIngest({
        client,
        apiBase: opts.apiBase,
        force: true,
        bot,
      });
      await ctx.reply(
        `Готово: тем ${stats.topics}, просмотрено ${stats.scanned}, в learning ${stats.logged}, пропуск ${stats.skipped}.`,
        ctxThreadExtra(ctx)
      );
    } catch (err) {
      console.error("[management-bot] staff_sync failed", err);
      await ctx.reply(
        "Сбой sync — смотри логи gateway.",
        ctxThreadExtra(ctx)
      );
    }
  });

  bot.command("accounts", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return denied(ctx);    const list = opts.listAccounts?.() || [];
    if (!list.length) return ctx.reply("Нет сконфигурированных TG_ACCOUNTS / TG_STRING_SESSION");
    await ctx.reply(
      list.map((a) => `• ${a.id}${a.label ? ` (${a.label})` : ""} mgr=${a.manager_user_id ?? "—"}`).join("\n")
    );
  });

  bot.command("status", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return denied(ctx);
    const res = await apiFetch(`${opts.apiBase}/stats/summary`);
    const data = await res.json();
    await ctx.reply("```json\n" + JSON.stringify(data, null, 2).slice(0, 3500) + "\n```", {
      parse_mode: "Markdown",
    });
  });

  bot.command("policy", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return denied(ctx);
    const res = await apiFetch(`${opts.apiBase}/policy`);
    const data = await res.json();
    await ctx.reply("```json\n" + JSON.stringify(data, null, 2) + "\n```", {
      parse_mode: "Markdown",
    });
  });

  bot.command("margin", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return denied(ctx);
    const val = Number(ctx.match);
    if (!Number.isFinite(val)) return ctx.reply("Usage: /margin 18");
    await apiFetch(`${opts.apiBase}/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_margin_pct: val }),
    });
    audit(opts, "policy_margin", { target_margin_pct: val, by: ctx.from?.id });
    await ctx.reply(`target_margin_pct = ${val}`);
  });

  bot.command("floor", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return denied(ctx);
    const val = Number(ctx.match);
    if (!Number.isFinite(val)) return ctx.reply("Usage: /floor 10");
    await apiFetch(`${opts.apiBase}/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ floor_margin_pct: val }),
    });
    await ctx.reply(`floor_margin_pct = ${val}`);
  });

  bot.command("learn_on", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return denied(ctx);
    await apiFetch(`${opts.apiBase}/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ learning_enabled: true }),
    });
    await ctx.reply("Learning ON");
  });

  bot.command("learn_off", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return denied(ctx);
    await apiFetch(`${opts.apiBase}/policy`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ learning_enabled: false }),
    });
    await ctx.reply("Learning OFF");
  });

  bot.command("pause", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return denied(ctx);
    const dealId = String(ctx.match || "").trim();
    if (!dealId) return ctx.reply("Usage: /pause <deal_id>");
    await apiFetch(`${opts.apiBase}/deals/${dealId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    await ctx.reply(`Paused ${dealId}`);
  });

  bot.command("resume", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return denied(ctx);
    const dealId = String(ctx.match || "").trim();
    if (!dealId) return ctx.reply("Usage: /resume <deal_id>");
    await apiFetch(`${opts.apiBase}/deals/${dealId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: false, takeover: false }),
    });
    await ctx.reply(`Resumed ${dealId}`);
  });

  bot.command("takeover", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return denied(ctx);
    const dealId = String(ctx.match || "").trim();
    if (!dealId) return ctx.reply("Usage: /takeover <deal_id>");
    await apiFetch(`${opts.apiBase}/deals/${dealId}`, {
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
    if (!isManager(opts, ctx.from?.id)) return denied(ctx);
    const dealId = String(ctx.match || "").trim();
    if (!dealId) return ctx.reply("Usage: /call <deal_id>");
    const res = await apiFetch(`${opts.apiBase}/calls/deal/${dealId}`);
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
    if (!isManager(opts, ctx.from?.id)) return denied(ctx);
    const dealId = String(ctx.match || "").trim();
    if (!dealId) return ctx.reply("Использование: /deal <uuid>");
    await replyDealCard(async (t, e) => {
      await ctx.reply(t, e);
    }, opts.apiBase, dealId);
  });

  bot.callbackQuery(/^deal:(approve_kp|cut3|takeover|reject):(.+)$/, async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return ctx.answerCallbackQuery("Нет доступа");
    const action = ctx.match![1];
    const id = ctx.match![2];
    if (action === "takeover") {
      await apiFetch(`${opts.apiBase}/deals/${id}`, {
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
      await apiFetch(`${opts.apiBase}/deals/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cancelled", escalate: false }),
      });
      await ctx.answerCallbackQuery("Rejected");
      await ctx.editMessageText(`Deal ${id} cancelled by manager`);
      return;
    }
    if (action === "cut3") {
      const res = await apiFetch(`${opts.apiBase}/deals/${id}`);
      const d = (await res.json()) as {
        amount_rub?: number;
        offer?: { price?: number; currency?: string };
        cost_breakdown?: { total?: number };
      };
      const price = Number(d.offer?.price || d.amount_rub || 0) * 0.97;
      const cost = Number(d.cost_breakdown?.total || 0);
      const margin = price > 0 ? ((price - cost) / price) * 100 : 0;
      await apiFetch(`${opts.apiBase}/deals/${id}`, {
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
    const res = await apiFetch(`${opts.apiBase}/deals/${id}/approve-kp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = (await res.json().catch(() => ({}))) as { mode?: string };
    await ctx.answerCallbackQuery(
      body.mode === "release_to_client" ? "КП → клиенту" : "КП → договор"
    );
    await ctx.editMessageText(
      ((ctx.callbackQuery.message as { text?: string })?.text || `Deal ${id}`) +
        (body.mode === "release_to_client" ? "\n→ KP RELEASED TO CLIENT" : "\n→ CONTRACT")
    );
    return;
  });

  bot.command("escalations", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return denied(ctx);
    const res = await apiFetch(`${opts.apiBase}/escalations?status=pending`);
    const rows = (await res.json()) as Array<{
      id: string;
      deal_id: string;
      reason: string;
      summary: string;
      needed_decision?: string;
    }>;
    if (!rows.length) return ctx.reply("Нет открытых эскалаций");
    for (const e of rows.slice(0, 10)) {
      const kb = new InlineKeyboard()
        .text("Согласовать", `esc:approve:${e.id}`)
        .text("Отклонить", `esc:reject:${e.id}`);
      await ctx.reply(
        formatEscalationStaff({
          dealId: e.deal_id,
          reason: e.reason,
          summary: e.summary,
          neededDecision: e.needed_decision,
          deal: { id: e.deal_id },
          extra: [`ID эскалации: ${e.id}`],
        }),
        { reply_markup: kb }
      );
    }
  });

  bot.callbackQuery(/^esc:(approve|reject):(.+)$/, async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return ctx.answerCallbackQuery("Нет доступа");
    const decision = ctx.match![1] === "approve" ? "approved" : "rejected";
    const decisionRu = decision === "approved" ? "согласовано" : "отклонено";
    const id = ctx.match![2];
    await apiFetch(`${opts.apiBase}/escalations/${id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    audit(opts, "escalation_decision", { id, decision, by: ctx.from?.id });
    await ctx.editMessageText(`Эскалация ${id} → ${decisionRu}`);
    await ctx.answerCallbackQuery(`Отмечено: ${decisionRu}`);
  });

  bot.command("playbooks", async (ctx) => {
    if (!isManager(opts, ctx.from?.id)) return denied(ctx);
    const res = await apiFetch(`${opts.apiBase}/playbooks?status=pending_approve`);
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
    if (!isManager(opts, ctx.from?.id)) return ctx.answerCallbackQuery("Нет доступа");
    const decision = ctx.match![1];
    const id = ctx.match![2];
    await apiFetch(`${opts.apiBase}/playbooks/${id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    await ctx.editMessageText(`Playbook ${id} → ${decision}`);
    await ctx.answerCallbackQuery(`Marked ${decision}`);
  });

  setStaffGroupDispatcher(async (msg: StaffGroupInbound) => {
    console.log("[staff-listen] dispatch", {
      source: msg.source,
      userId: msg.userId,
      messageThreadId: msg.messageThreadId,
      len: msg.text.length,
    });
    const peerReq = await resolveStaffPeerRequest(msg.text, {
      replyText: msg.replyText,
    });
    const trainKind = staffTrainingKind(peerReq);
    const topicKind = resolveTopicKindByThreadId(msg.messageThreadId);
    try {
      const blob = `${msg.text}\n${msg.replyText || ""}`;
      const dealMatch = blob.match(
        /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i
      );
      await apiFetch(`${opts.apiBase}/internal/learning`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deal_id: dealMatch?.[1]?.toLowerCase() || null,
          event_type: "staff_room_training",
          payload: {
            text: msg.text.slice(0, 4000),
            kind: trainKind,
            intent: peerReq.intent,
            chat_id: msg.chatId,
            from_id: msg.userId,
            from_username: msg.fromUsername,
            from_name: msg.fromName,
            message_id: msg.messageId,
            message_thread_id: msg.messageThreadId || null,
            topic_kind: topicKind || null,
            source: msg.source,
            room: "staff",
            reply_text: msg.replyText?.slice(0, 500) || null,
            scoped: Boolean(dealMatch?.[1]),
            pinned: false,
          },
        }),
      });
    } catch (err) {
      console.warn("[management-bot] learning log failed", err);
    }

    const sendStaff = async (t: string, e?: StaffReplyExtra) => {
      rememberStaffOutbound(msg.chatId, t);
      const thread =
        e?.message_thread_id ||
        threadIdForReply({
          inboundThreadId: msg.messageThreadId,
          intent: peerReq.intent,
        });
      const extra: StaffReplyExtra = { ...e };
      if (thread) extra.message_thread_id = thread;
      if (!extra.reply_to_message_id && msg.messageId) {
        extra.reply_to_message_id = msg.messageId;
      }
      try {
        await bot.api.sendMessage(msg.chatId, t, extra);
      } catch (err) {
        // Retry without thread if forum rejects
        if (extra.message_thread_id) {
          const { message_thread_id: _drop, ...rest } = extra;
          await bot.api.sendMessage(msg.chatId, t, rest);
          return;
        }
        throw err;
      }
    };

    try {
      await handleStaffPeer(opts, {
        fromId: msg.userId,
        chatId: msg.chatId,
        text: msg.text,
        replyText: msg.replyText,
        messageThreadId: msg.messageThreadId,
        replyToMessageId: msg.replyToMessageId,
        messageId: msg.messageId,
        reply: sendStaff,
      });
    } catch (err) {
      console.error("[management-bot] staff peer failed", err);
      try {
        const fail = "Сбой на моей стороне — напиши ещё раз или /help.";
        await sendStaff(fail);
      } catch {
        /* ignore */
      }
    }
  });

  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text || "";
    if (text.startsWith("/")) return next();
    const botInfo = bot.botInfo || (await bot.api.getMe());
    const entities = ctx.message.entities || [];
    const mention = `@${(botInfo.username || "").toLowerCase()}`;
    const mentioned =
      entities.some(
        (e) =>
          e.type === "mention" &&
          text.slice(e.offset, e.offset + e.length).toLowerCase().includes(mention)
      ) ||
      entities.some(
        (e) =>
          e.type === "text_mention" &&
          "user" in e &&
          Number((e as { user?: { id?: number } }).user?.id) === botInfo.id
      );
    const replyFrom = ctx.message.reply_to_message?.from;
    const isReplyToBot = Boolean(replyFrom?.is_bot && replyFrom.id === botInfo.id);
    const replyText =
      ctx.message.reply_to_message && "text" in ctx.message.reply_to_message
        ? String(ctx.message.reply_to_message.text || "")
        : undefined;
    if (
      !shouldHandleStaffPeer({
        text,
        chatId: ctx.chat.id,
        chatType: ctx.chat.type,
        mentioned,
        isReplyToBot,
        isCommand: false,
      })
    ) {
      return next();
    }
    await dispatchStaffGroup({
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      messageId: ctx.message.message_id,
      messageThreadId: ctx.message.message_thread_id,
      replyToMessageId: ctx.message.reply_to_message?.message_id,
      text,
      replyText,
      fromUsername: ctx.from?.username,
      fromName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" "),
      source: "bot",
    });
  });

  async function staffVoiceFromBot(ctx: Context): Promise<void> {
    const msg = ctx.message;
    if (!msg || !ctx.chat) return;
    const voice = msg.voice || msg.audio;
    if (!voice) return;
    const caption = String(msg.caption || "").trim();
    const replyText =
      msg.reply_to_message && "text" in msg.reply_to_message
        ? String(msg.reply_to_message.text || "")
        : undefined;
    let text = caption;
    try {
      const file = await ctx.api.getFile(voice.file_id);
      if (!file.file_path) throw new Error("no_file_path");
      const url = `https://api.telegram.org/file/bot${opts.token}/${file.file_path}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download_${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const extracted = await transcribeAudio(
        buf,
        msg.voice ? "voice.ogg" : "audio.ogg",
        voice.mime_type || "audio/ogg"
      );
      text = composeInboundText({
        caption,
        media: {
          buffer: buf,
          contentType: voice.mime_type || "audio/ogg",
          filename: msg.voice ? "voice.ogg" : "audio.ogg",
          kind: msg.voice ? "voice" : "audio",
        },
        extracted,
        audience: "staff",
      }).trim();
      console.log("[management-bot] voice", {
        chatId: ctx.chat.id,
        transcribed: Boolean(extracted),
        chars: text.length,
      });
    } catch (err) {
      console.warn(
        "[management-bot] voice failed",
        err instanceof Error ? err.message : err
      );
      text =
        caption ||
        "Не удалось распознать голосовое. Напишите текстом.";
    }
    if (!text) return;
    if (
      !shouldHandleStaffPeer({
        text,
        chatId: ctx.chat.id,
        chatType: ctx.chat.type,
        mentioned: true,
        isReplyToBot: Boolean(msg.reply_to_message?.from?.is_bot),
        isCommand: false,
      })
    ) {
      return;
    }
    await dispatchStaffGroup({
      chatId: ctx.chat.id,
      userId: ctx.from?.id,
      messageId: msg.message_id,
      messageThreadId: msg.message_thread_id,
      replyToMessageId: msg.reply_to_message?.message_id,
      text,
      replyText,
      fromUsername: ctx.from?.username,
      fromName: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" "),
      source: "bot",
    });
  }

  bot.on("message:voice", async (ctx) => {
    await staffVoiceFromBot(ctx);
  });
  bot.on("message:audio", async (ctx) => {
    await staffVoiceFromBot(ctx);
  });

  bot.start({
    onStart: (info) =>
      console.log(
        `[management-bot] polling as @${info.username} peer=${process.env.TG_STAFF_PEER_MODE || "on"} gpt=${process.env.TG_STAFF_GPT || "on"} forum=${process.env.TG_STAFF_FORUM || "on"} staff-listen=on voice=on`
      ),
  });
}
