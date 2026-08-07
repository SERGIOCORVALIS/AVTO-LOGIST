import { Queue } from "bullmq";
import IORedis from "ioredis";
import { QUEUES } from "@alo/shared";

const connection = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
});

export const emailQueue = new Queue(QUEUES.email, { connection });
export const ocrQueue = new Queue(QUEUES.ocr, { connection });
export const slaQueue = new Queue(QUEUES.sla, { connection });

export async function enqueueEmailJob(
  name: "request_quote" | "find_and_request",
  data: Record<string, unknown>,
  opts?: { jobId?: string }
) {
  return emailQueue.add(name, data, {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 200,
    jobId: opts?.jobId,
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
