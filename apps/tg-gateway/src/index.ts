import {
  QUEUES,
  createLogger,
  dealSnippetFromRow,
  ensureLogTree,
  enforceLicense,
  escalationNeedsDirector,
  formatEscalationStaff,
  loadRootEnv,
  loadTgAccountsFromEnv,
  TgAccountRouter,
  loadAppProxy,
  loadMtProtoProxy,
  refreshPx6MtProtoFromApi,
  type DealSnippet,
} from "@alo/shared";
loadRootEnv();
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { startUserClient, type InboundMsg, type UserClientHandle } from "./userClient";
import { startManagementBot } from "./managementBot";
import { routeStaffChannelPost } from "./channel";
import { humanDelay, withinWorkHours, rateLimitOk } from "./antiBan";
import { composeInboundText, describeInboundMedia, type InboundMedia } from "./media";
import { channelJobId, isJobExistsError, shouldIgnoreInbound } from "./dedupe";
import { catchUpPrivateChats } from "./unreadCatchUp";
import { resumeOpenTelegramDeals, type OpenTelegramDeal } from "./resumeOpenDeals";

// Preload Doppler/env secrets if helper present
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../scripts/load-secrets.cjs");
} catch {
  /* optional */
}

const log = createLogger("gateway");
ensureLogTree();

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

const outboundQueue = new Queue(QUEUES.outbound, { connection });
const channelQueue = new Queue(QUEUES.channel, { connection });
const orchestrateQueue = new Queue(QUEUES.orchestrate, { connection });

type Sender = (chatId: number, text: string) => Promise<void>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function blockedChatIds(): Array<string | number | undefined> {
  return [
    process.env.TG_EXEC_CHANNEL_ID,
    process.env.TG_ESCALATION_CHAT_ID,
    process.env.TG_STAFF_CHAT_ID,
  ];
}

async function enqueueInbound(
  accId: string,
  msg: InboundMsg,
  text: string,
  apiBase: string,
  outboundQueue: Queue,
  channelQueue: Queue,
  idempotencyKey?: string
): Promise<void> {
  const payload = {
    type: "tg.inbound",
    chat_id: msg.chatId,
    user_id: msg.userId,
    message_id: msg.messageId,
    text,
    client_name: msg.clientName,
    timestamp: new Date().toISOString(),
    idempotency_key:
      idempotencyKey || jobKey("in", accId, msg.chatId, msg.messageId ?? Date.now()),
    account_id: accId,
    media:
      msg.media && msg.media.buffer.length <= 3_500_000
        ? {
            filename: msg.media.filename,
            content_type: msg.media.contentType,
            kind: msg.media.kind,
            content_base64: msg.media.buffer.toString("base64"),
          }
        : undefined,
  };
  try {
    await orchestrateQueue.add("inbound", payload, {
      jobId: payload.idempotency_key,
      removeOnComplete: 1000,
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
    });
  } catch (err) {
    if (isJobExistsError(err)) {
      log.info("inbound already queued", {
        jobId: payload.idempotency_key,
        chatId: msg.chatId,
      });
      return;
    }
    log.error("enqueue inbound failed, processing directly", {
      err: String(err),
      chatId: msg.chatId,
    });
    await processOrchestrateJob(apiBase, payload, outboundQueue, channelQueue);
  }
}

function jobKey(prefix: string, ...parts: Array<string | number | undefined>): string {
  return [prefix, ...parts.map((p) => String(p ?? "0"))].join("-").replace(/:/g, "-");
}

async function isMessageAlreadyProcessed(
  apiBase: string,
  chatId: number,
  messageId?: number
): Promise<boolean> {
  if (!messageId) return false;
  try {
    const res = await fetch(
      `${apiBase}/messages/telegram/exists?chat_id=${chatId}&tg_message_id=${messageId}`,
      { headers: internalApiHeaders() }
    );
    if (!res.ok) return false;
    const data = (await res.json()) as { exists?: boolean };
    return Boolean(data.exists);
  } catch {
    return false;
  }
}

