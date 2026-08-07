import "dotenv/config";
import {
  QUEUES,
  assertLicenseOrExit,
  createLogger,
  ensureLogTree,
  loadTgAccountsFromEnv,
  TgAccountRouter,
} from "@alo/shared";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { startUserClient } from "./userClient";
import { startManagementBot } from "./managementBot";
import { postToExecutiveChannel, postEscalation } from "./channel";
import { humanDelay, withinWorkHours, rateLimitOk } from "./antiBan";

// Preload Doppler/env secrets if helper present
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../../../scripts/load-secrets.cjs");
} catch {
  /* optional */
}

const log = createLogger("gateway");
ensureLogTree();

const license = assertLicenseOrExit("tg-gateway");
log.info("license", {
  mode: license.mode,
  daysLeft: license.daysLeft,
  periodEndsAt: license.periodEndsAt,
});

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

const outboundQueue = new Queue(QUEUES.outbound, { connection });
const channelQueue = new Queue(QUEUES.channel, { connection });
const orchestrateQueue = new Queue(QUEUES.orchestrate, { connection });

type Sender = (chatId: number, text: string) => Promise<void>;

async function main() {
  const apiBase = process.env.API_URL || "http://localhost:3000";
  const accounts = loadTgAccountsFromEnv();
  const router = new TgAccountRouter(accounts);
  const senders = new Map<string, Sender>();

  if (accounts.length) {
    for (const acc of accounts) {
      process.env.TG_API_ID = String(acc.api_id);
      process.env.TG_API_HASH = acc.api_hash;
      process.env.TG_STRING_SESSION = acc.session;
      const send = await startUserClient({
        onInbound: async (msg) => {
          router.bind(msg.chatId, acc.id);
          if (!withinWorkHours() && process.env.TG_STRICT_HOURS === "true") {
            log.info("outside work hours, queueing only", { chatId: msg.chatId });
          }
          if (!rateLimitOk()) {
            log.warn("rate limit hit", { account: acc.id });
            return;
          }
          log.info("inbound", {
            account: acc.id,
            chatId: msg.chatId,
            text: msg.text.slice(0, 120),
          });
          await orchestrateQueue.add(
            "inbound",
            {
              type: "tg.inbound",
              chat_id: msg.chatId,
              user_id: msg.userId,
              message_id: msg.messageId,
              text: msg.text,
              client_name: msg.clientName,
              timestamp: new Date().toISOString(),
              idempotency_key: `in:${acc.id}:${msg.chatId}:${msg.messageId}`,
              account_id: acc.id,
            },
            {
              jobId: `in:${acc.id}:${msg.chatId}:${msg.messageId}`,
              removeOnComplete: 1000,
              attempts: 3,
              backoff: { type: "exponential", delay: 2000 },
            }
          );
        },
      });
      senders.set(acc.id, send);
      log.info("user client started", { account: acc.id, label: acc.label });
    }
  } else {
    log.warn("no TG accounts configured — user client disabled (dev mode)");
  }

  if (process.env.TG_BOT_TOKEN) {
    await startManagementBot({
      token: process.env.TG_BOT_TOKEN,
      apiBase,
      voiceGatewayUrl: process.env.VOICE_GATEWAY_URL || "http://localhost:3010",
      managerIds: (process.env.TG_MANAGER_IDS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number),
      onAudit: (msg, meta) => log.audit(msg, meta),
      listAccounts: () => router.list(),
    });
    log.info("management bot started");
  } else {
    log.warn("TG_BOT_TOKEN not set — management bot disabled");
  }

  new Worker(
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
        log.info("dev-outbound", { chat: data.chat_id, text: data.text.slice(0, 200) });
        return;
      }
      await send(data.chat_id, data.text);
      log.info("outbound sent", { chat: data.chat_id, account: acc?.id });
    },
    { connection, concurrency: 2 }
  );

  new Worker(
    QUEUES.channel,
    async (job) => {
      const data = job.data as { kind: string; text: string; deal_id?: string };
      await postToExecutiveChannel(data.text);
      log.info("channel post", { kind: data.kind, deal_id: data.deal_id });
    },
    { connection }
  );

  new Worker(
    QUEUES.orchestrate,
    async (job) => {
      const data = job.data;
      const res = await fetch(`${apiBase}/orchestrator/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: data.chat_id,
          user_id: data.user_id,
          text: data.text,
          client_name: data.client_name,
          idempotency_key: data.idempotency_key,
          account_id: data.account_id,
        }),
      });
      const result = (await res.json()) as {
        replies?: string[];
        fallback_replies?: string[];
        deal_id?: string;
        escalate?: boolean;
        escalation?: Record<string, unknown>;
      };
      const replies = result.replies || result.fallback_replies || [];
      for (const text of replies) {
        await outboundQueue.add(
          "reply",
          {
            type: "tg.outbound",
            chat_id: data.chat_id,
            text,
            deal_id: result.deal_id,
            account_id: data.account_id,
            idempotency_key: `out:${data.idempotency_key}:${text.slice(0, 24)}`,
          },
          { removeOnComplete: 1000, attempts: 3 }
        );
      }
      if (result.escalate && result.escalation) {
        log.audit("escalation", {
          deal_id: result.deal_id,
          reason: result.escalation.reason,
        });
        const text = formatEscalationAlert(result.deal_id, result.escalation);
        await postEscalation(text);
        await channelQueue.add("alert", {
          kind: "alert",
          text,
          deal_id: result.deal_id,
        });
      }
    },
    { connection, concurrency: 4 }
  );

  log.info("tg-gateway running", { accounts: router.list() });
}

function formatEscalationAlert(
  dealId: string | undefined,
  esc: Record<string, unknown>
): string {
  return [
    "ESCALATION",
    `deal: ${dealId ?? "—"}`,
    `reason: ${esc.reason ?? "—"}`,
    `summary: ${esc.summary ?? "—"}`,
    `decision needed: ${esc.needed_decision ?? "approve/reject"}`,
  ].join("\n");
}

main().catch((err) => {
  log.error("fatal", { err: String(err) });
  process.exit(1);
});

export { outboundQueue, channelQueue, orchestrateQueue };
