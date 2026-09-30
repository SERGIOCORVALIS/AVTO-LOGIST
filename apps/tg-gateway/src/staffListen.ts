/**
 * Staff room listener (managers coach the robot + approve actions).
 * Env: TG_STAFF_CHAT_ID or TG_ESCALATION_CHAT_ID (same chat).
 * Telegram bots with privacy mode ON miss free-text group messages unless
 * @mentioned / replied — the user (MTProto) account always hears the room;
 * we bridge into staff-peer handling and reply via the bot API.
 */
import { createHash } from "crypto";
import { Api } from "telegram";
import type { TelegramClient } from "telegram";
import { NewMessage } from "telegram/events";
import {
  composeInboundText,
  describeInboundMedia,
  downloadInboundMedia,
} from "./media";

export type StaffGroupInbound = {
  chatId: number;
  userId?: number;
  messageId?: number;
  /** Forum topic id (message_thread_id). */
  messageThreadId?: number;
  replyToMessageId?: number;
  text: string;
  replyText?: string;
  fromUsername?: string;
  fromName?: string;
  source: "bot" | "user";
};

/** Extract forum topic / reply ids from a GramJS message. */
export function extractForumThreadIds(message: {
  id?: number;
  replyTo?: {
    replyToMsgId?: number;
    replyToTopId?: number;
    forumTopic?: boolean;
  } | null;
}): { messageThreadId?: number; replyToMessageId?: number } {
  const replyTo = message.replyTo;
  if (!replyTo) return {};
  const replyToMessageId = Number(replyTo.replyToMsgId || 0) || undefined;
  // In forums, replyToTopId is the topic root; if missing but forumTopic, replyToMsgId is the topic.
  let messageThreadId = Number(replyTo.replyToTopId || 0) || undefined;
  if (!messageThreadId && replyTo.forumTopic && replyToMessageId) {
    messageThreadId = replyToMessageId;
  }
  return { messageThreadId, replyToMessageId };
}

type StaffDispatcher = (msg: StaffGroupInbound) => Promise<void>;

let dispatcher: StaffDispatcher | null = null;
const seenMsg = new Map<string, number>();
const seenText = new Map<string, number>();
const recentOut = new Map<string, number>();
const SEEN_TTL_MS = 180_000;
const TEXT_DEDUP_MS = 45_000;
const OUT_TTL_MS = 180_000;

/** Our own bot replies — never treat as manager coaching. */
const SELF_REPLY_RE =
  /^(подсказку поняла|поняла[,.]?\s*учту|слушаю группу|это не только эскалац|рабочая группа|сводка на сейчас|открытых эскалаций|сделку .+ не нашла|не до конца понял|сбой на моей стороне|ок,\s*(кп|активная)|rfq отправила|минус 3%|пауза ии|перехват включ|🤝|👂|🧪)/i;

export function setStaffGroupDispatcher(fn: StaffDispatcher | null): void {
  dispatcher = fn;
}

