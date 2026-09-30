import {
  extractDealId,
  extractEmails,
  parseOpsHint,
  parseStaffPeerIntent,
  safeOpsRerunRfq,
  shouldHandleStaffPeer,
  staffPeerClarify,
  staffTrainingKind,
} from "./staffPeer";

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

const uuid = "11111111-2222-3333-4444-555555555555";

assert(extractDealId(`карточка ${uuid}`) === uuid, "extract uuid");
assert(
  extractDealId("утверди", `Сделка: ${uuid}\nКлиент: Иванов`) === uuid,
  "extract from reply"
);

assert(parseStaffPeerIntent("эскалации").intent === "escalations", "esc");
assert(parseStaffPeerIntent("сводка").intent === "status", "status");
assert(
  parseStaffPeerIntent("По клиенту Александра нужно сделать расчёты").intent === "deal_card",
  "alexandra calc → deal_card"
);
assert(
  String(parseStaffPeerIntent("По клиенту Александра нужно сделать расчёты").query || "")
    .toLowerCase()
    .includes("александра"),
  "alexandra query"
);

const mailHint = parseOpsHint(
  "На эти почты сейчас не отправляем\n• a@kasco.su\nПока все запросы на расчет отправляем только на почты: miss.Transportnaya@mail.ru"
);
assert(mailHint != null, "email ops hint");
assert(
  Array.isArray(mailHint!.metadata?.staff_rfq_emails) &&
    (mailHint!.metadata!.staff_rfq_emails as string[]).includes(
      "miss.transportnaya@mail.ru"
    ),
  "allowlist email"
);
assert(mailHint!.metadata?.hold_rfq === true, "hold until send");

const bodyHint = parseOpsHint(
  "Текст:\nМаршрут: Новосибирск → Владивосток\n40-футовый контейнер\nГруз конструкции металлические\nВес до 22 тонн и 25.7 тонн"
);
assert(bodyHint != null && String(bodyHint.metadata?.staff_rfq_body || "").includes("металлические"), "rfq body");
assert(bodyHint!.rerun_rfq !== true, "body alone does not blast RFQ");

const sendHint = parseOpsHint("отправляй miss.Transportnaya@mail.ru обе сделки");
assert(sendHint != null && sendHint.metadata?.hold_rfq === false, "send clears hold");
assert(sendHint!.metadata?.apply_all_matching === true, "both deals");
assert(extractEmails("x@y.ru и z@w.com").length === 2, "extractEmails");
assert(parseStaffPeerIntent(`утверди КП ${uuid}`).intent === "approve_kp", "approve");
assert(
  parseStaffPeerIntent("перехвати", { replyText: `Сделка: ${uuid}` }).dealId === uuid,
  "takeover deal from reply"
);
assert(parseStaffPeerIntent("что умеешь").intent === "help", "help");
assert(parseStaffPeerIntent(`карточка ${uuid}`).intent === "deal_card", "card");

assert(
  shouldHandleStaffPeer({
    text: "статус",
    chatId: 123,
    chatType: "private",
  }),
  "dm always"
);
assert(
  shouldHandleStaffPeer({
    text: "утверди КП",
    chatId: -1004309948371,
    chatType: "supergroup",
    escalationChatId: "-1004309948371",
    isReplyToBot: true,
  }),
  "reply in esc group"
);
assert(
  shouldHandleStaffPeer({
    text: "обед через час",
    chatId: -1004309948371,
    chatType: "supergroup",
    escalationChatId: "-1004309948371",
    peerMode: "on",
  }),
  "listen all humans in escalation"
);
assert(
  !shouldHandleStaffPeer({
    text: "обед через час",
    chatId: -1009999999999,
    chatType: "supergroup",
    escalationChatId: "-1004309948371",
    peerMode: "on",
  }),
  "ignore casual chatter in other groups"
);
assert(
  shouldHandleStaffPeer({
    text: "почему эскалация по клиенту Иванову?",
    chatId: -1004309948371,
    chatType: "supergroup",
    escalationChatId: "-1004309948371",
    peerMode: "on",
  }),
  "gpt ops question in staff chat"
);

assert(
  parseStaffPeerIntent(
    "Корсаков = ЮжСах = ПСЖВС, грузим Бердск/Новосибирск, сравни FESCO TransContainer KASCO SASCO DVLK"
  ).intent === "ops_hint",
  "ops_hint pszhvs"
);
assert(
  parseStaffPeerIntent(`работаем по сделке ${uuid}`).intent === "set_active",
  "set_active"
);
assert(
  parseStaffPeerIntent(`работаем по сделке ${uuid}`).dealId === uuid,
  "set_active deal"
);
assert(
  shouldHandleStaffPeer({
    text: "Корсаков ПСЖВС, Бердск, сравни FESCO",
    chatId: -1004309948371,
    chatType: "supergroup",
    escalationChatId: "-1004309948371",
    peerMode: "on",
  }),
  "ops hint in staff chat"
);

const clarify = staffPeerClarify({
  intent: "approve_kp",
  confidence: 0.5,
  raw: "утверди",
});
assert(clarify.includes("не вижу сделку"), "clarify needs deal");

assert(
  staffTrainingKind({ intent: "ops_hint", raw: "сначала FESCO" }) === "coach",
  "ops_hint is coach"
);
assert(
  staffTrainingKind({ intent: "answer", raw: "всегда сначала спроси вес" }) ===
    "coach",
  "answer coaching is coach"
);
assert(
  staffTrainingKind({ intent: "observe", raw: "обед через час" }) === "chat",
  "observe is chat"
);
assert(
  staffTrainingKind({ intent: "approve_kp", raw: "утверди КП" }) === "chat",
  "actions are chat"
);

assert(
  safeOpsRerunRfq(
    { metadata: { staff_rfq_body: "x" }, rerun_rfq: true, summary: "g" },
    "текст без отправки"
  ) === false,
  "safeOps body"
);

console.log("staffPeer.test.ts ok");
