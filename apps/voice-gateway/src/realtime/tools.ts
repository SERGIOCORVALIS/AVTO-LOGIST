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
      "Запустить полный расчёт по текущим данным. Таможню и НДС считай только для импорта из Китая, не для перевозок по России.",
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
  let base =
    "Ты — голосовой менеджер логистики. Короткие реплики, без выдуманных цен.";
  for (const p of candidates) {
    try {
      base = readFileSync(p, "utf8");
      break;
    } catch {
      /* try next */
    }
  }
  if ((process.env.ACADEMY_ENABLED || "true").toLowerCase() === "false") {
    return base;
  }
  if ((process.env.ACADEMY_IN_VOICE || "true").toLowerCase() === "false") {
    return base;
  }
  const academyCandidates = [
    join(process.cwd(), "packages/prompts/gpt/academy.md"),
    join(process.cwd(), "../../packages/prompts/gpt/academy.md"),
    join(__dirname, "../../../../packages/prompts/gpt/academy.md"),
  ];
  for (const p of academyCandidates) {
    try {
      const academy = readFileSync(p, "utf8");
      // Keep voice prompt short: thinking + China schemes + KP rules.
      const lines = academy.split(/\r?\n/);
      const keep = lines.filter((line) =>
        /мышлен|схем|инкотерм|не выдумывай|кабинет|free time|опасно|камчат|море\+жд|полная себестоимость|тз александры/i.test(
          line
        )
      );
      return `${base}\n\n## Академия (кратко)\n${keep.slice(0, 40).join("\n")}`;
    } catch {
      /* try next */
    }
  }
  return base;
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
    "Говори вслух как живой человек: ясная дикция, естественная интонация. Не возвращай JSON, markdown и списки.",
    "Не перебивай клиента: выслушай реплику целиком, затем один короткий ответ и жди.",
    "Используй process_client_message только когда клиент сказал содержательную мысль, не на каждое междометие.",
    "Цены — только через инструменты, не выдумывай. Таможню не обещай на перевозках по России.",
    "Подсказки менеджеров из рабочей группы уже учтены в process_client_message (staff_instructions): соблюдай их в ответах клиенту.",
    "Не называй клиенту внутренние ставки поставщиков, маржу и себестоимость.",
  ].join("\n");
}

async function callOrchestrator(
  ctx: ToolContext,
  text: string,
  opts: { fullQuote?: boolean; idempotencySuffix?: string } = {}
) {
  const token = (process.env.INTERNAL_API_TOKEN || "").trim();
  const res = await fetch(`${ctx.apiBase}/orchestrator/process`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "x-internal-token": token } : {}),
    },
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
    escalation?: Record<string, unknown> & { duplicate?: boolean };
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
    if (result.escalate && result.escalation && !result.escalation.duplicate) {
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
    if (result.escalate && result.escalation && !result.escalation.duplicate) ctx.onEscalate?.(result.escalation);
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