async function handleInboundMessage(
  acc: { id: string },
  msg: InboundMsg,
  router: TgAccountRouter,
  apiBase: string,
  outboundQueue: Queue,
  channelQueue: Queue,
  skipBotId: number
): Promise<void> {
  if (
    shouldIgnoreInbound({
      chatId: msg.chatId,
      userId: msg.userId,
      skipBotId,
      blockedChatIds: blockedChatIds(),
    })
  ) {
    return;
  }
  router.bind(msg.chatId, acc.id);
  if (!withinWorkHours() && process.env.TG_STRICT_HOURS === "true") {
    log.info("outside work hours, queueing only", { chatId: msg.chatId });
  }
  if (!rateLimitOk()) {
    log.warn("rate limit hit — delaying requeue", { account: acc.id, chatId: msg.chatId });
    await sleep(5000);
    if (!rateLimitOk()) {
      log.warn("rate limit still hit", { account: acc.id, chatId: msg.chatId });
      return;
    }
  }
  const extracted = msg.media ? await describeInboundMedia(msg.media) : null;
  if (
    msg.media &&
    (msg.media.kind === "voice" || msg.media.kind === "audio") &&
    !extracted
  ) {
    log.warn("voice transcription empty", {
      account: acc.id,
      chatId: msg.chatId,
      bytes: msg.media.buffer.length,
      contentType: msg.media.contentType,
    });
  }
  const text = composeInboundText({
    caption: msg.text,
    media: msg.media,
    extracted,
    audience: "client",
  });
  if (!text.trim()) return;
  if (msg.messageId && (await isMessageAlreadyProcessed(apiBase, msg.chatId, msg.messageId))) {
    log.info("inbound skipped (already processed)", {
      account: acc.id,
      chatId: msg.chatId,
      messageId: msg.messageId,
    });
    return;
  }
  log.info("inbound", {
    account: acc.id,
    chatId: msg.chatId,
    messageId: msg.messageId,
    text: text.slice(0, 120),
    media: msg.media?.kind,
    ocr: Boolean(extracted),
    voice: msg.media?.kind === "voice" || msg.media?.kind === "audio",
  });
  await enqueueInbound(acc.id, msg, text, apiBase, outboundQueue, channelQueue);
}

async function runStartupCatchUp(
  handle: UserClientHandle,
  acc: { id: string },
  router: TgAccountRouter,
  apiBase: string,
  outboundQueue: Queue,
  channelQueue: Queue,
  skipBotId: number
): Promise<void> {
  const onInbound = (msg: InboundMsg) =>
    handleInboundMessage(acc, msg, router, apiBase, outboundQueue, channelQueue, skipBotId);

  log.info("catch-up unread private chats", { account: acc.id });
  const unread = await catchUpPrivateChats({
    client: handle.client,
    onInbound,
    skipBotId,
    blockedChatIds: blockedChatIds(),
  });
  log.info("catch-up unread done", { account: acc.id, ...unread });

  const resume = await resumeOpenTelegramDeals({
    apiBase,
    client: handle.client,
    onInbound,
    onResumeDeal: async (deal: OpenTelegramDeal) => {
      const chatId = Number(deal.tg_chat_id);
      if (!deal.last_inbound_text?.trim()) return;
      const resumeKey = jobKey(
        "resume",
        deal.id,
        deal.last_tg_message_id || "0",
        new Date().toISOString().slice(0, 13)
      );
      log.info("resume open deal dialog", { dealId: deal.id, chatId });
      await enqueueInbound(
        acc.id,
        {
          chatId,
          text: deal.last_inbound_text,
          clientName: deal.client_name || undefined,
          messageId: deal.last_tg_message_id ?? undefined,
        },
        deal.last_inbound_text,
        apiBase,
        outboundQueue,
        channelQueue,
        resumeKey
      );
    },
  });
  log.info("resume open deals done", { account: acc.id, ...resume });
}

async function startAccountLoop(
  acc: { id: string; api_id: number; api_hash: string; session: string; label?: string },
  router: TgAccountRouter,
  senders: Map<string, Sender>,
  apiBase: string,
  outboundQueue: Queue,
  channelQueue: Queue,
  skipBotId: number
): Promise<void> {
  let attempt = 0;
  while (true) {
    attempt += 1;
    process.env.TG_API_ID = String(acc.api_id);
    process.env.TG_API_HASH = acc.api_hash;
    process.env.TG_STRING_SESSION = acc.session;
    try {
      const handle = await startUserClient({
        onInbound: (msg) =>
          handleInboundMessage(acc, msg, router, apiBase, outboundQueue, channelQueue, skipBotId),
        onIncomingCall: async ({ userId, video }) => {
          log.info("telegram call requested", { userId, video, account: acc.id });
          const did = process.env.VOICE_DID_NUMBER || "";
          const phoneHint = did
            ? `Или позвоните на ${did} — ответит голосовой ассистент.`
            : "Или напишите маршрут и груз сюда сообщением.";
          const text = [
            "Голосовые звонки внутри Telegram этот аккаунт не принимает.",
            "Напишите, пожалуйста, откуда/куда везём и что за груз — отвечу здесь.",
            phoneHint,
          ].join("\n");
          const sendFn = senders.get(acc.id);
          if (sendFn) await sendFn(userId, text);
        },
        onDisconnected: () => {
          senders.delete(acc.id);
        },
      });
      senders.set(acc.id, handle.send);
      log.info("user client started", { account: acc.id, label: acc.label });

      await runStartupCatchUp(
        handle,
        acc,
        router,
        apiBase,
        outboundQueue,
        channelQueue,
        skipBotId
      );

      // Keep loop alive; GramJS auto-reconnects. If process restarts, catch-up runs again.
      await new Promise<void>(() => undefined);
    } catch (err) {
      senders.delete(acc.id);
      const waitMs = Math.min(60_000, 5000 * attempt);
      log.error("user client failed; retrying", {
        account: acc.id,
        attempt,
        waitMs,
        err: String(err),
      });
      await sleep(waitMs);
    }
  }
}

