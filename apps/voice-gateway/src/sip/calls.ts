import { createLogger } from "@alo/shared";
import type { Dialog } from "@vexyl.ai/sip";
import type { Queue } from "bullmq";
import { RealtimeBridge } from "../realtime/bridge";
import type { SessionManager } from "../sessions";
import type { SipConfig } from "./config";
import { transferDialogToManager } from "./transfer";
import { afterHoursMessage, isAfterHours } from "./hours";

const log = createLogger("sip-calls");

function extractCallerPhone(dialog: Dialog): string {
  const from = dialog.request?.headers?.from as
    | { uri?: string; name?: string }
    | string
    | undefined;
  let uri = "";
  if (typeof from === "string") uri = from;
  else if (from?.uri) uri = String(from.uri);

  const m = uri.match(/sip:([^@;>]+)/i);
  let user = m?.[1] || "";
  user = decodeURIComponent(user).replace(/^"|"$/g, "");
  if (!user || user.toLowerCase() === "anonymous") {
    return "+70000000000";
  }
  if (user.startsWith("+")) return user;
  const digits = user.replace(/\D/g, "");
  if (digits.length >= 10) return digits.startsWith("8") && digits.length === 11
    ? `+7${digits.slice(1)}`
    : `+${digits}`;
  return `+${digits || "70000000000"}`;
}

function extractCallId(dialog: Dialog): string {
  return dialog.id || dialog.request?.headers?.["call-id"] || `sip-${Date.now()}`;
}

export interface CallHandlerDeps {
  sessions: SessionManager;
  cfg: SipConfig;
  apiBase: string;
  channelQueue: Queue;
}

async function postEscalation(queue: Queue, text: string, dealId?: string) {
  await queue.add("alert", { kind: "alert", text, deal_id: dealId });
}

export async function handleInboundInvite(dialog: Dialog, deps: CallHandlerDeps): Promise<void> {
  const { sessions, cfg, apiBase, channelQueue } = deps;
  const phone = extractCallerPhone(dialog);
  const providerCallId = extractCallId(dialog);

  log.info("inbound INVITE", { phone, providerCallId });

  try {
    await dialog.trying();
    await dialog.ringing();
  } catch (err) {
    log.error("trying/ringing failed", { err: String(err) });
  }

  let live;
  try {
    live = await sessions.startCall({ phone, providerCallId });
  } catch (err) {
    log.error("startCall failed", { err: String(err) });
    await dialog.reject(500, "Server Error").catch(() => undefined);
    return;
  }

  live.dialog = dialog;

  try {
    await dialog.accept({ payloadType: cfg.payloadType });
  } catch (err) {
    log.error("accept failed", { err: String(err), callSessionId: live.callSessionId });
    await sessions.endCall(live.callSessionId, "failed");
    return;
  }

  await sessions.markActive(live.callSessionId);

  const afterHours =
    isAfterHours() &&
    (process.env.VOICE_AFTER_HOURS_MODE || "message") === "message";
  if (afterHours) {
    log.info("after-hours call", { phone, callSessionId: live.callSessionId });
    void postEscalation(
      channelQueue,
      `AFTER HOURS CALL phone=${phone} deal=${live.dealId}`,
      live.dealId
    );
  }

  const bridge = new RealtimeBridge({
    apiBase,
    dealId: live.dealId,
    phone: live.phone,
    callSessionId: live.callSessionId,
    greetingOverride: afterHours
      ? `${afterHoursMessage()} Произнесите это сообщение и завершите разговор.`
      : undefined,
    onAudioOut: (pcm8) => {
      try {
        dialog.enqueueAudio(pcm8);
      } catch (err) {
        log.error("enqueueAudio", { err: String(err) });
      }
    },
    onTranscript: (role, text) => {
      void sessions.appendTranscript(live!.callSessionId, role, text);
    },
    onEscalate: (esc) => {
      const t = [
        "VOICE ESCALATION",
        `deal: ${live!.dealId}`,
        `phone: ${live!.phone}`,
        `reason: ${esc.reason ?? "—"}`,
        `summary: ${esc.summary ?? "—"}`,
      ].join("\n");
      void postEscalation(channelQueue, t, live!.dealId);
    },
    onTransfer: (reason) => {
      live!.transferRequested = true;
      void transferDialogToManager(dialog, cfg, reason).then((ok) => {
        if (ok) {
          void sessions.endCall(live!.callSessionId, "transferred");
        }
      });
    },
    onClose: () => {
      void sessions.endCall(
        live!.callSessionId,
        live?.transferRequested ? "transferred" : "completed"
      );
    },
  });

  live.bridge = bridge;

  if (afterHours) {
    setTimeout(() => {
      void dialog.bye().catch(() => undefined);
      void sessions.endCall(live!.callSessionId, "completed");
    }, 20_000);
  }

  if (cfg.maxCallMinutes > 0) {
    live.maxCallTimer = setTimeout(() => {
      log.warn("max call minutes reached", {
        callSessionId: live!.callSessionId,
        minutes: cfg.maxCallMinutes,
      });
      void dialog.bye().catch(() => undefined);
      void sessions.endCall(live!.callSessionId, "completed");
    }, cfg.maxCallMinutes * 60 * 1000);
  }

  try {
    await bridge.connect();
  } catch (err) {
    log.error("realtime connect failed", { err: String(err), callSessionId: live.callSessionId });
    await dialog.bye().catch(() => undefined);
    await sessions.endCall(live.callSessionId, "failed");
    return;
  }

  dialog.on("audio", (pcm: Buffer) => {
    bridge.sendPcm8Audio(pcm);
  });

  dialog.on("end", (reason: string) => {
    log.info("dialog end", { reason, callSessionId: live!.callSessionId });
    bridge.close();
    const status = live!.transferRequested ? "transferred" : "completed";
    void sessions.endCall(live!.callSessionId, status);
  });

  dialog.on("error", (err: Error) => {
    log.error("dialog error", { err: String(err), callSessionId: live!.callSessionId });
  });
}
