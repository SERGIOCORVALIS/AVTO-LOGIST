import { Bot } from "grammy";

let bot: Bot | null = null;

function getBot(): Bot | null {
  if (!process.env.TG_BOT_TOKEN) return null;
  if (!bot) bot = new Bot(process.env.TG_BOT_TOKEN);
  return bot;
}

async function sendToChat(chatId: string, text: string): Promise<void> {
  const b = getBot();
  if (!b) {
    console.log(`[tg-chat:dev] ${chatId}\n${text}`);
    return;
  }
  await b.api.sendMessage(chatId, text.slice(0, 4000));
}

export async function postToExecutiveChannel(text: string): Promise<void> {
  const channelId = process.env.TG_EXEC_CHANNEL_ID;
  if (!channelId) {
    console.log(`[exec-channel:dev]\n${text}`);
    return;
  }
  await sendToChat(channelId, text);
}

/** Dedicated manager escalation chat (group/supergroup), falls back to exec channel */
export async function postEscalation(text: string): Promise<void> {
  const esc =
    process.env.TG_ESCALATION_CHAT_ID || process.env.TG_EXEC_CHANNEL_ID;
  if (!esc) {
    console.log(`[escalation-chat:dev]\n${text}`);
    return;
  }
  await sendToChat(esc, text);
  // also mirror to exec channel if different
  if (
    process.env.TG_EXEC_CHANNEL_ID &&
    process.env.TG_ESCALATION_CHAT_ID &&
    process.env.TG_EXEC_CHANNEL_ID !== process.env.TG_ESCALATION_CHAT_ID
  ) {
    await postToExecutiveChannel(`(mirror escalation)\n${text}`);
  }
}
