import { Bot } from "grammy";
import { grammyProxyFetch } from "@alo/shared";
import { threadIdForOutbound } from "./staffTopics";

let bot: Bot | null = null;

function getBot(): Bot | null {
  if (!process.env.TG_BOT_TOKEN) return null;
  if (!bot) {
    const fetchFn = grammyProxyFetch();
    bot = new Bot(process.env.TG_BOT_TOKEN, fetchFn ? { client: { fetch: fetchFn } } : {});
  }
  return bot;
}

async function sendToChat(
  chatId: string,
  text: string,
  messageThreadId?: number
): Promise<void> {
  const b = getBot();
  if (!b) {
    console.log(
      `[tg-chat:dev] ${chatId}${messageThreadId ? ` topic=${messageThreadId}` : ""}\n${text}`
    );
    return;
  }
  const extra: { message_thread_id?: number } = {};
  if (messageThreadId && messageThreadId > 0) {
    extra.message_thread_id = messageThreadId;
  }
  try {
    await b.api.sendMessage(chatId, text.slice(0, 4000), extra);
  } catch (err) {
    // Forum may reject unknown thread — retry without topic.
    if (extra.message_thread_id) {
      console.warn("[tg-chat] send with topic failed, retry flat", err);
      await b.api.sendMessage(chatId, text.slice(0, 4000));
      return;
    }
    throw err;
  }
}

export async function postToExecutiveChannel(text: string): Promise<void> {
  const channelId = process.env.TG_EXEC_CHANNEL_ID;
  if (!channelId) {
    console.log(`[exec-channel:dev]\n${text}`);
    return;
  }
  await sendToChat(channelId, text);
}

/** Work group — ops: what/why, questions, day-to-day escalations. */
export async function postToStaffWorkChat(
  text: string,
  opts?: { kind?: string; messageThreadId?: number }
): Promise<void> {
  const esc =
    process.env.TG_STAFF_CHAT_ID ||
    process.env.TG_ESCALATION_CHAT_ID ||
    process.env.TG_EXEC_CHANNEL_ID;
  if (!esc) {
    console.log(`[staff-chat:dev]\n${text}`);
    return;
  }
  const threadId =
    opts?.messageThreadId ||
    (opts?.kind ? threadIdForOutbound(opts.kind) : undefined) ||
    threadIdForOutbound("info");
  await sendToChat(esc, text, threadId);
}

/**
 * Route staff channel jobs:
 * - digest → director (full / weekly reports)
 * - info/ops/learning → work group only (into fixed forum topics)
 * - alert → work group Эскалации; + director only if notify_director
 */
export async function routeStaffChannelPost(opts: {
  kind: string;
  text: string;
  notify_director?: boolean;
}): Promise<void> {
  const kind = (opts.kind || "info").toLowerCase();
  const text = opts.text;

  if (kind === "digest") {
    await postToExecutiveChannel(text);
    return;
  }

  if (kind === "alert") {
    await postToStaffWorkChat(text, { kind: "alert" });
    if (opts.notify_director) {
      await postToExecutiveChannel(`📋 Эскалация (сотрудники не справляются)\n\n${text}`);
    }
    return;
  }

  // info / ops / learning / rfq / default — work group topics
  await postToStaffWorkChat(text, { kind });
}

/** @deprecated use routeStaffChannelPost — kept for callers that mean "work + optional director". */
export async function postEscalation(text: string, notifyDirector = false): Promise<void> {
  await routeStaffChannelPost({
    kind: "alert",
    text,
    notify_director: notifyDirector,
  });
}