export function escalationChatId(): number | null {
  const raw = (
    process.env.TG_STAFF_CHAT_ID ||
    process.env.TG_ESCALATION_CHAT_ID ||
    ""
  ).trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/** Normalize Bot API (-100…) vs MTProto peer id so staff room matches. */
export function sameStaffChat(a: number, b: number): boolean {
  if (a === b) return true;
  const na = Math.abs(a);
  const nb = Math.abs(b);
  if (na === nb) return true;
  // -100xxxxxxxxxx (Bot API) vs xxxxxxxxxx (sometimes from GramJS)
  const strip = (n: number) => {
    const s = String(Math.abs(n));
    if (s.startsWith("100") && s.length > 10) return s.slice(3);
    return s;
  };
  return strip(a) === strip(b);
}

export function managementBotUserId(): number {
  const token = process.env.TG_BOT_TOKEN || "";
  const n = Number(token.split(":")[0]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function pruneMap(map: Map<string, number>, now: number, ttl: number): void {
  for (const [k, ts] of map) {
    if (now - ts > ttl) map.delete(k);
  }
}

function textFingerprint(chatId: number, text: string): string {
  const norm = text.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 800);
  const h = createHash("sha1").update(norm).digest("hex").slice(0, 16);
  return `${chatId}:t:${h}`;
}

/** Returns true if this message was already claimed (dedupe bot ↔ user bridge). */
export function claimStaffMessage(
  chatId: number,
  messageId: number | undefined,
  source: string
): boolean {
  if (!messageId) return true;
  const now = Date.now();
  pruneMap(seenMsg, now, SEEN_TTL_MS);
  const key = `${chatId}:${messageId}`;
  if (seenMsg.has(key)) {
    console.log(`[staff-listen] dedupe skip source=${source} key=${key}`);
    return false;
  }
  seenMsg.set(key, now);
  return true;
}

/** Same inbound text in a short window → skip (update replay / double handler). */
export function claimStaffText(chatId: number, text: string, source: string): boolean {
  const now = Date.now();
  pruneMap(seenText, now, TEXT_DEDUP_MS);
  const key = textFingerprint(chatId, text);
  if (seenText.has(key)) {
    console.log(`[staff-listen] text-dedupe skip source=${source}`);
    return false;
  }
  seenText.set(key, now);
  return true;
}

/** Remember outbound bot text so user-bridge never re-ingests our own replies. */
export function rememberStaffOutbound(chatId: number, text: string): void {
  const now = Date.now();
  pruneMap(recentOut, now, OUT_TTL_MS);
  recentOut.set(textFingerprint(chatId, text), now);
}

function isRecentOutbound(chatId: number, text: string): boolean {
  pruneMap(recentOut, Date.now(), OUT_TTL_MS);
  return recentOut.has(textFingerprint(chatId, text));
}

export function shouldIgnoreStaffInbound(text: string, chatId: number): boolean {
  const t = text.trim();
  if (!t) return true;
  if (SELF_REPLY_RE.test(t)) return true;
  if (isRecentOutbound(chatId, t)) return true;
  return false;
}

export async function dispatchStaffGroup(msg: StaffGroupInbound): Promise<void> {
  if (!dispatcher) {
    console.warn("[staff-listen] no dispatcher yet", {
      chatId: msg.chatId,
      source: msg.source,
    });
    return;
  }
  if (shouldIgnoreStaffInbound(msg.text, msg.chatId)) {
    console.log("[staff-listen] ignore self/empty inbound", {
      source: msg.source,
      len: msg.text.length,
    });
    return;
  }
  if (!claimStaffMessage(msg.chatId, msg.messageId, msg.source)) return;
  if (!claimStaffText(msg.chatId, msg.text, msg.source)) return;
  await dispatcher(msg);
}

function isBotSender(sender: unknown, botId: number): boolean {
  if (!sender) return false;
  if (sender instanceof Api.User) {
    if (sender.bot) return true;
    if (botId && Number(sender.id) === botId) return true;
  }
  return false;
}

export function attachStaffGroupUserListen(client: TelegramClient): void {
  const esc = escalationChatId();
  if (!esc) {
    console.warn("[staff-listen] TG_STAFF_CHAT_ID / TG_ESCALATION_CHAT_ID unset — user bridge off");
    return;
  }
  const botId = managementBotUserId();
  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message || message.out) return;
      const chatId = Number(message.chatId);
      if (!sameStaffChat(chatId, esc)) return;

      const sender = await message.getSender().catch(() => null);
      if (isBotSender(sender, botId)) return;
      // Extra: peer id on message when getSender is empty
      try {
        const fromId = (message as { fromId?: { userId?: unknown } }).fromId;
        const uid = fromId && "userId" in fromId ? Number(fromId.userId) : 0;
        if (botId && uid === botId) return;
      } catch {
        /* ignore */
      }

      const caption = String(message.message || "").trim();
      if (caption.startsWith("/")) return;

      let text = caption;
      try {
        const media = await downloadInboundMedia(client, message);
        if (media && (media.kind === "voice" || media.kind === "audio")) {
          const extracted = await describeInboundMedia(media);
          text = composeInboundText({
            caption,
            media,
            extracted,
            audience: "staff",
          }).trim();
          console.log("[staff-listen] voice/audio", {
            kind: media.kind,
            bytes: media.buffer.length,
            transcribed: Boolean(extracted),
            chars: text.length,
          });
        } else if (!text) {
          return;
        }
      } catch (err) {
        console.warn(
          "[staff-listen] media failed",
          err instanceof Error ? err.message : err
        );
        if (!text) return;
      }

      if (!text) return;
      if (shouldIgnoreStaffInbound(text, esc)) return;

      let replyText: string | undefined;
      try {
        const replied = await message.getReplyMessage();
        if (replied && "message" in replied && replied.message) {
          replyText = String(replied.message);
        }
      } catch {
        /* ignore */
      }

      const thread = extractForumThreadIds(
        message as {
          id?: number;
          replyTo?: {
            replyToMsgId?: number;
            replyToTopId?: number;
            forumTopic?: boolean;
          } | null;
        }
      );

      const userId =
        sender && typeof sender === "object" && "id" in sender
          ? Number((sender as { id: unknown }).id)
          : undefined;
      const fromUsername =
        sender && typeof sender === "object" && "username" in sender
          ? String((sender as { username?: string }).username || "") || undefined
          : undefined;
      const fromName =
        sender && typeof sender === "object" && "firstName" in sender
          ? [
              String((sender as { firstName?: string }).firstName || ""),
              String((sender as { lastName?: string }).lastName || ""),
            ]
              .filter(Boolean)
              .join(" ") || undefined
          : undefined;

      console.log("[staff-listen] user-bridge message", {
        chatId: esc,
        mtprotoChatId: chatId,
        userId,
        messageId: message.id,
        messageThreadId: thread.messageThreadId,
        len: text.length,
      });
      // Use configured Bot API chat id so replies go to the right room.
      await dispatchStaffGroup({
        chatId: esc,
        userId,
        messageId: message.id,
        messageThreadId: thread.messageThreadId,
        replyToMessageId: thread.replyToMessageId,
        text,
        replyText,
        fromUsername,
        fromName,
        source: "user",
      });
    } catch (err) {
      console.error("[staff-listen] user bridge failed", err);
    }
  }, new NewMessage({}));
  console.log(`[staff-listen] user bridge armed for staff room ${esc}`);
}
