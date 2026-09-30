/**
 * One-shot / on-demand ingest of staff forum topic history into learning.
 * Does not blast RFQ — only logs coaching and quietly applies ops when uuid is clear.
 */
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { Api } from "telegram";
import type { TelegramClient } from "telegram";
import { readBigIntFromBuffer } from "telegram/Helpers";
import {
  claimStaffMessage,
  escalationChatId,
  extractForumThreadIds,
  managementBotUserId,
  shouldIgnoreStaffInbound,
} from "./staffListen";
import { parseStaffPeerIntent, staffTrainingKind } from "./staffPeer";
import {
  ensureStaffTopics,
  getStaffTopicMap,
  resolveTopicKindByThreadId,
  type StaffTopicKind,
} from "./staffTopics";

function historyEnabled(): boolean {
  const v = (process.env.TG_STAFF_HISTORY_INGEST || "on").toLowerCase().trim();
  return !["0", "false", "off", "no"].includes(v);
}

function historyLimit(): number {
  const n = Number(process.env.TG_STAFF_HISTORY_LIMIT || "300");
  return Number.isFinite(n) && n > 0 ? Math.min(1000, Math.floor(n)) : 300;
}

function markerPath(): string {
  const base =
    (process.env.DATA_DIR || "").trim() ||
    join(process.cwd(), "data");
  try {
    mkdirSync(base, { recursive: true });
  } catch {
    /* ignore */
  }
  return join(base, "staff-history-ingest.flag");
}

export function hasBootHistoryIngestRan(): boolean {
  try {
    return existsSync(markerPath());
  } catch {
    return false;
  }
}

function markBootHistoryIngestRan(): void {
  try {
    writeFileSync(
      markerPath(),
      JSON.stringify({ at: new Date().toISOString(), chat: escalationChatId() }),
      "utf8"
    );
  } catch (err) {
    console.warn("[staff-history] marker write failed", err);
  }
}

function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const token = (process.env.INTERNAL_API_TOKEN || "").trim();
  const headers = new Headers(init?.headers);
  if (token && !headers.has("x-internal-token")) {
    headers.set("x-internal-token", token);
  }
  return fetch(url, { ...init, headers });
}

type IngestStats = {
  topics: number;
  scanned: number;
  logged: number;
  skipped: number;
};

async function fetchTopicHistory(
  client: TelegramClient,
  chatId: number,
  topicId: number,
  limit: number
): Promise<
  Array<{
    id: number;
    text: string;
    userId?: number;
    fromUsername?: string;
    fromName?: string;
    replyText?: string;
    messageThreadId?: number;
    replyToMessageId?: number;
    isBot?: boolean;
  }>
> {
  const entity = await client.getInputEntity(chatId);
  const out: Array<{
    id: number;
    text: string;
    userId?: number;
    fromUsername?: string;
    fromName?: string;
    replyText?: string;
    messageThreadId?: number;
    replyToMessageId?: number;
    isBot?: boolean;
  }> = [];

  let offsetId = 0;
  const botId = managementBotUserId();
  while (out.length < limit) {
    const batch = Math.min(100, limit - out.length);
    let res: {
      messages?: Api.TypeMessage[];
      users?: Api.TypeUser[];
      count?: number;
    };
    try {
      res = await client.invoke(
        new Api.messages.GetReplies({
          peer: entity,
          msgId: topicId,
          offsetId,
          offsetDate: 0,
          addOffset: 0,
          limit: batch,
          maxId: 0,
          minId: 0,
          hash: bigIntZero(),
        })
      );
    } catch (err) {
      // Non-forum or topic-root missing — try plain history once
      if (out.length === 0 && offsetId === 0) {
        console.warn(
          "[staff-history] GetReplies failed, fallback GetHistory",
          topicId,
          err instanceof Error ? err.message : err
        );
        try {
          res = await client.invoke(
            new Api.messages.GetHistory({
              peer: entity,
              offsetId: 0,
              offsetDate: 0,
              addOffset: 0,
              limit: batch,
              maxId: 0,
              minId: 0,
              hash: bigIntZero(),
            })
          );
        } catch (err2) {
          throw err2;
        }
      } else {
        throw err;
      }
    }
    const messages =
      res && typeof res === "object" && "messages" in res
        ? ((res as { messages: Api.TypeMessage[] }).messages || [])
        : [];
    if (!messages.length) break;

    const users = new Map<number, Api.User>();
    if ("users" in res && Array.isArray((res as { users: unknown[] }).users)) {
      for (const u of (res as { users: Api.TypeUser[] }).users) {
        if (u instanceof Api.User) users.set(Number(u.id), u);
      }
    }

    // API returns newest first — we reverse later
    let minId = Number.POSITIVE_INFINITY;
    for (const m of messages) {
      if (!(m instanceof Api.Message)) continue;
      const id = Number(m.id);
      if (id < minId) minId = id;
      const text = String(m.message || "").trim();
      if (!text) continue;
      const fromId = m.fromId && "userId" in m.fromId ? Number(m.fromId.userId) : undefined;
      const user = fromId ? users.get(fromId) : undefined;
      const thread = extractForumThreadIds(m as never);
      out.push({
        id,
        text,
        userId: fromId,
        fromUsername: user?.username || undefined,
        fromName: [user?.firstName, user?.lastName].filter(Boolean).join(" ") || undefined,
        messageThreadId: thread.messageThreadId || topicId,
        replyToMessageId: thread.replyToMessageId,
        isBot: Boolean(user?.bot) || (botId > 0 && fromId === botId),
      });
    }
    if (messages.length < batch || !Number.isFinite(minId)) break;
    offsetId = minId;
    if (offsetId <= 0) break;
  }

  // oldest → newest
  out.sort((a, b) => a.id - b.id);
  return out;
}

