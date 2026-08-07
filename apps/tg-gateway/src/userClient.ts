import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import { Api } from "telegram";

export interface InboundMsg {
  chatId: number;
  userId?: number;
  messageId?: number;
  text: string;
  clientName?: string;
}

export async function startUserClient(opts: {
  onInbound: (msg: InboundMsg) => Promise<void>;
}): Promise<(chatId: number, text: string) => Promise<void>> {
  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH || "";
  const session = new StringSession(process.env.TG_STRING_SESSION || "");

  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  if (!(await client.checkAuthorization())) {
    throw new Error(
      "TG session not authorized. Run: pnpm --filter @alo/tg-gateway login"
    );
  }

  client.addEventHandler(async (event) => {
    const message = event.message;
    if (!message || message.out) return;
    const text = message.message?.trim();
    if (!text) return;
    const chatId = Number(message.chatId);
    const sender = await message.getSender();
    const userId =
      sender && "id" in sender ? Number((sender as { id: unknown }).id) : undefined;
    const clientName =
      sender && "firstName" in sender
        ? String((sender as { firstName?: string }).firstName || "")
        : undefined;

    // mark typing for human feel
    try {
      await client.invoke(
        new Api.messages.SetTyping({
          peer: chatId,
          action: new Api.SendMessageTypingAction(),
        })
      );
    } catch {
      /* ignore */
    }

    await opts.onInbound({
      chatId,
      userId,
      messageId: message.id,
      text,
      clientName,
    });
  }, new NewMessage({}));

  return async (chatId: number, text: string) => {
    await client.sendMessage(chatId, { message: text });
  };
}
