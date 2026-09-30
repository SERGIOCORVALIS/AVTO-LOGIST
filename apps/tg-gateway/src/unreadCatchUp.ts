import { TelegramClient } from "telegram";
import { Api } from "telegram";
import type { Entity } from "telegram/define";
import type { InboundMsg } from "./userClient";
import { isPrivateUserChat, shouldIgnoreInbound } from "./dedupe";
import { downloadInboundMedia } from "./media";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function peerChatId(entity: Entity | undefined): number | null {
  if (!entity) return null;
  if (entity instanceof Api.User) {
    const id = Number(entity.id);
    return isPrivateUserChat(id) ? id : null;
  }
  return null;
}

export async function processTelegramMessage(
  client: TelegramClient,
  message: Api.Message,
  onInbound: (msg: InboundMsg) => Promise<void>,
  opts?: { typing?: boolean }
): Promise<boolean> {
  if (!message || message.out) return false;
  const chatIdRaw = Number(message.chatId);
  if (!isPrivateUserChat(chatIdRaw)) return false;
  const text = message.message?.trim() || "";
  const media = await downloadInboundMedia(client, message);
  if (!text && !media) return false;

  if (opts?.typing !== false) {
    try {
      await client.invoke(
        new Api.messages.SetTyping({
          peer: chatIdRaw,
          action: new Api.SendMessageTypingAction(),
        })
      );
    } catch {
      /* ignore */
    }
  }

  const sender = await message.getSender();
  const userId =
    sender && "id" in sender ? Number((sender as { id: unknown }).id) : undefined;
  const clientName =
    sender && "firstName" in sender
      ? String((sender as { firstName?: string }).firstName || "")
      : undefined;

  await onInbound({
    chatId: chatIdRaw,
    userId,
    messageId: message.id,
    text,
    clientName,
    media: media || undefined,
  });
  return true;
}

export async function catchUpPrivateChats(opts: {
  client: TelegramClient;
  onInbound: (msg: InboundMsg) => Promise<void>;
  skipBotId?: number;
  blockedChatIds?: Array<string | number | undefined>;
  maxDialogs?: number;
  delayMs?: number;
}): Promise<{ scanned: number; enqueued: number }> {
  const dialogs = await opts.client.getDialogs({ limit: opts.maxDialogs ?? 150 });
  let enqueued = 0;
  for (const dialog of dialogs) {
    const chatId = peerChatId(dialog.entity);
    if (
      !chatId ||
      shouldIgnoreInbound({
        chatId,
        skipBotId: opts.skipBotId,
        blockedChatIds: opts.blockedChatIds,
      })
    ) {
      continue;
    }
    const unread = Number(dialog.unreadCount || 0);
    const limit = unread > 0 ? Math.min(unread + 5, 80) : 0;
    if (!limit) continue;

    const entity = dialog.inputEntity || dialog.entity;
    if (!entity) continue;

    const batch = await opts.client.getMessages(entity, { limit });
    const inbound = batch.filter((m): m is Api.Message => m instanceof Api.Message && !m.out);
    inbound.sort((a, b) => Number(a.id) - Number(b.id));

    // One reply per chat on restart — process only the latest client message.
    const latest = inbound[inbound.length - 1];
    if (latest) {
      const ok = await processTelegramMessage(opts.client, latest, opts.onInbound, {
        typing: false,
      });
      if (ok) enqueued += 1;
    }

    if (unread > 0 && latest) {
      try {
        await opts.client.invoke(
          new Api.messages.ReadHistory({
            peer: entity,
            maxId: latest.id,
          })
        );
      } catch {
        /* ignore */
      }
    }
  }
  return { scanned: dialogs.length, enqueued };
}

export async function catchUpChatSince(opts: {
  client: TelegramClient;
  chatId: number;
  minMessageId?: number;
  onInbound: (msg: InboundMsg) => Promise<void>;
  delayMs?: number;
}): Promise<number> {
  const minId = Number(opts.minMessageId || 0);
  if (minId <= 0) return 0;
  const batch = await opts.client.getMessages(opts.chatId, {
    minId,
    limit: 80,
  });
  const inbound = batch.filter((m): m is Api.Message => m instanceof Api.Message && !m.out);
  inbound.sort((a, b) => Number(a.id) - Number(b.id));
  const fresh = inbound.filter((m) => Number(m.id) > minId);
  const latest = fresh[fresh.length - 1];
  if (!latest) return 0;
  const ok = await processTelegramMessage(opts.client, latest, opts.onInbound, {
    typing: false,
  });
  return ok ? 1 : 0;
}