function bigIntZero() {
  return readBigIntFromBuffer(Buffer.alloc(8), true, false);
}

/**
 * Ingest history from all known staff topics into learning_events.
 * `force` ignores the boot marker (used by /staff_sync).
 */
export async function runStaffHistoryIngest(opts: {
  client: TelegramClient;
  apiBase: string;
  force?: boolean;
  bot?: { api: { sendMessage: (chatId: number | string, text: string, extra?: object) => Promise<unknown> } } | null;
}): Promise<IngestStats> {
  const stats: IngestStats = { topics: 0, scanned: 0, logged: 0, skipped: 0 };
  if (!historyEnabled() && !opts.force) {
    console.log("[staff-history] ingest disabled");
    return stats;
  }
  if (!opts.force && hasBootHistoryIngestRan()) {
    console.log("[staff-history] boot ingest already done — use /staff_sync");
    return stats;
  }

  const chatId = escalationChatId();
  if (!chatId) {
    console.warn("[staff-history] no staff chat id");
    return stats;
  }

  await ensureStaffTopics({ client: opts.client, bot: null });
  const map = getStaffTopicMap();

  // Also ingest any other forum topics present in the group (not only the fixed 4).
  const chatId2 = chatId;
  let extraTopics: Array<{ id: number; title: string; kind?: StaffTopicKind }> = [];
  try {
    const { listAllStaffForumTopics } = await import("./staffTopics");
    extraTopics = (await listAllStaffForumTopics(opts.client, chatId2)).map((t) => ({
      ...t,
      kind: resolveTopicKindByThreadId(t.id),
    }));
  } catch (err) {
    console.warn("[staff-history] list all topics failed", err);
  }

  const toScan = new Map<number, { id: number; kind?: StaffTopicKind; title?: string }>();
  for (const [kind, topicId] of map.entries()) {
    toScan.set(topicId, { id: topicId, kind });
  }
  for (const t of extraTopics) {
    if (!toScan.has(t.id)) toScan.set(t.id, { id: t.id, kind: t.kind, title: t.title });
  }

  if (!toScan.size) {
    console.warn("[staff-history] no topics mapped");
    return stats;
  }

  const limit = historyLimit();
  const apiBase = opts.apiBase.replace(/\/$/, "");

  for (const topic of toScan.values()) {
    const topicId = topic.id;
    const kind = topic.kind;
    stats.topics += 1;
    let messages: Awaited<ReturnType<typeof fetchTopicHistory>> = [];
    try {
      messages = await fetchTopicHistory(opts.client, chatId, topicId, limit);
    } catch (err) {
      console.warn("[staff-history] topic fetch failed", kind || topic.title, topicId, err);
      continue;
    }

    for (const m of messages) {
      stats.scanned += 1;
      if (m.isBot) {
        stats.skipped += 1;
        continue;
      }
      if (shouldIgnoreStaffInbound(m.text, chatId)) {
        stats.skipped += 1;
        continue;
      }
      if (m.text.startsWith("/")) {
        stats.skipped += 1;
        continue;
      }
      // Soft dedupe by message id (same process); DB may still get duplicates across restarts — API insert is append-only
      if (!claimStaffMessage(chatId, m.id, "history")) {
        stats.skipped += 1;
        continue;
      }

      const peerReq = parseStaffPeerIntent(m.text, {
        replyText: m.replyText,
      });
      const trainKind = staffTrainingKind(peerReq);
      const dealMatch = `${m.text}\n${m.replyText || ""}`.match(
        /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i
      );
      const topicKind: StaffTopicKind | undefined =
        resolveTopicKindByThreadId(m.messageThreadId) || kind;

      // Pin durable coaching from history when clearly instructional
      const pin =
        trainKind === "coach" &&
        !dealMatch &&
        /всегда|никогда|не\s*пиши|не\s*говори|запомни|учти|сначала спроси|клиенту не/i.test(
          m.text
        );

      try {
        await apiFetch(`${apiBase}/internal/learning`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deal_id: dealMatch?.[1]?.toLowerCase() || null,
            event_type: "staff_room_training",
            payload: {
              text: m.text.slice(0, 4000),
              kind: trainKind,
              intent: peerReq.intent,
              chat_id: chatId,
              from_id: m.userId,
              from_username: m.fromUsername,
              from_name: m.fromName,
              message_id: m.id,
              message_thread_id: m.messageThreadId || topicId,
              topic_kind: topicKind || null,
              topic_title: topic.title || null,
              source: "history",
              room: "staff",
              reply_text: m.replyText?.slice(0, 500) || null,
              scoped: Boolean(dealMatch?.[1]),
              pinned: pin,
              ingest: true,
            },
          }),
        });
        stats.logged += 1;
      } catch (err) {
        console.warn("[staff-history] learning post failed", err);
        stats.skipped += 1;
      }
    }
  }

  if (!opts.force) markBootHistoryIngestRan();
  else {
    // Force sync also refreshes marker
    markBootHistoryIngestRan();
  }

  console.log("[staff-history] ingest done", stats);
  return stats;
}

/** Read marker timestamp for status replies. */
export function staffHistoryMarkerInfo(): string {
  try {
    const raw = readFileSync(markerPath(), "utf8");
    const j = JSON.parse(raw) as { at?: string };
    return j.at || "yes";
  } catch {
    return "never";
  }
}
