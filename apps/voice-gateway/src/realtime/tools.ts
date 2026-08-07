import { readFileSync } from "fs";
import { join } from "path";
import { companyDisplayName } from "@alo/shared";

export interface ToolContext {
  apiBase: string;
  dealId: string;
  phone: string;
  callSessionId: string;
  onEscalate?: (payload: Record<string, unknown>) => void;
  onTransfer?: (reason: string) => void;
}

export const REALTIME_TOOLS = [
  {
    type: "function",
    name: "process_client_message",
    description:
      "Передать сказанное клиентом в CRM/оркестратор для обновления сделки и получения фактов/ответов.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Смысл реплики клиента своими словами" },
      },
      required: ["text"],
    },
  },
  {
    type: "function",
    name: "request_full_quote",
    description:
      "Запустить полный расчёт маршрута, таможни, НДС и коммерческого предложения.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "get_deal_status",
    description: "Текущий статус сделки, груз, маршрут, предложение.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "escalate_call",
    description: "Передать звонок живому менеджеру (сложный кейс, серые схемы, крупная сумма).",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" },
        summary: { type: "string" },
      },
      required: ["reason", "summary"],
    },
  },
] as const;

function loadVoicePrompt(): string {
  const envPath = process.env.VOICE_PROMPT_PATH;
  if (envPath) {
    try {
      return readFileSync(envPath, "utf8");
    } catch {
      /* fallback */
    }
  }
  const candidates = [
    join(process.cwd(), "packages/prompts/gpt/voice_concierge.md"),
    join(process.cwd(), "../../packages/prompts/gpt/voice_concierge.md"),
    join(__dirname, "../../../../packages/prompts/gpt/voice_concierge.md"),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      /* try next */
    }
  }
  return "Ты — голосовой менеджер логистики. Короткие реплики, без выдуманных цен.";
}

export function buildSystemInstructions(ctx: ToolContext): string {
  const company = companyDisplayName();
  const agent = process.env.VOICE_AGENT_NAME || "Анна";
  const disclaimer =
    process.env.VOICE_RECORDING_DISCLAIMER === "true"
      ? "Сообщи, что разговор может записываться."
      : "";
  return [
    loadVoicePrompt(),
    "",
    `Компания: ${company}. Представляйся как ${agent}.`,
    disclaimer,
    `Телефон клиента: ${ctx.phone}. deal_id: ${ctx.dealId}.`,
    "Используй process_client_message для каждой содержательной реплики клиента.",
    "Цены и таможню — только через инструменты, не выдумывай.",
  ].join("\n");
}

async function callOrchestrator(
  ctx: ToolContext,
  text: string,
  opts: { fullQuote?: boolean; idempotencySuffix?: string } = {}
) {
  const res = await fetch(`${ctx.apiBase}/orchestrator/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channel: "voice",
      external_id: ctx.phone,
      call_session_id: ctx.callSessionId,
      text,
      idempotency_key: `voice:${ctx.callSessionId}:${opts.idempotencySuffix || Date.now()}`,
      full_quote: opts.fullQuote ?? false,
    }),
  });
  return (await res.json()) as {
    deal_id?: string;
    replies?: string[];
    escalate?: boolean;
    escalation?: Record<string, unknown>;
    status?: string;
    error?: string;
  };
}

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  if (name === "process_client_message") {
    const text = String(args.text || "").trim();
    if (!text) return JSON.stringify({ ok: false, error: "empty text" });
    const result = await callOrchestrator(ctx, text);
    if (result.escalate && result.escalation) {
      ctx.onEscalate?.(result.escalation);
    }
    return JSON.stringify({
      ok: true,
      status: result.status,
      replies: result.replies || [],
      escalate: result.escalate,
    });
  }

  if (name === "request_full_quote") {
    const result = await callOrchestrator(ctx, "Запрос полного расчёта по текущим данным сделки.", {
      fullQuote: true,
      idempotencySuffix: "full_quote",
    });
    if (result.escalate && result.escalation) ctx.onEscalate?.(result.escalation);
    return JSON.stringify({
      ok: true,
      status: result.status,
      replies: result.replies || [],
      escalate: result.escalate,
    });
  }

  if (name === "get_deal_status") {
    const orchBase = process.env.ORCHESTRATOR_URL || "http://localhost:8000";
    const res = await fetch(`${orchBase}/deals/${ctx.dealId}/status`);
    const data = await res.json();
    return JSON.stringify(data);
  }

  if (name === "escalate_call") {
    const reason = String(args.reason || "voice_escalation");
    const summary = String(args.summary || "Manager requested via voice agent");
    ctx.onTransfer?.(reason);
    ctx.onEscalate?.({ reason, summary, needed_decision: "takeover" });
    return JSON.stringify({ ok: true, transferring: true, reason, summary });
  }

  return JSON.stringify({ ok: false, error: `unknown tool ${name}` });
}