function botUserId(): number {
  const token = process.env.TG_BOT_TOKEN || "";
  const n = Number(token.split(":")[0]);
  return Number.isFinite(n) ? n : 0;
}

function internalApiHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = (process.env.INTERNAL_API_TOKEN || "").trim();
  return token ? { ...extra, "x-internal-token": token } : { ...extra };
}

async function main() {
  await enforceLicense({
    service: "tg-gateway",
    allowPrompt: Boolean(process.stdin.isTTY),
  });
  await refreshPx6MtProtoFromApi().catch(() => undefined);
  const px = loadAppProxy();
  if (px) {
    log.info("outbound proxy enabled", { host: px.host, port: px.port, type: px.type });
  }
  const mt = loadMtProtoProxy();
  if (mt) {
    log.info("telegram mtproto proxy", {
      host: mt.ip,
      port: mt.port,
      fakeTls: Boolean(mt.fakeTlsDomain),
    });
  }
  const apiBase = process.env.API_URL || "http://localhost:3000";
  const accounts = loadTgAccountsFromEnv();
  const router = new TgAccountRouter(accounts);
  const senders = new Map<string, Sender>();
  const skipBotId = botUserId();

  // Management bot + staff dispatcher BEFORE user-client loops, so early
  // staff-group messages are not dropped with "no dispatcher yet".
  if (process.env.TG_BOT_TOKEN) {
    await startManagementBot({
      token: process.env.TG_BOT_TOKEN,
      apiBase,
      voiceGatewayUrl: process.env.VOICE_GATEWAY_URL || "http://localhost:3010",
      managerIds: (process.env.TG_MANAGER_IDS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isFinite(n) && n !== 0),
      onAudit: (msg, meta) => log.audit(msg, meta),
      listAccounts: () => router.list(),
    });
    log.info("management bot started");
  } else {
    log.warn("TG_BOT_TOKEN not set — management bot disabled");
  }

  if (accounts.length) {
    for (const acc of accounts) {
      void startAccountLoop(
        acc,
        router,
        senders,
        apiBase,
        outboundQueue,
        channelQueue,
        skipBotId
      );
    }
  } else {
    log.warn("no TG accounts configured — user client disabled (dev mode)");
  }

  const outboundWorker = new Worker(
    QUEUES.outbound,
    async (job) => {
      const data = job.data as {
        chat_id: number;
        text: string;
        delay_ms?: number;
        account_id?: string;
      };
      const delay = data.delay_ms ?? (await humanDelay());
      await new Promise((r) => setTimeout(r, delay));
      const acc = router.assign(data.chat_id, data.account_id);
      const send = acc ? senders.get(acc.id) : null;
      if (!send) {
        throw new Error(`user_client_not_connected account=${acc?.id || data.account_id || "?"}`);
      }
      await send(data.chat_id, data.text);
      log.info("outbound sent", { chat: data.chat_id, account: acc?.id });
    },
    { connection, concurrency: 2 }
  );
  outboundWorker.on("failed", (job, err) => {
    log.error("outbound job failed", { jobId: job?.id, err: String(err) });
  });

  const channelWorker = new Worker(
    QUEUES.channel,
    async (job) => {
      const data = job.data as {
        kind: string;
        text: string;
        deal_id?: string;
        notify_director?: boolean;
      };
      await routeStaffChannelPost({
        kind: data.kind,
        text: data.text,
        notify_director: Boolean(data.notify_director),
      });
      log.info("channel post", {
        kind: data.kind,
        deal_id: data.deal_id,
        notify_director: Boolean(data.notify_director),
      });
    },
    { connection }
  );
  channelWorker.on("failed", (job, err) => {
    log.error("channel job failed", { jobId: job?.id, err: String(err) });
  });

  const orchestrateWorker = new Worker(
    QUEUES.orchestrate,
    async (job) => {
      await processOrchestrateJob(apiBase, job.data, outboundQueue, channelQueue);
    },
    { connection, concurrency: 4 }
  );
  orchestrateWorker.on("failed", (job, err) => {
    log.error("orchestrate job failed", { jobId: job?.id, err: String(err) });
  });

  log.info("tg-gateway running", { accounts: router.list() });
}

