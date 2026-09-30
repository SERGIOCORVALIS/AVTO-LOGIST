/**
 * Fixed forum topics for the staff room (TG_STAFF_CHAT_ID).
 * Catalog: Общее / Эскалации / RFQ / Обучение.
 */
import type { Bot } from "grammy";
import { Api } from "telegram";
import type { TelegramClient } from "telegram";
import { generateRandomBigInt } from "telegram/Helpers";
import { escalationChatId } from "./staffListen";
import type { StaffIntent } from "./staffPeer";

export type StaffTopicKind = "general" | "escalations" | "rfq" | "coaching";

export const STAFF_TOPIC_TITLES: Record<StaffTopicKind, string> = {
  general: "Общее",
  escalations: "Эскалации",
  rfq: "RFQ",
  coaching: "Обучение",
};

const KIND_ORDER: StaffTopicKind[] = ["general", "escalations", "rfq", "coaching"];

const topicIds = new Map<StaffTopicKind, number>();
let forumReady = false;
let ensurePromise: Promise<Map<StaffTopicKind, number>> | null = null;

function forumEnabled(): boolean {
  const v = (process.env.TG_STAFF_FORUM || "on").toLowerCase().trim();
  return !["0", "false", "off", "no"].includes(v);
}

function envTopicId(kind: StaffTopicKind): number | null {
  const key =
    kind === "general"
      ? "TG_STAFF_TOPIC_GENERAL"
      : kind === "escalations"
        ? "TG_STAFF_TOPIC_ESCALATIONS"
        : kind === "rfq"
          ? "TG_STAFF_TOPIC_RFQ"
          : "TG_STAFF_TOPIC_COACHING";
  const raw = (process.env[key] || "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeTitle(s: string): string {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Map outbound channel job kind → fixed topic. */
export function topicKindForOutbound(
  kind: string
): StaffTopicKind {
  const k = (kind || "info").toLowerCase();
  if (k === "alert") return "escalations";
  if (k === "learning") return "coaching";
  if (k === "ops" || k === "rfq") return "rfq";
  return "general";
}

/** Map staff peer intent → preferred reply topic (when inbound has no thread). */
export function topicKindForIntent(intent: StaffIntent | string): StaffTopicKind {
  switch (intent) {
    case "escalations":
    case "approve_kp":
    case "reject_deal":
    case "takeover":
    case "pause":
    case "resume":
    case "cut3":
      return "escalations";
    case "ops_hint":
    case "approve_rfq":
      return "rfq";
    case "answer":
    case "observe":
    case "help":
      return "coaching";
    case "status":
    case "awaiting":
    case "deal_card":
    case "set_active":
    default:
      return "general";
  }
}

export function getStaffTopicId(kind: StaffTopicKind): number | undefined {
  const fromEnv = envTopicId(kind);
  if (fromEnv) return fromEnv;
  return topicIds.get(kind);
}

export function getStaffTopicMap(): Map<StaffTopicKind, number> {
  const out = new Map<StaffTopicKind, number>();
  for (const kind of KIND_ORDER) {
    const id = getStaffTopicId(kind);
    if (id) out.set(kind, id);
  }
  return out;
}

export function resolveTopicKindByThreadId(
  threadId: number | undefined | null
): StaffTopicKind | undefined {
  if (!threadId) return undefined;
  for (const kind of KIND_ORDER) {
    if (getStaffTopicId(kind) === threadId) return kind;
  }
  // Telegram General topic is usually 1
  if (threadId === 1) return "general";
  return undefined;
}

export function isStaffForumReady(): boolean {
  return forumReady && getStaffTopicMap().size > 0;
}

async function listForumTopics(
  client: TelegramClient,
  chatId: number
): Promise<Array<{ id: number; title: string }>> {
  const entity = await client.getInputEntity(chatId);
  const out: Array<{ id: number; title: string }> = [];
  let offsetTopic = 0;
  let offsetId = 0;
  let offsetDate = 0;
  for (let page = 0; page < 20; page++) {
    const res = await client.invoke(
      new Api.channels.GetForumTopics({
        channel: entity as unknown as Api.TypeInputChannel,
        offsetDate,
        offsetId,
        offsetTopic,
        limit: 100,
      })
    );
    const topics = (res as { topics?: Api.TypeForumTopic[] }).topics || [];
    if (!topics.length) break;
    for (const t of topics) {
      if (t instanceof Api.ForumTopic) {
        out.push({ id: Number(t.id), title: String(t.title || "") });
        offsetTopic = Number(t.id);
        offsetId = Number(t.topMessage || 0);
        offsetDate = Number(t.date || 0);
      }
    }
    const count = Number((res as { count?: number }).count || out.length);
    if (out.length >= count || topics.length < 100) break;
  }
  return out;
}

/** Public: list every forum topic in the staff chat. */
export async function listAllStaffForumTopics(
  client: TelegramClient,
  chatId?: number
): Promise<Array<{ id: number; title: string }>> {
  const id = chatId ?? escalationChatId();
  if (!id) return [];
  return listForumTopics(client, id);
}

async function createTopicViaBot(
  bot: Bot,
  chatId: number,
  title: string
): Promise<number | null> {
  try {
    const topic = await bot.api.createForumTopic(chatId, title);
    const id = Number(
      (topic as { message_thread_id?: number }).message_thread_id ??
        (topic as { messageThreadId?: number }).messageThreadId
    );
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch (err) {
    console.warn("[staff-topics] createForumTopic failed", title, err);
    return null;
  }
}

async function createTopicViaUser(
  client: TelegramClient,
  chatId: number,
  title: string
): Promise<number | null> {
  try {
    const entity = await client.getInputEntity(chatId);
    const randomId = generateRandomBigInt();
    const updates = await client.invoke(
      new Api.channels.CreateForumTopic({
        channel: entity as unknown as Api.TypeInputChannel,
        title,
        randomId,
      })
    );
    const updList =
      updates && typeof updates === "object" && "updates" in updates
        ? ((updates as { updates: unknown[] }).updates || [])
        : [];
    for (const u of updList) {
      if (u instanceof Api.UpdateNewChannelMessage && u.message) {
        const msg = u.message as { id?: number; action?: { className?: string; title?: string } };
        if (msg.action && String(msg.action.className || "").includes("Topic")) {
          return Number(msg.id);
        }
      }
    }
    // Fallback: re-list and find by title
    const listed = await listForumTopics(client, chatId);
    const hit = listed.find((t) => normalizeTitle(t.title) === normalizeTitle(title));
    return hit?.id ?? null;
  } catch (err) {
    console.warn("[staff-topics] CreateForumTopic (user) failed", title, err);
    return null;
  }
}

async function ensureForumEnabled(
  client: TelegramClient,
  chatId: number
): Promise<boolean> {
  try {
    const entity = await client.getEntity(chatId);
    const forum =
      entity && typeof entity === "object" && "forum" in entity
        ? Boolean((entity as { forum?: boolean }).forum)
        : false;
    if (forum) {
      console.log("[staff-topics] forum already enabled", { chatId });
      return true;
    }
    console.log("[staff-topics] enabling forum topics…", { chatId });
    await client.invoke(
      new Api.channels.ToggleForum({
        channel: chatId,
        enabled: true,
      })
    );
    console.log("[staff-topics] forum enabled");
    return true;
  } catch (err) {
    console.warn(
      "[staff-topics] ToggleForum failed — enable Topics manually in Telegram group settings",
      err instanceof Error ? err.message : err
    );
    return false;
  }
}

/**
 * Ensure fixed staff topics exist. Uses env overrides, then GramJS list, then create.
 */
export async function ensureStaffTopics(opts: {
  bot?: Bot | null;
  client?: TelegramClient | null;
}): Promise<Map<StaffTopicKind, number>> {
  if (!forumEnabled()) {
    console.log("[staff-topics] TG_STAFF_FORUM=off — skip");
    return getStaffTopicMap();
  }
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    const chatId = escalationChatId();
    if (!chatId) {
      console.warn("[staff-topics] staff chat id unset");
      return getStaffTopicMap();
    }

    // Seed from env
    for (const kind of KIND_ORDER) {
      const envId = envTopicId(kind);
      if (envId) topicIds.set(kind, envId);
    }

    let listed: Array<{ id: number; title: string }> = [];
    if (opts.client) {
      await ensureForumEnabled(opts.client, chatId);
      try {
        listed = await listForumTopics(opts.client, chatId);
        console.log("[staff-topics] listed topics", {
          chatId,
          count: listed.length,
          titles: listed.map((t) => t.title),
        });
      } catch (err) {
        console.warn(
          "[staff-topics] GetForumTopics failed — retry after ToggleForum",
          err instanceof Error ? err.message : err
        );
        await ensureForumEnabled(opts.client, chatId);
        try {
          listed = await listForumTopics(opts.client, chatId);
        } catch (err2) {
          console.warn(
            "[staff-topics] GetForumTopics still failing — grant manage_topics / enable Topics",
            err2 instanceof Error ? err2.message : err2
          );
          forumReady = topicIds.size > 0;
          return getStaffTopicMap();
        }
      }
    }

    const byTitle = new Map(
      listed.map((t) => [normalizeTitle(t.title), t.id] as const)
    );

    for (const kind of KIND_ORDER) {
      if (topicIds.has(kind)) continue;
      const title = STAFF_TOPIC_TITLES[kind];
      const existing = byTitle.get(normalizeTitle(title));
      if (existing) {
        topicIds.set(kind, existing);
        continue;
      }
      // Aliases
      const aliases: Record<StaffTopicKind, string[]> = {
        general: ["общее", "general", "general topic"],
        escalations: [
          "эскалации",
          "escalations",
          "alerts",
          "эскалация решение задачи вместе с человеком",
          "заказы которые перешли в ручной режим",
        ],
        rfq: ["rfq", "ставки", "запросы"],
        coaching: ["обучение", "coaching", "training"],
      };
      let found: number | undefined;
      for (const a of aliases[kind]) {
        const id = byTitle.get(a);
        if (id) {
          found = id;
          break;
        }
      }
      if (found) {
        topicIds.set(kind, found);
        continue;
      }

      let created: number | null = null;
      // Prefer user session (bot often lacks manage_topics).
      if (opts.client) {
        created = await createTopicViaUser(opts.client, chatId, title);
      }
      if (!created && opts.bot) {
        created = await createTopicViaBot(opts.bot, chatId, title);
      }
      if (created) {
        topicIds.set(kind, created);
        byTitle.set(normalizeTitle(title), created);
        console.log("[staff-topics] created topic", { kind, title, id: created });
      } else {
        console.warn("[staff-topics] missing topic", { kind, title });
      }
    }

    forumReady = topicIds.size > 0;
    console.log(
      "[staff-topics] ready",
      Object.fromEntries([...getStaffTopicMap().entries()])
    );
    return getStaffTopicMap();
  })();

  try {
    return await ensurePromise;
  } finally {
    // Allow retry after failure (empty map)
    if (!forumReady) ensurePromise = null;
  }
}

const ENV_TOPIC_KEYS: Record<StaffTopicKind, string> = {
  general: "TG_STAFF_TOPIC_GENERAL",
  escalations: "TG_STAFF_TOPIC_ESCALATIONS",
  rfq: "TG_STAFF_TOPIC_RFQ",
  coaching: "TG_STAFF_TOPIC_COACHING",
};

/** Upsert TG_STAFF_TOPIC_* lines into a .env file text. */
export function applyTopicIdsToEnvText(envText: string, map: Map<StaffTopicKind, number>): string {
  let out = envText;
  for (const kind of KIND_ORDER) {
    const id = map.get(kind);
    if (!id) continue;
    const key = ENV_TOPIC_KEYS[kind];
    const line = `${key}=${id}`;
    const re = new RegExp(`^#?\\s*${key}=.*$`, "m");
    if (re.test(out)) {
      out = out.replace(re, line);
    } else {
      out = out.trimEnd() + `\n${line}\n`;
    }
  }
  return out;
}

/** Pick thread id for an outbound staff post. */
export function threadIdForOutbound(kind: string): number | undefined {
  return getStaffTopicId(topicKindForOutbound(kind));
}

/** Prefer inbound thread; else map intent → fixed topic. */
export function threadIdForReply(opts: {
  inboundThreadId?: number;
  intent?: StaffIntent | string;
}): number | undefined {
  if (opts.inboundThreadId && opts.inboundThreadId > 0) return opts.inboundThreadId;
  if (opts.intent) return getStaffTopicId(topicKindForIntent(opts.intent));
  return getStaffTopicId("general");
}
