/**
 * GPT layer for staff peer mode: free-text understanding beyond regex.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  openaiApiKey,
  openaiBaseUrl,
  openaiChatExtras,
  openaiFetchInit,
  openaiModel,
  proxiedFetch,
} from "@alo/shared";
import {
  extractDealId,
  parseOpsHint,
  parseStaffPeerIntent,
  safeOpsRerunRfq,
  type StaffIntent,
  type StaffPeerRequest,
} from "./staffPeer";

const STAFF_INTENTS: StaffIntent[] = [
  "help",
  "status",
  "escalations",
  "awaiting",
  "deal_card",
  "approve_kp",
  "reject_deal",
  "takeover",
  "pause",
  "resume",
  "cut3",
  "ops_hint",
  "set_active",
  "approve_rfq",
  "answer",
  "observe",
  "unclear",
];

/** Extended: GPT may answer as a colleague without a system action. */
export type StaffPeerResolved = StaffPeerRequest & {
  source: "regex" | "gpt" | "regex+gpt";
  colleague_reply?: string;
};

const FALLBACK_SYSTEM = `Ты коллега-логист в рабочей группе менеджеров (обучение + сделки). Верни JSON:
{"intent":"help|status|escalations|awaiting|deal_card|approve_kp|reject_deal|takeover|pause|resume|cut3|ops_hint|set_active|approve_rfq|answer|observe|unclear",
"deal_id":null,"query":null,"confidence":0.0,"colleague_reply":null,
"ops_patch":null}
ops_hint — схема/города/операторы; answer — ответ или «учла…»; observe — молчать (менеджеры между собой).`;

function staffGptEnabled(): boolean {
  const v = (process.env.TG_STAFF_GPT || "on").toLowerCase().trim();
  return !["0", "false", "off", "no"].includes(v);
}

function loadStaffPeerPrompt(): string {
  const candidates = [
    join(process.cwd(), "packages/prompts/gpt/staff_peer.md"),
    join(process.cwd(), "../../packages/prompts/gpt/staff_peer.md"),
    join(__dirname, "../../../../packages/prompts/gpt/staff_peer.md"),
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      /* try next */
    }
  }
  return FALLBACK_SYSTEM;
}

function normalizeIntent(raw: unknown): StaffIntent {
  const s = String(raw || "")
    .toLowerCase()
    .trim();
  if ((STAFF_INTENTS as string[]).includes(s)) return s as StaffIntent;
  return "unclear";
}

