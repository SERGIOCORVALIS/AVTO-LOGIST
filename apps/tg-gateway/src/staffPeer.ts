/**
 * Staff peer mode: understand natural language from managers/logists
 * in DM and the staff room (TG_STAFF_CHAT_ID / TG_ESCALATION_CHAT_ID).
 * That room is for coaching the robot and approving actions — not alerts-only.
 */

export type StaffIntent =
  | "help"
  | "status"
  | "escalations"
  | "awaiting"
  | "deal_card"
  | "approve_kp"
  | "reject_deal"
  | "takeover"
  | "pause"
  | "resume"
  | "cut3"
  | "ops_hint"
  | "set_active"
  | "approve_rfq"
  | "answer"
  | "observe"
  | "unclear";

export interface OpsHintPatch {
  route?: Record<string, string | undefined>;
  metadata?: Record<string, unknown>;
  summary?: string;
  rerun_rfq?: boolean;
}

export interface StaffPeerRequest {
  intent: StaffIntent;
  dealId?: string;
  query?: string;
  confidence: number;
  raw: string;
  opsPatch?: OpsHintPatch;
}

const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const SHORT_ID_RE = /\b(?:сделк[аиуе]|deal|uuid|id)[:\s#№-]*([0-9a-f]{8})\b/i;

const PSZHVS_OPS =
  /псжвс|п\.?\s*с\.?\s*ж\.?\s*в\.?\s*с|южсах|юж\.?\s*сах|станци[яи].*порт|порт.*станци|жд\+?\s*море|rail\+?\s*sea|бердск|новосибирск.*(корсаков|сахалин)|корсаков.*(псжвс|жд|море)|сравни.*(fesco|феско|трансконтейнер|каско|саско|dvlk)/i;

/** Broader coaching / ops instructions from staff room (not only PSZhVS). */
const GENERIC_OPS =
  /спроси|не пиши|не говори|запомни|учти|всегда|сначала|предпочит|оператор|схем[ауые]|инкотерм|инвойс|вес|габарит|cy[\s.-]?cy|сай.?сай|фитинг|контейнер|rfq|кп\b|клиенту не|не называй|веди так|делай так|по сделк|расч[её]т|пересчитай|продолж.*(сделк|веден)|почт|@[\w.-]+\.\w+|не отправл|отправл|текст\s*:|скорректир|обе сделк|оба заказ/i;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function extractEmails(text: string): string[] {
  const found = String(text || "").match(EMAIL_RE) || [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of found) {
    const e = raw.trim().toLowerCase();
    if (!e || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

function extractStaffRfqBody(raw: string): string | undefined {
  const m = raw.match(/(?:^|\n)\s*текст\s*[:：]\s*([\s\S]+)$/i);
  if (m?.[1]?.trim()) return m[1].trim().slice(0, 4000);
  // Block that looks like a ready RFQ draft (route + container/cargo).
  if (
    /маршрут\s*:/i.test(raw) &&
    /(контейнер|груз|вес)/i.test(raw) &&
    raw.length >= 40
  ) {
    return raw.replace(/^\s*текст\s*[:：]\s*/i, "").trim().slice(0, 4000);
  }
  return undefined;
}

const OPERATOR_ALIASES: Array<{ re: RegExp; code: string }> = [
  { re: /fesco|феско/i, code: "fesco" },
  { re: /трансконтейнер|transcontainer|трк/i, code: "transcontainer" },
  { re: /\bkasco\b|каско/i, code: "kasco" },
  { re: /\bsasco\b|саско/i, code: "sasco" },
  { re: /\bdvlk\b|двлк/i, code: "dvlk" },
];

export function extractDealId(text: string, replyText?: string): string | undefined {
  const blob = `${text}\n${replyText || ""}`;
  const full = blob.match(UUID_RE);
  if (full) return full[0].toLowerCase();
  const short = blob.match(SHORT_ID_RE);
  if (short) return short[1].toLowerCase();
  const bare = blob.match(/\b([0-9a-f]{8})(?:-[0-9a-f-]{4,})?\b/i);
  if (bare && /сделк|deal|uuid|\bid\b|карт/i.test(blob)) return bare[1].toLowerCase();
  return undefined;
}

/** Parse logistics ops hint from staff (scheme, cities, preferred operators, coaching). */
export function parseOpsHint(text: string): OpsHintPatch | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const emails = extractEmails(raw);
  const isPszhvs = PSZHVS_OPS.test(raw);
  const isGeneric = GENERIC_OPS.test(raw) || emails.length > 0;
  if (!isPszhvs && !isGeneric) return null;

  const route: Record<string, string | undefined> = {};
  const metadata: Record<string, unknown> = {
    staff_ops_hint: raw.slice(0, 2000),
  };
  const bits: string[] = [];

  if (/псжвс|п\.?\s*с\.?\s*ж\.?\s*в\.?\s*с|жд\+?\s*море|rail\+?\s*sea|южсах/i.test(raw)) {
    route.scheme = "pszhvs_rail_sea";
    route.transport_mode = "container";
    route.corridor = "ru_domestic";
    metadata.scheme = "pszhvs_rail_sea";
    bits.push("схема ПСЖВС (жд+море)");
  }
  if (/cy[\s.-]?cy|сай.?сай/i.test(raw)) {
    metadata.scheme = metadata.scheme || "cy_cy";
    route.scheme = route.scheme || "cy_cy";
    bits.push("схема CY-CY");
  }

  if (/бердск/i.test(raw)) {
    route.origin_city = "Бердск";
    route.pickup_city = "Бердск";
    bits.push("погрузка Бердск");
  }
  if (/новосибирск/i.test(raw) && !route.origin_city) {
    route.origin_city = "Новосибирск";
    bits.push("отправка Новосибирск");
  } else if (/новосибирск/i.test(raw) && route.origin_city === "Бердск") {
    route.origin_region = "Новосибирск";
    bits.push("регион Новосибирск");
  }
  if (/корсаков/i.test(raw)) {
    route.destination_city = "Корсаков";
    bits.push("назначение Корсаков");
  }
  if (/владивосток/i.test(raw) && !route.destination_city) {
    route.destination_city = "Владивосток";
    bits.push("назначение Владивосток");
  }

  const preferred: string[] = [];
  for (const { re, code } of OPERATOR_ALIASES) {
    if (re.test(raw) && !preferred.includes(code)) preferred.push(code);
  }
  if (
    !preferred.length &&
    /сравни|оператор|ставк/i.test(raw) &&
    /псжвс|южсах|корсаков/i.test(raw)
  ) {
    preferred.push("fesco", "transcontainer", "kasco", "sasco", "dvlk");
  }
  if (preferred.length) {
    metadata.preferred_operators = preferred;
    bits.push(`операторы: ${preferred.join(", ")}`);
  }

  if (/спроси.*вес|уточни.*вес|вес\s*(нужен|обязат)/i.test(raw)) {
    metadata.ask_client = [
      ...(Array.isArray(metadata.ask_client) ? (metadata.ask_client as string[]) : []),
      "weight_kg",
    ];
    bits.push("спросить вес");
  }
  if (/спроси.*инвойс|уточни.*инвойс|нужен инвойс/i.test(raw)) {
    metadata.ask_client = [
      ...(Array.isArray(metadata.ask_client) ? (metadata.ask_client as string[]) : []),
      "invoice",
    ];
    bits.push("спросить инвойс");
  }
  if (/не пиши клиенту|клиенту не|не называй клиенту|не раскрывай/i.test(raw)) {
    metadata.client_do_not_say = raw.slice(0, 500);
    bits.push("ограничение для клиента");
  }

  const rfqBody = extractStaffRfqBody(raw);
  if (rfqBody) {
    metadata.staff_rfq_body = rfqBody;
    metadata.rfq_body_override = rfqBody;
    bits.push("текст RFQ от менеджера");
    // Pull cargo name / weights from the corrected draft when present.
    const cargoName = rfqBody.match(/груз\s*[:：]?\s*([^\n]+)/i)?.[1]?.trim();
    if (cargoName) {
      metadata.staff_cargo_name = cargoName.slice(0, 200);
      bits.push(`груз: ${cargoName.slice(0, 60)}`);
    }
    const weights = [
      ...rfqBody.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:т|тонн)/gi),
    ].map((m) => Math.round(parseFloat(m[1].replace(",", ".")) * 1000));
    if (weights.length) {
      metadata.staff_weight_kg_variants = weights;
      bits.push(`веса: ${weights.map((w) => `${w} кг`).join(", ")}`);
    }
  }

  if (emails.length) {
    const onlyAllow =
      /только на почт|отправляем только|отправ(ь|ить|ляем)? только|запрос(ы)? на расчет отправляем только|на почт[уые]\s*:/i.test(
        raw
      ) ||
      (/почт/i.test(raw) && /только/i.test(raw));
    const blockListed =
      /на эти почты.*(не отправ|не шл)|не отправляем[\s\S]{0,80}@/i.test(raw) &&
      !onlyAllow;
    if (onlyAllow || (!blockListed && /отправ/i.test(raw))) {
      // Allowlist wins when manager says "only these".
      const allow = onlyAllow
        ? emails.filter((e) => {
            // Prefer emails after "только" marker when both block+allow in one message.
            const idxOnly = raw.toLowerCase().search(/только на почт|отправляем только|только на|почты\s*:/i);
            if (idxOnly < 0) return true;
            const pos = raw.toLowerCase().indexOf(e);
            return pos < 0 || pos >= idxOnly;
          })
        : emails;
      const finalAllow = allow.length ? allow : emails.slice(-1);
      metadata.staff_rfq_emails = finalAllow;
      // Mail allowlist only — never disables FESCO FIT / partner HTTP API.
      metadata.staff_rfq_emails_only = true;
      bits.push(`почта RFQ только: ${finalAllow.join(", ")} (API всё равно)`);
    }
    if (blockListed || /на эти почты сейчас не отправляем/i.test(raw)) {
      const block = emails.filter(
        (e) =>
          !(Array.isArray(metadata.staff_rfq_emails) &&
            (metadata.staff_rfq_emails as string[]).includes(e))
      );
      if (block.length) {
        metadata.staff_rfq_blocklist = block;
        bits.push(`не слать: ${block.length} адрес(ов)`);
      }
    }
  }

  const hold =
    /пока не отправ|не отправляй|не отправляем|скорректируем почт|пришл(ём|ем) почт|текст скорректир|сейчас скорректир|жди|подожди|согласуй со мной|спроси мен/i.test(
      raw
    ) && !/отправл(яй|и)(?:\s|$|[,.!?])|одобри\s*rfq|можно отправ/i.test(raw);
  if (hold) {
    metadata.hold_rfq = true;
    metadata.consult_manager = true;
    metadata.require_manager_approve = true;
    bits.push("RFQ на паузе — жду менеджера");
  }

  const sendNow =
    /отправл(яй|и)(?:\s|$|[,.!?])|можно отправ|одобри\s*rfq|шл[ие] запрос/i.test(raw);
  if (sendNow) {
    metadata.hold_rfq = false;
    metadata.consult_manager = false;
    bits.push("разрешена отправка RFQ");
  }

  if (/обе сделк|оба заказ|обеим|по обеим|все открыт/i.test(raw)) {
    metadata.apply_all_matching = true;
    bits.push("применить ко всем подходящим сделкам");
  }

  const hasEmailDirective = Boolean(
    metadata.staff_rfq_emails || metadata.staff_rfq_blocklist
  );
  // Allowlist / corrected text without explicit «отправляй» → consult first.
  if (hasEmailDirective && !sendNow && metadata.hold_rfq !== false) {
    metadata.hold_rfq = true;
    metadata.consult_manager = true;
    if (!bits.some((b) => b.includes("подтверждение"))) {
      bits.push("сначала подтверждение менеджера");
    }
  }

  const holdFinal = metadata.hold_rfq === true;
  // Corrected draft alone must not blast RFQ — wait for emails + «отправляй».
  const draftOnly = Boolean(rfqBody) && !sendNow && !metadata.staff_rfq_emails;
  if (draftOnly) {
    metadata.hold_rfq = true;
    metadata.consult_manager = true;
    bits.push("текст принят — жду почты/«отправляй»");
  }
  const blocked = metadata.hold_rfq === true;
  const rerun =
    !blocked &&
    (sendNow ||
      Boolean(metadata.staff_rfq_emails) ||
      (!rfqBody &&
        (isPszhvs ||
          preferred.length > 0 ||
          Boolean(route.scheme) ||
          Boolean(route.origin_city) ||
          Boolean(route.destination_city))));

  return {
    route: Object.keys(route).length ? route : undefined,
    metadata,
    summary: bits.join("; ") || "операционная подсказка",
    rerun_rfq: Boolean(rerun),
  };
}

export function parseStaffPeerIntent(
  text: string,
  opts?: { replyText?: string }
): StaffPeerRequest {
  const raw = String(text || "").trim();
  const low = raw.toLowerCase().replace(/\s+/g, " ");
  const dealId = extractDealId(raw, opts?.replyText);
  const replyHasDeal = Boolean(extractDealId(opts?.replyText || ""));

  if (
    /^(привет|здравств|добрый|хай|hello|hi|ку)\b/.test(low) ||
    /что (ты )?(умеешь|можешь)|как (с тобой )?работать|help|помощ/.test(low)
  ) {
    return { intent: "help", dealId, confidence: 0.9, raw };
  }

  if (
    /эскалац|что висит|открыт(ые|ых)? (эскалац|задач)|нужн(о|ы) решен/.test(low)
  ) {
    return { intent: "escalations", dealId, confidence: 0.92, raw };
  }

  if (
    /сводк|статус(ы)?\b|что (сейчас )?по сделкам|как дела у бота|мониторинг|проверь статус|статус сделк/.test(
      low
    )
  ) {
    return { intent: "status", dealId, confidence: 0.88, raw };
  }

  // «Нужны расчёты по Александре / продолжи ведение» — open card(s), not unclear.
  if (
    /расч[её]т|пересчитай|продолж(ить|ай).*(сделк|веден)|веден(ие|ием) сделк|сделать расч|нет сумм|завис/.test(
      low
    ) ||
    /клиент(у|а|е)?\s+[а-яa-zё]{3,}/i.test(low)
  ) {
    const q = low
      .replace(/нужно|нужны|сделать|проверь|сам|всю|информацию|пометк\w*|ждёт\w*|человека|от\s+\d+[./]\d+/gi, " ")
      .replace(/расч[её]т\w*|пересчитай|продолж\w*|веден\w*|сделк\w*|клиент\w*|строительн\w*|систем\w*/gi, " ")
      .replace(/новосибирск|владивосток|корсаков|->|—|–/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const nameHit =
      raw.match(/клиент(?:у|а|е)?\s+([А-ЯA-ZЁа-яa-zё]{3,})/i)?.[1] ||
      raw.match(/\b(Александра|Aleksandra|Alexandra)\b/i)?.[1] ||
      q.split(" ").find((w) => w.length >= 4);
    return {
      intent: "deal_card",
      dealId,
      query: nameHit || q || raw.slice(0, 80),
      confidence: dealId ? 0.9 : 0.75,
      raw,
    };
  }

  if (
    /ждут менеджер|awaiting|на паузе у человек|перехват(ы)?\b/.test(low) &&
    !/перехвати|takeover|беру/.test(low)
  ) {
    return { intent: "awaiting", dealId, confidence: 0.85, raw };
  }

  if (
    /утверд(и|ить)|одобр(и|ить)|согласуй|approve(\s+kp)?|кп\s*(ок|ок\.|да)/.test(
      low
    )
  ) {
    return {
      intent: "approve_kp",
      dealId: dealId || (replyHasDeal ? extractDealId(opts!.replyText!) : undefined),
      confidence: dealId || replyHasDeal ? 0.9 : 0.55,
      raw,
    };
  }

  if (/отклон(и|ить)|reject|cancel|отмен(и|ить) сделк/.test(low)) {
    return {
      intent: "reject_deal",
      dealId: dealId || (replyHasDeal ? extractDealId(opts!.replyText!) : undefined),
      confidence: dealId || replyHasDeal ? 0.88 : 0.5,
      raw,
    };
  }

  if (/перехвати|takeover|беру (сам|на себя)|человек вед[её]т/.test(low)) {
    return {
      intent: "takeover",
      dealId: dealId || (replyHasDeal ? extractDealId(opts!.replyText!) : undefined),
      confidence: dealId || replyHasDeal ? 0.9 : 0.55,
      raw,
    };
  }

  if (/\bпауза\b|pause|останови (бота|ии|ai)/.test(low)) {
    return {
      intent: "pause",
      dealId: dealId || (replyHasDeal ? extractDealId(opts!.replyText!) : undefined),
      confidence: dealId || replyHasDeal ? 0.88 : 0.5,
      raw,
    };
  }

  if (/resume|сними паузу|верни (бота|ии)|продолж(ай|ить) ии/.test(low)) {
    return {
      intent: "resume",
      dealId: dealId || (replyHasDeal ? extractDealId(opts!.replyText!) : undefined),
      confidence: dealId || replyHasDeal ? 0.88 : 0.5,
      raw,
    };
  }

  if (/скидк[ау].*3|−\s*3%|-3%|cut\s*3|урежь.*3/.test(low)) {
    return {
      intent: "cut3",
      dealId: dealId || (replyHasDeal ? extractDealId(opts!.replyText!) : undefined),
      confidence: dealId || replyHasDeal ? 0.85 : 0.5,
      raw,
    };
  }

  if (
    /работаем по|активн(ая|ую)? сделк|переключ(и|иться) на сделк|веди сделк|focus (on )?deal|set.?active/i.test(
      low
    )
  ) {
    return {
      intent: "set_active",
      dealId: dealId || (replyHasDeal ? extractDealId(opts!.replyText!) : undefined),
      confidence: dealId || replyHasDeal ? 0.92 : 0.55,
      raw,
    };
  }

  if (/одобри\s*rfq|утверди\s*rfq|отправ(ь|ить)\s*rfq|rfq\s*send|согласуй\s*rfq/i.test(low)) {
    return {
      intent: "approve_rfq",
      dealId: dealId || (replyHasDeal ? extractDealId(opts!.replyText!) : undefined),
      confidence: dealId || replyHasDeal ? 0.9 : 0.55,
      raw,
    };
  }

  const opsPatch = parseOpsHint(raw);
  if (opsPatch) {
    return {
      intent: "ops_hint",
      dealId: dealId || (replyHasDeal ? extractDealId(opts!.replyText!) : undefined),
      confidence: dealId || replyHasDeal ? 0.9 : 0.72,
      raw,
      opsPatch,
    };
  }

  if (
    dealId ||
    /карт(очк|а)|сделк[аиуе]|что (там )?по|покажи|открой|разбер(и|ём)/.test(low)
  ) {
    const q = low
      .replace(/карт(очк|а)\s*(сделк[аиуе])?/g, "")
      .replace(/сделк[аиуе]/g, "")
      .replace(/покажи|открой|что (там )?по|разбер(и|ём)/g, "")
      .replace(UUID_RE, "")
      .trim();
    return {
      intent: "deal_card",
      dealId,
      query: q || undefined,
      confidence: dealId ? 0.92 : 0.7,
      raw,
    };
  }

  return { intent: "unclear", dealId, confidence: 0.3, raw };
}

function sameStaffChatIds(a: number, b: number): boolean {
  if (a === b) return true;
  if (Math.abs(a) === Math.abs(b)) return true;
  const strip = (n: number) => {
    const s = String(Math.abs(n));
    if (s.startsWith("100") && s.length > 10) return s.slice(3);
    return s;
  };
  return strip(a) === strip(b);
}

/** Whether this chat message should be handled as staff peer talk. */
export function shouldHandleStaffPeer(opts: {
  text: string;
  chatId: number;
  chatType?: string;
  mentioned?: boolean;
  isReplyToBot?: boolean;
  isCommand?: boolean;
  escalationChatId?: string;
  execChannelId?: string;
  peerMode?: string;
}): boolean {
  if (opts.isCommand) return false;
  const mode = (opts.peerMode || process.env.TG_STAFF_PEER_MODE || "on")
    .toLowerCase()
    .trim();
  if (mode === "0" || mode === "false" || mode === "off" || mode === "no") {
    return false;
  }
  const text = (opts.text || "").trim();
  if (!text) return false;

  const chat = String(opts.chatId);
  const esc = String(
    opts.escalationChatId ||
      process.env.TG_STAFF_CHAT_ID ||
      process.env.TG_ESCALATION_CHAT_ID ||
      ""
  );
  const exec = String(opts.execChannelId || process.env.TG_EXEC_CHANNEL_ID || "");
  const isDm = opts.chatType === "private" || opts.chatId > 0;
  const escN = Number(esc);
  const inEscalation =
    Boolean(esc && chat === esc) ||
    (Number.isFinite(escN) &&
      escN !== 0 &&
      Number.isFinite(opts.chatId) &&
      sameStaffChatIds(opts.chatId, escN));
  const isStaffChat =
    inEscalation ||
    (exec && chat === exec) ||
    opts.chatType === "group" ||
    opts.chatType === "supergroup";

  if (isDm) return true;
  // Escalation / staff room: always listen (training + ops), no @bot required.
  if (inEscalation) return true;
  if (!isStaffChat && mode !== "all") return false;

  // In groups/channels: respond when addressed, replying to bot, or clearly about a deal
  if (opts.mentioned || opts.isReplyToBot) return true;
  if (mode === "all") return true;
  if (UUID_RE.test(text)) return true;
  if (
    /^(утверд|одобр|согласуй|перехвати|пауза|resume|статус|сводк|эскалац|карт)/i.test(
      text
    )
  ) {
    return true;
  }
  // Ops hints from logists in escalation group (even without @bot)
  if (PSZHVS_OPS.test(text)) return true;
  // Soft mention of bot name
  const botNames = (process.env.TG_STAFF_BOT_NAMES || "бот,логист,alo,ало")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const low = text.toLowerCase();
  if (botNames.some((n) => low.includes(n))) return true;
  // With GPT on: operational Q&A in staff chats (not lunch chatter)
  const gptOn = !["0", "false", "off", "no"].includes(
    (process.env.TG_STAFF_GPT || "on").toLowerCase().trim()
  );
  if (
    gptOn &&
    /\?|почему|зачем|как (лучше|быть|ответить)|что (делать|сказать|ответить)|разбер/i.test(
      text
    ) &&
    /сделк|клиент|ставк|кп\b|rfq|поставщик|маршрут|груз|эскалац|марж|тамож|инвойс|договор|логист/i.test(
      low
    )
  ) {
    return true;
  }
  return false;
}

/** True when ops hint asks to apply to all matching open deals. */
export function opsHintWantsApplyAll(patch: OpsHintPatch | null | undefined): boolean {
  return Boolean(patch?.metadata?.apply_all_matching);
}

/**
 * Never blast RFQ from GPT alone — require send/approve language or
 * a regex patch that already set rerun_rfq with hold cleared.
 */
export function safeOpsRerunRfq(
  patch: OpsHintPatch | null | undefined,
  rawText: string
): boolean {
  if (!patch) return false;
  const sendNow =
    /отправл(яй|и)(?:\s|$|[,.!?])|можно отправ|одобри\s*rfq|шл[ие] запрос/i.test(
      String(rawText || "")
    );
  if (sendNow) return true;
  if (patch.metadata?.hold_rfq === true || patch.metadata?.consult_manager === true) {
    return false;
  }
  // Explicit false from parser
  if (patch.rerun_rfq === false) return false;
  // Allowlist emails without «отправляй» must not blast
  if (
    Array.isArray(patch.metadata?.staff_rfq_emails) &&
    (patch.metadata!.staff_rfq_emails as string[]).length > 0 &&
    !sendNow
  ) {
    return false;
  }
  if (patch.metadata?.staff_rfq_body && !sendNow) return false;
  return Boolean(patch.rerun_rfq);
}

export type DealRowLite = {
  id: string;
  status?: string;
  route?: Record<string, unknown>;
  client_name?: string;
};

/**
 * Pick deal id(s) for an ops hint from an open-deal pool.
 * apply_all_matching or multiple same-lane hits → all ids; single → one; else ambiguous.
 */
export function pickOpenDealsForOpsHint(opts: {
  pool: DealRowLite[];
  patch?: OpsHintPatch | null;
  preferDestination?: string;
}): { dealIds: string[]; ambiguous: DealRowLite[] } {
  const closed = new Set(["closed_won", "closed_lost", "cancelled"]);
  const open = opts.pool.filter((d) => !closed.has(String(d.status || "")));
  if (!open.length) return { dealIds: [], ambiguous: [] };

  const dest = String(
    opts.preferDestination || opts.patch?.route?.destination_city || ""
  )
    .toLowerCase()
    .trim();
  const sameLane = dest
    ? open.filter((d) =>
        String(d.route?.destination_city || "")
          .toLowerCase()
          .includes(dest)
      )
    : [];
  const pool = sameLane.length ? sameLane : open;
  const applyAll = opsHintWantsApplyAll(opts.patch);

  if (applyAll) {
    return { dealIds: pool.map((d) => String(d.id)), ambiguous: [] };
  }
  if (pool.length === 1) return { dealIds: [String(pool[0].id)], ambiguous: [] };
  // Multiple same-lane without explicit «обе сделки» — still apply to all (existing behaviour)
  if (sameLane.length > 1) {
    return { dealIds: sameLane.map((d) => String(d.id)), ambiguous: [] };
  }
  return { dealIds: [], ambiguous: pool };
}

export function staffTrainingKind(req: {
  intent: StaffIntent;
  raw: string;
}): "coach" | "chat" {
  if (req.intent === "ops_hint") return "coach";
  if (req.intent === "answer") {
    if (parseOpsHint(req.raw)) return "coach";
    if (
      /запомни|учти|всегда|сначала|не\s*пиши|не\s*говори|спроси|лучше|не\s*надо|клиенту\s*не|никогда/i.test(
        req.raw
      )
    ) {
      return "coach";
    }
  }
  return "chat";
}

export function staffPeerHelpText(): string {
  return [
    "Это наша рабочая группа: общаемся, учите меня, подсказываете по сделкам и схемам.",
    "Темы форума: Общее · Эскалации · RFQ · Обучение — отвечаю в той же теме.",
    "Пиши обычным языком — @ и команды не обязательны. Правки текста/почт применяю и перед отправкой спрашиваю вас.",
    "",
    "Примеры:",
    "• «Текст: …» — сохраняю текст RFQ",
    "• «отправляем только на a@b.ru» — ставлю allowlist, потом жду «отправляй»",
    "• «на эти почты не отправляем …» — блок-лист",
    "• «обе сделки» / Владивосток — применяю ко всем открытым заказам на маршрут",
    "• «отправляй» / «одобри RFQ» — шлю запрос по согласованным почтам",
    "• «Владивосток = cy-cy, сначала FESCO/ТК»",
    "• «статус» / «карточка» / «утверди КП» / «перехвати» / «пауза»",
    "• /staff_sync — перечитать историю всех тем в обучение",
    "",
    "Если говорите между собой без задачи ко мне — могу молча запомнить и не лезть в чат.",
  ].join("\n");
}

export function staffPeerClarify(req: StaffPeerRequest): string {
  if (
    [
      "approve_kp",
      "reject_deal",
      "takeover",
      "pause",
      "resume",
      "cut3",
      "ops_hint",
      "set_active",
      "approve_rfq",
    ].includes(req.intent) &&
    !req.dealId
  ) {
    return [
      "Подсказку/действие поняла, но не вижу сделку.",
      "Ответь на мой алерт или напиши uuid / «карточка …» — применю.",
    ].join("\n");
  }
  if (req.intent === "deal_card" && !req.dealId && !req.query) {
    return "Какую сделку открыть? Пришли uuid или имя клиента — или ответь на алерт.";
  }
  return [
    "Не до конца поняла. Можно подсказку по схеме, обучение («учти…»), статус, карточку, утвердить КП / RFQ.",
    "Или /help.",
  ].join("\n");
}
