/** Staff-facing Telegram copy (exec channel + escalation group). Always Russian. */

const MOSCOW = "Europe/Moscow";

export const DEAL_STATUS_RU: Record<string, string> = {
  intake: "сбор данных",
  sizing: "уточнение габаритов",
  customs: "таможня / ТН ВЭД",
  quoting: "запрос ставок у поставщиков",
  pricing: "готово КП",
  negotiation: "торг с клиентом",
  contract: "договор",
  execution: "ведение груза",
  awaiting_manager: "ждёт менеджера",
  closed_won: "сделка выиграна",
  closed_lost: "сделка проиграна",
  cancelled: "отменена",
};

export const CHANNEL_RU: Record<string, string> = {
  telegram: "Telegram",
  voice: "звонок",
  email: "почта",
};

export const ESCALATION_REASON_RU: Record<
  string,
  { title: string; action: string; who: string }
> = {
  grey_scheme_hard_block: {
    title: "Клиент просит серую схему — отказ",
    action: "Подтвердить отказ. Серые схемы не сопровождаем.",
    who: "директору",
  },
  grey_scheme_request: {
    title: "Клиент просит серую схему — отказ",
    action: "Подтвердить отказ. Серые схемы не сопровождаем.",
    who: "директору",
  },
  forbidden_cargo_liquid: {
    title: "Запрещённый груз (в т.ч. жидкости вне профиля)",
    action: "Подтвердить отказ клиенту.",
    who: "менеджеру",
  },
  private_move: {
    title: "Частный переезд — не наш профиль",
    action: "Подтвердить отказ: квартирные/частные переезды не берём.",
    who: "менеджеру",
  },
  sanctioned_goods: {
    title: "Санкционный / запрещённый товар",
    action: "Compliance-проверка. Без серых схем.",
    who: "директору",
  },
  dual_use_hold: {
    title: "Двойное назначение — hold, не автоотказ",
    action: "Живой логист + брокер: маршрут, погранпереход, допустимость.",
    who: "логисту и брокеру",
  },
  dangerous_goods_review: {
    title: "Опасный груз — нужен профильный перевозчик",
    action: "Подобрать DG-перевозчика и ставку. Это не стоп сделки.",
    who: "логисту",
  },
  oversized_expert: {
    title: "Негабарит — нужна экспертная ставка",
    action: "Запросить спецтехнику / негабарит у поставщиков.",
    who: "логисту",
  },
  margin_or_discount_policy: {
    title: "Маржа или скидка вне политики",
    action: "Согласовать цену или отказать в скидке.",
    who: "директору",
  },
  profit_below_minimum: {
    title: "Прибыль ниже минимума",
    action: "Согласовать стратегический минус или поднять цену.",
    who: "директору",
  },
  cashflow_gap: {
    title: "Кассовый разрыв",
    action: "Согласовать финансирование или сдвинуть оплату поставщику.",
    who: "директору",
  },
  amount_threshold: {
    title: "Сумма КП выше порога эскалации",
    action: "Согласовать крупную сделку.",
    who: "директору",
  },
  missing_invoice_for_vat_duty: {
    title: "Нет инвойса — пошлина и НДС не посчитаны",
    action: "Запросить инвойс у клиента или утвердить КП без налоговых строк.",
    who: "менеджеру",
  },
  missing_partner_channels: {
    title: "Некуда запросить ставки поставщиков",
    action:
      "Прописать SUPPLIER_QUOTE_EMAILS / контакты поставщиков. Пока цифру клиенту не называем.",
    who: "директору",
  },
  legal_must_approve: {
    title: "Юридический / compliance hold",
    action: "Логист и брокер подтверждают допустимость груза.",
    who: "логисту и брокеру",
  },
  claim_or_incident: {
    title: "Претензия или инцидент",
    action: "Юридически значимые решения принимает человек, не ИИ.",
    who: "логисту",
  },
  cn_ops_rfq: {
    title: "Выкуп / подбор поставщика в Китае",
    action: "Обработать заявку на товар (это не тариф перевозки).",
    who: "менеджеру",
  },
  procurement_loss_pattern: {
    title: "Системный проигрыш по цене на направлении",
    action:
      "Не снижать маржу вслепую: усилить закупку, пересобрать схему, оценить volume rate.",
    who: "директору",
  },
  execution_playbook_escalation: {
    title: "Эскалация по execution_playbook живого логиста",
    action: "Выполнить инструкцию playbook и ответить клиенту.",
    who: "логисту",
  },
  product_restriction: {
    title: "Ограничение по грузу или услуге",
    action: "Проверить, берём ли такой груз, и ответить клиенту.",
    who: "менеджеру",
  },
  voice_escalation: {
    title: "Эскалация с голосового звонка",
    action: "Перехватить разговор или перезвонить.",
    who: "менеджеру",
  },
  configure_suppliers: {
    title: "Нужно настроить поставщиков",
    action: "Добавить рабочие email/кабинеты поставщиков ставок.",
    who: "директору",
  },
};

