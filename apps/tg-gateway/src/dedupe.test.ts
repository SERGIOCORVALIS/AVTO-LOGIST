import {
  channelJobId,
  isJobExistsError,
  isPrivateUserChat,
  shouldIgnoreInbound,
} from "./dedupe";

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

assert(isPrivateUserChat(1777854562), "user dm");
assert(!isPrivateUserChat(-1003382259605), "channel");
assert(!isPrivateUserChat(0), "zero");
assert(!isPrivateUserChat(Number.NaN), "nan");

assert(
  shouldIgnoreInbound({ chatId: -1003571284703 }),
  "ignore channel inbound"
);
assert(
  shouldIgnoreInbound({ chatId: 8676266405, skipBotId: 8676266405 }),
  "ignore bot dm by chat"
);
assert(
  shouldIgnoreInbound({ chatId: 111, userId: 8676266405, skipBotId: 8676266405 }),
  "ignore messages from bot sender"
);
assert(
  shouldIgnoreInbound({
    chatId: 222,
    blockedChatIds: [process.env.TG_EXEC_CHANNEL_ID, "222"],
  }),
  "ignore exec/escalation chat"
);
assert(
  !shouldIgnoreInbound({ chatId: 1777854562, skipBotId: 8676266405 }),
  "keep real client dm"
);

assert(isJobExistsError(new Error("Job in-default-1-2 already exists")), "dup");
assert(!isJobExistsError(new Error("ECONNREFUSED")), "other errors");

assert(channelJobId("esc", "deal", "missing_partner_channels").startsWith("esc-"), "id");

console.log("dedupe.test.ts ok");