async function processOrchestrateJob(
  apiBase: string,
  data: {
    chat_id?: number;
    user_id?: number;
    message_id?: number;
    text?: string;
    client_name?: string;
    idempotency_key?: string;
    account_id?: string;
    media?: {
      filename: string;
      content_type: string;
      kind: InboundMedia["kind"];
      content_base64: string;
    };
  },
  outbound: Queue,
  channel: Queue
) {
  const res = await fetch(`${apiBase}/orchestrator/process`, {
    method: "POST",
    headers: internalApiHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      chat_id: data.chat_id,
      user_id: data.user_id,
      message_id: data.message_id,
      text: data.text,
      client_name: data.client_name,
      idempotency_key: data.idempotency_key,
      account_id: data.account_id,
    }),
  }).catch((err) => {
    log.error("orchestrator process fetch failed", {
      err: String(err),
      chatId: data.chat_id,
    });
    throw err;
  });
  const result = (await res.json()) as {
    cached?: boolean;
    replies?: string[];
    fallback_replies?: string[];
    deal_id?: string;
    escalate?: boolean;
    escalation?: Record<string, unknown> & { reason?: string; id?: string; duplicate?: boolean };
    error?: string;
  };
  if (result.cached) {
    log.info("orchestrator cached, skip outbound", {
      chatId: data.chat_id,
      key: data.idempotency_key,
    });
    return;
  }
  if (!res.ok) {
    log.error("orchestrator process http error", {
      status: res.status,
      error: result.error,
      chatId: data.chat_id,
    });
  }
  if (result.deal_id && data.media?.content_base64) {
    try {
      const att = await fetch(`${apiBase}/deals/${result.deal_id}/attachments`, {
        method: "POST",
        headers: internalApiHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          filename: data.media.filename,
          content_base64: data.media.content_base64,
          content_type: data.media.content_type,
          kind: data.media.kind,
        }),
      });
      if (!att.ok) {
        log.warn("store inbound media failed", {
          status: att.status,
          dealId: result.deal_id,
        });
      }
    } catch (err) {
      log.warn("store inbound media failed", { err: String(err), dealId: result.deal_id });
    }
  }
  const replies = result.replies || result.fallback_replies || [];
  for (const [i, text] of replies.entries()) {
    const outId = jobKey("out", data.idempotency_key, i, text.slice(0, 24));
    try {
      await outbound.add(
        "reply",
        {
          type: "tg.outbound",
          chat_id: data.chat_id,
          text,
          deal_id: result.deal_id,
          account_id: data.account_id,
          idempotency_key: outId,
        },
        { jobId: outId, removeOnComplete: 1000, attempts: 3 }
      );
    } catch (err) {
      if (!isJobExistsError(err)) throw err;
    }
  }
  if (result.escalate && result.escalation && !result.escalation.duplicate) {
    log.audit("escalation", {
      deal_id: result.deal_id,
      reason: result.escalation.reason,
    });
    const reason =
      result.escalation.reason != null ? String(result.escalation.reason) : undefined;
    const text = await formatEscalationAlert(apiBase, result.deal_id, result.escalation);
    const alertId = channelJobId(
      "esc",
      result.deal_id,
      result.escalation.reason,
      result.escalation.id
    );
    try {
      await channel.add(
        "alert",
        {
          kind: "alert",
          text,
          deal_id: result.deal_id,
          // Director only when policy says staff can't close alone.
          notify_director: escalationNeedsDirector(reason),
        },
        { jobId: alertId, removeOnComplete: false, attempts: 3 }
      );
    } catch (err) {
      if (!isJobExistsError(err)) throw err;
    }
  }
}

async function formatEscalationAlert(
  apiBase: string,
  dealId: string | undefined,
  esc: Record<string, unknown>
): Promise<string> {
  let deal: DealSnippet | null = dealId ? { id: dealId } : null;
  if (dealId) {
    try {
      const res = await fetch(`${apiBase}/deals/${dealId}`, {
        headers: internalApiHeaders(),
      });
      if (res.ok) {
        deal = dealSnippetFromRow((await res.json()) as Record<string, unknown>);
      }
    } catch {
      /* card without deal details is still useful */
    }
  }
  return formatEscalationStaff({
    dealId,
    reason: esc.reason != null ? String(esc.reason) : undefined,
    summary: esc.summary != null ? String(esc.summary) : undefined,
    neededDecision:
      esc.needed_decision != null ? String(esc.needed_decision) : undefined,
    deal,
  });
}

main().catch((err) => {
  log.error("fatal", { err: String(err) });
  process.exit(1);
});

export { outboundQueue, channelQueue, orchestrateQueue };