export const DECISION_RU: Record<string, string> = {
  acknowledge: "подтвердить и закрыть",
  acknowledge_block: "подтвердить отказ клиенту",
  approve_reject: "согласовать или отклонить",
  approve_price: "согласовать цену КП",
  approve_strategic_loss: "разрешить работу в минус или отказать",
  approve_financing_or_align_supplier: "решить кассовый разрыв",
  request_invoice_or_approve_partial_kp: "запросить инвойс или утвердить частичное КП",
  configure_suppliers: "настроить каналы поставщиков",
  compliance_review: "провести compliance-проверку",
  compliance_route_and_broker: "согласовать маршрут с логистом и брокером",
  expert_rate: "получить экспертную ставку",
  approve_legal: "юридическое согласование",
  human_legal: "решение принимает юрист / логист",
  process_ops_request: "обработать заявку на выкуп/подбор",
  review: "разобрать и решить",
  takeover: "перехватить диалог",
};

export interface DealSnippet {
  id?: string;
  client_name?: string | null;
  client_phone?: string | null;
  status?: string | null;
  cargo_name?: string | null;
  origin?: string | null;
  destination?: string | null;
  amount_rub?: number | null;
  margin_pct?: number | null;
  channel?: string | null;
  quantity?: number | null;
  consignee?: string | null;
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function dealSnippetFromRow(row: Record<string, unknown>): DealSnippet {
  const cargo = asObj(row.cargo);
  const route = asObj(row.route);
  const offer = asObj(row.offer);
  const meta = asObj(row.metadata);
  return {
    id: str(row.id || row.deal_id),
    client_name: str(row.client_name),
    client_phone: str(row.client_phone),
    status: str(row.status),
    cargo_name: str(row.cargo_name || cargo.name),
    origin: str(row.origin_city || row.origin || route.origin_city),
    destination: str(
      row.destination_city || row.destination || route.destination_city
    ),
    amount_rub: num(row.amount_rub ?? offer.price),
    margin_pct: num(row.margin_pct),
    channel: str(row.channel),
    quantity: num(row.quantity ?? cargo.quantity),
    consignee: str(row.consignee || meta.consignee),
  };
}

export function formatMoneyRub(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n)} ₽`;
}

export function formatWhen(iso?: string | Date | null): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: MOSCOW,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function statusRu(status?: string | null): string {
  if (!status) return "—";
  return DEAL_STATUS_RU[status] || status;
}

function dash(v?: string | number | null): string {
  if (v == null || v === "") return "—";
  return String(v);
}

export function formatRoute(origin?: string | null, dest?: string | null): string {
  if (!origin && !dest) return "—";
  return `${origin || "?"} → ${dest || "?"}`;
}

export function formatDealLines(deal?: DealSnippet | null): string[] {
  if (!deal?.id) return [];
  const cargo =
    deal.cargo_name && deal.quantity
      ? `${deal.cargo_name}, ${deal.quantity} шт`
      : deal.cargo_name;
  const money =
    deal.amount_rub != null
      ? deal.margin_pct != null
        ? `${formatMoneyRub(deal.amount_rub)} · маржа ${Number(deal.margin_pct).toFixed(1)}%`
        : formatMoneyRub(deal.amount_rub)
      : undefined;
  return [
    `Сделка: ${deal.id}`,
    `Клиент: ${dash(deal.client_name)}`,
    deal.client_phone ? `Телефон: ${deal.client_phone}` : "",
    `Маршрут: ${formatRoute(deal.origin, deal.destination)}`,
    deal.consignee ? `Получатель: ${deal.consignee}` : "",
    `Груз: ${dash(cargo)}`,
    `Стадия: ${statusRu(deal.status)}`,
    money ? `КП: ${money}` : "",
    deal.channel ? `Канал: ${CHANNEL_RU[deal.channel] || deal.channel}` : "",
  ].filter(Boolean);
}

function reasonInfo(reason?: string | null) {
  const key = String(reason || "").trim();
  return (
    ESCALATION_REASON_RU[key] || {
      title: key ? `Эскалация: ${key}` : "Нужно решение менеджера",
      action: "Откройте карточку сделки и решите, как действовать.",
      who: "менеджеру",
    }
  );
}

/** Director only for money/compliance/policy — not every staff alert. */
export function escalationNeedsDirector(reason?: string | null): boolean {
  const who = reasonInfo(reason).who.toLowerCase();
  return who.includes("директор");
}

function decisionRu(code?: string | null): string {
  if (!code) return "разобрать и решить";
  return DECISION_RU[code] || String(code).replace(/_/g, " ");
}

export function formatEscalationStaff(opts: {
  dealId?: string;
  reason?: string | null;
  summary?: string | null;
  neededDecision?: string | null;
  deal?: DealSnippet | null;
  extra?: string[];
}): string {
  const info = reasonInfo(opts.reason);
  const lines = [
    "⚠️ Коллеги, нужно решение",
    info.title,
    "",
    ...formatDealLines(opts.deal || { id: opts.dealId }),
    "",
    opts.summary ? `Суть: ${opts.summary}` : "",
    `Что сделать: ${info.action}`,
    `Решение: ${decisionRu(opts.neededDecision)}`,
    `Кому: ${info.who}`,
    ...(opts.extra || []),
    "",
    "Можно ответить сюда обычным текстом: «утверди КП», «перехвати», «карточка» — или кнопками ниже.",
    opts.dealId ? `Команда: /deal ${opts.dealId}` : "",
  ];
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n").trim();
}

export function formatQuoteExpiredStaff(opts: {
  deal: DealSnippet;
  quoteId?: string;
  source?: string | null;
  price?: number | null;
  currency?: string | null;
  validUntil?: string | null;
}): string {
  const price =
    opts.price != null
      ? `${new Intl.NumberFormat("ru-RU").format(opts.price)} ${opts.currency || "RUB"}`
      : undefined;
  return [
    "⏰ Ставка поставщика истекла",
    "",
    ...formatDealLines(opts.deal),
    price ? `Ставка: ${price}` : "",
    opts.source ? `Источник: ${opts.source}` : "",
    opts.validUntil ? `Действовала до: ${formatWhen(opts.validUntil)}` : "",
    "",
    "Что сделать: запросить новую ставку у поставщика и обновить КП.",
    opts.deal.id ? `Команда: /deal ${opts.deal.id}` : "",
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n")
    .trim();
}

export function formatFollowupStaff(opts: {
  deal: DealSnippet;
  updatedAt?: string | null;
}): string {
  return [
    "⏳ Нет ответа поставщиков больше 2 часов",
    "",
    ...formatDealLines(opts.deal),
    opts.updatedAt ? `Последнее обновление: ${formatWhen(opts.updatedAt)}` : "",
    "",
    "Что сделать: напомнить перевозчикам или внести ставку вручную.",
    opts.deal.id ? `Команда: /deal ${opts.deal.id}` : "",
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n")
    .trim();
}

export function formatOcrInvoiceStaff(opts: {
  deal: DealSnippet;
  value: number;
  currency?: string | null;
  source?: string | null;
}): string {
  const src =
    opts.source === "llm"
      ? "распознала ИИ"
      : opts.source === "heuristic"
        ? "распознала по шаблону"
        : opts.source || "OCR";
  return [
    "🧾 С инвойса снята сумма",
    "",
    ...formatDealLines(opts.deal),
    `Инвойс: ${new Intl.NumberFormat("ru-RU").format(opts.value)} ${opts.currency || ""}`.trim(),
    `Как: ${src}`,
    "",
    "Пересчитываю КП с этой суммой (пошлина/НДС).",
    opts.deal.id ? `Команда: /deal ${opts.deal.id}` : "",
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n")
    .trim();
}

export function formatPartnerEmailApproveStaff(opts: {
  email: string;
  website?: string | null;
}): string {
  return [
    "📧 Новый email поставщика — письмо ещё не ушло",
    "",
    `Адрес: ${opts.email}`,
    opts.website ? `Сайт: ${opts.website}` : "",
    "",
    "Домен не в белом списке. Пока не одобрите контакт, запрос ставки не отправляю.",
    "Что сделать: одобрите first_email_approved в контактах поставщиков.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatImapQuoteStaff(opts: {
  deal: DealSnippet;
  price: number;
  currency?: string | null;
  from?: string | null;
  source?: string | null;
}): string {
  const src =
    opts.source === "llm" ? "ИИ" : opts.source === "heuristic" ? "по тексту письма" : opts.source;
  return [
    "📬 Поставщик прислал ставку на почту",
    "",
    ...formatDealLines(opts.deal),
    `Ставка: ${new Intl.NumberFormat("ru-RU").format(opts.price)} ${opts.currency || "RUB"}`,
    opts.from ? `От: ${opts.from}` : "",
    src ? `Разобрала: ${src}` : "",
    "",
    "Ставка сохранена, пересчитываю КП клиенту.",
    opts.deal.id ? `Команда: /deal ${opts.deal.id}` : "",
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n")
    .trim();
}

export function formatImapUnparsedStaff(opts: {
  deal: DealSnippet;
  subject?: string | null;
  from?: string | null;
}): string {
  return [
    "📬 Письмо по сделке — цену из текста не разобрала",
    "",
    ...formatDealLines(opts.deal),
    opts.from ? `От: ${opts.from}` : "",
    opts.subject ? `Тема: ${opts.subject}` : "",
    "",
    "Что сделать: откройте письмо и внесите ставку вручную либо перешлите сумму цифрой.",
    opts.deal.id ? `Команда: /deal ${opts.deal.id}` : "",
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n")
    .trim();
}

export function formatAfterHoursCallStaff(opts: {
  phone: string;
  deal?: DealSnippet | null;
}): string {
  return [
    "🌙 Звонок вне рабочего времени",
    "",
    `Телефон: ${opts.phone}`,
    ...formatDealLines(opts.deal),
    "",
    "Клиенту проиграно автосообщение, живой разговор не вели.",
    "Что сделать: перезвонить в рабочие часы.",
    opts.deal?.id ? `Команда: /deal ${opts.deal.id}` : "",
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n")
    .trim();
}

export function formatVoiceEscalationStaff(opts: {
  deal?: DealSnippet | null;
  phone?: string | null;
  reason?: string | null;
  summary?: string | null;
}): string {
  const info = reasonInfo(opts.reason);
  return [
    "📞 Эскалация со звонка",
    info.title,
    "",
    opts.phone ? `Телефон: ${opts.phone}` : "",
    ...formatDealLines(opts.deal),
    "",
    opts.summary ? `Суть: ${opts.summary}` : "",
    `Что сделать: ${info.action}`,
    "",
    opts.deal?.id ? `Команда: /deal ${opts.deal.id}` : "",
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n")
    .trim();
}

export function formatDealCardStaff(opts: {
  deal: DealSnippet;
  offerPrice?: number | null;
  currency?: string | null;
  etaMin?: number | null;
  etaMax?: number | null;
  flags?: string[];
  risks?: string[];
}): string {
  const offer =
    opts.offerPrice != null
      ? `${formatMoneyRub(opts.offerPrice)}${opts.currency && opts.currency !== "RUB" ? ` (${opts.currency})` : ""}`
      : opts.deal.amount_rub != null
        ? formatMoneyRub(opts.deal.amount_rub)
        : "—";
  const eta =
    opts.etaMin != null || opts.etaMax != null
      ? `${opts.etaMin ?? "?"}–${opts.etaMax ?? "?"} дн.`
      : "—";
  return [
    "📋 Карточка сделки",
    "",
    ...formatDealLines(opts.deal),
    `Цена клиенту: ${offer}`,
    `Срок: ${eta}`,
    opts.flags?.length ? `Метки: ${opts.flags.join(" · ")}` : "",
    opts.risks?.length ? `Риски: ${opts.risks.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