async function callStaffGpt(opts: {
  text: string;
  replyText?: string;
}): Promise<StaffPeerResolved | null> {
  if (!openaiApiKey()) return null;
  const model = openaiModel("fast");
  const base = openaiBaseUrl();
  const system = loadStaffPeerPrompt();
  try {
    const res = await proxiedFetch(
      `${base}/chat/completions`,
      openaiFetchInit({
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiApiKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          ...openaiChatExtras(model, { temperature: 0 }),
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system.slice(0, 6000) },
            {
              role: "user",
              content: [
                `Сообщение сотрудника:\n${opts.text.slice(0, 2000)}`,
                opts.replyText
                  ? `\n\nАлерт/сообщение, на которое отвечают:\n${opts.replyText.slice(0, 2500)}`
                  : "",
              ].join(""),
            },
          ],
        }),
      })
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw) as {
      intent?: string;
      deal_id?: string | null;
      query?: string | null;
      confidence?: number;
      colleague_reply?: string | null;
      ops_patch?: {
        route?: Record<string, string>;
        metadata?: Record<string, unknown>;
        summary?: string;
      } | null;
    };
    const intentNorm = normalizeIntent(parsed.intent);
    const fromText = extractDealId(opts.text, opts.replyText);
    const dealId =
      (parsed.deal_id && String(parsed.deal_id).match(/[0-9a-f-]{8,}/i)
        ? String(parsed.deal_id).toLowerCase()
        : undefined) || fromText;
    const confidence =
      typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.7;
    const colleague =
      typeof parsed.colleague_reply === "string" && parsed.colleague_reply.trim()
        ? parsed.colleague_reply.trim().slice(0, 3500)
        : undefined;
    const heuristicOps = parseOpsHint(opts.text);
    let opsPatch =
      intentNorm === "ops_hint"
        ? heuristicOps ||
          (parsed.ops_patch
            ? {
                route: parsed.ops_patch.route,
                metadata: {
                  ...(parsed.ops_patch.metadata || {}),
                  staff_ops_hint:
                    (parsed.ops_patch.metadata as { staff_ops_hint?: string } | undefined)
                      ?.staff_ops_hint || opts.text.slice(0, 2000),
                },
                summary: parsed.ops_patch.summary || "подсказка от GPT",
                // Never default-blast from GPT — safeOpsRerunRfq decides later
                rerun_rfq: false,
              }
            : undefined)
        : heuristicOps || undefined;
    if (opsPatch) {
      opsPatch = {
        ...opsPatch,
        rerun_rfq: safeOpsRerunRfq(opsPatch, opts.text),
      };
    }

    if (intentNorm === "answer") {
      return {
        intent: "answer",
        dealId,
        query: parsed.query ? String(parsed.query).slice(0, 200) : undefined,
        confidence,
        raw: opts.text,
        source: "gpt",
        colleague_reply: colleague,
        opsPatch,
      };
    }
    if (intentNorm === "observe") {
      return {
        intent: "observe",
        dealId,
        confidence,
        raw: opts.text,
        source: "gpt",
      };
    }

    return {
      intent: opsPatch && intentNorm === "unclear" ? "ops_hint" : intentNorm,
      dealId,
      query: parsed.query ? String(parsed.query).slice(0, 200) : undefined,
      confidence,
      raw: opts.text,
      source: "gpt",
      colleague_reply: colleague,
      opsPatch,
    };
  } catch {
    return null;
  }
}

/**
 * Regex first for cheap high-confidence hits; GPT for ambiguity and free Q&A.
 */
export async function resolveStaffPeerRequest(
  text: string,
  opts?: { replyText?: string }
): Promise<StaffPeerResolved> {
  const heuristic = parseStaffPeerIntent(text, opts);
  // High-confidence actions (approve/pause/…) skip GPT. Soft deal_card / unclear
  // still go to GPT so instructional text can become ops_hint.
  const skipGptIntents = new Set([
    "help",
    "status",
    "escalations",
    "awaiting",
    "approve_kp",
    "reject_deal",
    "takeover",
    "pause",
    "resume",
    "cut3",
    "set_active",
    "approve_rfq",
    "ops_hint",
  ]);
  const highConfidence =
    skipGptIntents.has(heuristic.intent) && heuristic.confidence >= 0.85;

  if (highConfidence || !staffGptEnabled()) {
    return { ...heuristic, source: "regex" };
  }

  const gpt = await callStaffGpt({
    text,
    replyText: opts?.replyText,
  });
  if (!gpt) {
    return { ...heuristic, source: "regex" };
  }

  // Prefer GPT action if clearer; keep regex dealId if GPT missed it
  const dealId = gpt.dealId || heuristic.dealId;
  if (gpt.intent !== "unclear" || gpt.colleague_reply) {
    return {
      ...gpt,
      dealId,
      opsPatch: gpt.opsPatch || heuristic.opsPatch,
      intent:
        gpt.intent === "unclear" && heuristic.intent === "ops_hint"
          ? "ops_hint"
          : gpt.intent,
      source: heuristic.intent !== "unclear" ? "regex+gpt" : "gpt",
    };
  }
  return {
    ...heuristic,
    dealId,
    source: "regex+gpt",
    colleague_reply: gpt.colleague_reply,
    opsPatch: heuristic.opsPatch || gpt.opsPatch,
  };
}
