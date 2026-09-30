import { Queue } from "bullmq";
import IORedis from "ioredis";
import { QUEUES } from "@alo/shared";

const connection = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

export const emailQueue = new Queue(QUEUES.email, { connection });
export const ocrQueue = new Queue(QUEUES.ocr, { connection });
export const slaQueue = new Queue(QUEUES.sla, { connection });
export const outboundQueue = new Queue(QUEUES.outbound, { connection });
export const digestQueue = new Queue(QUEUES.digest, { connection });
export const channelQueue = new Queue(QUEUES.channel, { connection });

export async function enqueueOutboundTg(
  chatId: number,
  text: string,
  dealId: string,
  idx: number
) {
  const jobId = `approve-kp-${dealId}-${idx}-${text.slice(0, 24).replace(/\s+/g, "_")}`;
  return outboundQueue.add(
    "reply",
    {
      type: "tg.outbound",
      chat_id: chatId,
      text,
      deal_id: dealId,
      idempotency_key: jobId,
    },
    { jobId, removeOnComplete: 1000, attempts: 3 }
  );
}
export async function enqueueEmailJob(
  name:
    | "request_quote"
    | "find_and_request"
    | "request_sourcing"
    | "cabinet_rfq"
    | "api_quote_fallback",
  data: Record<string, unknown>,
  opts?: { jobId?: string; delayMs?: number }
) {
  return emailQueue.add(name, data, {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    // Keep completed/failed short so re-RFQ with new jobId is not blocked by leftovers.
    removeOnComplete: 50,
    removeOnFail: 100,
    jobId: opts?.jobId,
    delay: opts?.delayMs && opts.delayMs > 0 ? opts.delayMs : undefined,
  });
}

export async function enqueueOcrJob(data: {
  deal_id: string;
  attachment_id: string;
  path: string;
  key?: string;
  storage?: string;
  content_type?: string;
  filename?: string;
}) {
  return ocrQueue.add("parse_invoice", data, {
    attempts: 3,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: 50,
    removeOnFail: 100,
    jobId: `ocr-${data.deal_id}-${data.attachment_id}`,
  });
}

export async function enqueueCalendarSync() {
  return slaQueue.add(
    "sync_calendar",
    {},
    {
      attempts: 2,
      removeOnComplete: 20,
      jobId: `sync-calendar-${Date.now()}`,
    }
  );
}

export async function enqueueAssociationsUpdate(runId: string, staffId?: string | null) {
  return digestQueue.add(
    "associations_update",
    { run_id: runId, staff_id: staffId ?? null },
    {
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 50,
      jobId: `associations-update-${runId}`,
    }
  );
}

export async function enqueueChannelJob(opts: {
  kind: "alert" | "info" | "digest";
  text: string;
  deal_id?: string;
  jobId?: string;
  notify_director?: boolean;
}) {
  return channelQueue.add(
    opts.kind,
    {
      kind: opts.kind,
      text: opts.text,
      deal_id: opts.deal_id,
      notify_director: opts.notify_director,
    },
    {
      attempts: 3,
      removeOnComplete: 200,
      jobId: opts.jobId || `channel-${opts.kind}-${Date.now()}`,
    }
  );
}
