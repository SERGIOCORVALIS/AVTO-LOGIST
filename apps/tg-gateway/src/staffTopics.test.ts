import {
  topicKindForOutbound,
  topicKindForIntent,
  STAFF_TOPIC_TITLES,
} from "./staffTopics";
import {
  extractForumThreadIds,
} from "./staffListen";
import {
  opsHintWantsApplyAll,
  parseOpsHint,
  pickOpenDealsForOpsHint,
  safeOpsRerunRfq,
} from "./staffPeer";

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

assert(STAFF_TOPIC_TITLES.general === "Общее", "title general");
assert(STAFF_TOPIC_TITLES.escalations === "Эскалации", "title esc");
assert(STAFF_TOPIC_TITLES.rfq === "RFQ", "title rfq");
assert(STAFF_TOPIC_TITLES.coaching === "Обучение", "title coach");

assert(topicKindForOutbound("alert") === "escalations", "alert→esc");
assert(topicKindForOutbound("learning") === "coaching", "learning→coach");
assert(topicKindForOutbound("ops") === "rfq", "ops→rfq");
assert(topicKindForOutbound("rfq") === "rfq", "rfq→rfq");
assert(topicKindForOutbound("info") === "general", "info→general");

assert(topicKindForIntent("ops_hint") === "rfq", "intent ops");
assert(topicKindForIntent("approve_rfq") === "rfq", "intent approve_rfq");
assert(topicKindForIntent("escalations") === "escalations", "intent esc");
assert(topicKindForIntent("takeover") === "escalations", "intent takeover");
assert(topicKindForIntent("answer") === "coaching", "intent answer");
assert(topicKindForIntent("status") === "general", "intent status");

const thread = extractForumThreadIds({
  replyTo: { replyToTopId: 42, replyToMsgId: 99, forumTopic: true },
});
assert(thread.messageThreadId === 42, "thread top id");
assert(thread.replyToMessageId === 99, "reply msg id");

const forumRoot = extractForumThreadIds({
  replyTo: { replyToMsgId: 7, forumTopic: true },
});
assert(forumRoot.messageThreadId === 7, "forum topic root as thread");

const sendHint = parseOpsHint("отправляй miss.Transportnaya@mail.ru обе сделки");
assert(opsHintWantsApplyAll(sendHint) === true, "wants apply all");
assert(safeOpsRerunRfq(sendHint, "отправляй miss.Transportnaya@mail.ru обе сделки") === true, "send → rerun");

const holdHint = parseOpsHint(
  "Текст:\nМаршрут: Новосибирск → Владивосток\n40HC"
);
assert(
  safeOpsRerunRfq(
    { metadata: { staff_rfq_body: "draft" }, rerun_rfq: true, summary: "gpt" },
    "скорректируй текст"
  ) === false,
  "body without send → no rerun"
);
assert(
  safeOpsRerunRfq(
    { metadata: { hold_rfq: true }, rerun_rfq: false, summary: "x" },
    "учти hold"
  ) === false,
  "hold blocks without send"
);
assert(
  safeOpsRerunRfq(
    { metadata: { hold_rfq: true }, rerun_rfq: false, summary: "x" },
    "отправляй"
  ) === true,
  "отправляй overrides hold"
);

const pool = [
  {
    id: "a",
    status: "quoting",
    route: { destination_city: "Владивосток" },
  },
  {
    id: "b",
    status: "quoting",
    route: { destination_city: "Владивосток" },
  },
  {
    id: "c",
    status: "closed_won",
    route: { destination_city: "Владивосток" },
  },
];

const multi = pickOpenDealsForOpsHint({
  pool,
  patch: sendHint,
  preferDestination: "Владивосток",
});
assert(multi.dealIds.length === 2, "apply all open vlad");
assert(!multi.dealIds.includes("c"), "skip closed");

const single = pickOpenDealsForOpsHint({
  pool: [pool[0]],
  patch: { metadata: { staff_ops_hint: "x" }, summary: "one" },
  preferDestination: "Владивосток",
});
assert(single.dealIds.length === 1 && single.dealIds[0] === "a", "single deal");

const amb = pickOpenDealsForOpsHint({
  pool: [
    { id: "x", status: "quoting", route: { destination_city: "Москва" } },
    { id: "y", status: "quoting", route: { destination_city: "Казань" } },
  ],
  patch: { metadata: { staff_ops_hint: "x" }, summary: "no dest" },
});
assert(amb.dealIds.length === 0 && amb.ambiguous.length === 2, "ambiguous without dest");

console.log("staffTopics/peer helpers tests ok");
