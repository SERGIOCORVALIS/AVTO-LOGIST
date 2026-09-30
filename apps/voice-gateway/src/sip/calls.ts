import {
  createLogger,
  formatAfterHoursCallStaff,
  formatVoiceEscalationStaff,
} from "@alo/shared";
import type { Dialog } from "@vexyl.ai/sip";
import type { Queue } from "bullmq";
import { RealtimeBridge } from "../realtime/bridge";
import type { SessionManager } from "../sessions";
import type { SipConfig } from "./config";
import { transferDialogToManager } from "./transfer";
import { afterHoursMessage, isAfterHours } from "./hours";

const log = createLogger("sip-calls");

/** Silent PCM @ 8 kHz — keeps RTP/NAT alive without audible hiss. */
function silencePcm(ms: number): Buffer {
  const samples = Math.max(160, Math.floor(8000 * (ms / 1000)));
  return Buffer.alloc(samples * 2);
}

const RTP_FRAME_MS = 20;
const RTP_FRAME_BYTES = 160 * 2; // 20ms @ 8 kHz 16-bit
const RTP_MAX_BUFFER_BYTES = 8000 * 2 * 4; // ~4s of PCM
const RTP_PREROLL_BYTES = RTP_FRAME_BYTES * 6; // 120ms jitter buffer
const RTP_CONCEAL_MS = 520;
const ECHO_GUARD_MS = 900;

/**
 * Continuous 20ms RTP clock. GPT deltas arrive in bursts via proxy;
 * without filler frames Beeline hears choppy audio and may drop the call.
 */
class RtpPlayout {
  private buf = Buffer.alloc(0);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private nextAt = 0;
  private lastSample = 0;
  private speaking = false;
  private underrunMs = 0;
  onIdle?: () => void;

  constructor(private dialog: Dialog) {}

  start() {
    this.nextAt = Date.now();
    const tick = () => {
      if (this.stopped) return;
      this.emitFrame();
      this.nextAt += RTP_FRAME_MS;
      const delay = Math.max(0, this.nextAt - Date.now());
      this.timer = setTimeout(tick, delay);
    };
    tick();
  }

  private concealFrame(): Buffer {
    const frame = Buffer.alloc(RTP_FRAME_BYTES);
    let s = this.lastSample;
    for (let i = 0; i < 160; i++) {
      s = Math.round(s * 0.88);
      frame.writeInt16LE(s, i * 2);
    }
    this.lastSample = s;
    return frame;
  }

  private send(frame: Buffer) {
    const session = this.dialog.rtpSession;
    if (!session || typeof session.sendPcm !== "function") return;
    if (frame.length >= 2) this.lastSample = frame.readInt16LE(frame.length - 2);
    try {
      session.sendPcm(frame);
    } catch {
      /* dialog already tearing down */
    }
  }

  private emitFrame() {
    if (!this.speaking) {
      if (this.buf.length < RTP_PREROLL_BYTES) {
        this.send(silencePcm(RTP_FRAME_MS));
        return;
      }
      this.speaking = true;
      this.underrunMs = 0;
    }

    if (this.buf.length >= RTP_FRAME_BYTES) {
      const frame = this.buf.subarray(0, RTP_FRAME_BYTES);
      this.buf = this.buf.subarray(RTP_FRAME_BYTES);
      this.underrunMs = 0;
      this.send(frame);
      return;
    }

    this.underrunMs += RTP_FRAME_MS;
    if (this.underrunMs < RTP_CONCEAL_MS) {
      this.send(this.concealFrame());
      return;
    }
    this.speaking = false;
    this.underrunMs = 0;
    this.send(silencePcm(RTP_FRAME_MS));
    this.onIdle?.();
  }

  push(pcm: Buffer) {
    if (this.stopped || !pcm.length) return;
    this.buf = Buffer.concat([this.buf, pcm]);
    if (this.buf.length > RTP_MAX_BUFFER_BYTES) {
      this.buf = this.buf.subarray(this.buf.length - RTP_MAX_BUFFER_BYTES);
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.buf = Buffer.alloc(0);
  }
}

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
  const jobId = ["voice-esc", dealId || "none", String(text.slice(0, 40))]
    .join("-")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(0, 128);
  try {
    await queue.add("alert", { kind: "alert", text, deal_id: dealId }, { jobId, removeOnComplete: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(msg)) throw err;
  }
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

  let hangupTimer: ReturnType<typeof setTimeout> | undefined;
  let unmuteTimer: ReturnType<typeof setTimeout> | undefined;
  let bridge!: RealtimeBridge;
  let generating = false;
  let playoutIdle = true;

  const considerListen = () => {
    if (generating || !playoutIdle) return;
    if (unmuteTimer) clearTimeout(unmuteTimer);
    unmuteTimer = setTimeout(() => {
      if (generating || !playoutIdle) return;
      bridge.unmuteInput();
      log.info("listening", { callSessionId: live.callSessionId });
    }, ECHO_GUARD_MS);
  };

  const holdLine = () => {
    generating = true;
    playoutIdle = false;
    if (unmuteTimer) clearTimeout(unmuteTimer);
    bridge.muteInput();
  };

  const playout = new RtpPlayout(dialog);
  playout.onIdle = () => {
    playoutIdle = true;
    considerListen();
  };
  playout.start();

  const afterHours =
    isAfterHours() &&
    (process.env.VOICE_AFTER_HOURS_MODE || "talk") === "message";
  if (afterHours) {
    log.info("after-hours call", { phone, callSessionId: live.callSessionId });
    void postEscalation(
      channelQueue,
      formatAfterHoursCallStaff({
        phone,
        deal: { id: live.dealId, client_phone: phone, channel: "voice" },
      }),
      live.dealId
    );
  }

  const hangup = (reason: string) => {
    log.info("hangup", { reason, callSessionId: live.callSessionId });
    playout.stop();
    if (unmuteTimer) clearTimeout(unmuteTimer);
    void dialog.bye().catch(() => undefined);
    void sessions.endCall(live.callSessionId, "completed");
  };

  bridge = new RealtimeBridge({
    apiBase,
    dealId: live.dealId,
    phone: live.phone,
    callSessionId: live.callSessionId,
    greetingOverride: afterHours
      ? `${afterHoursMessage()} Произнесите это сообщение целиком, затем коротко попрощайтесь.`
      : undefined,
    onResponseStart: () => {
      holdLine();
    },
    onResponseDone: () => {
      generating = false;
      considerListen();
    },
    onAudioOut: (pcm8) => {
      if (unmuteTimer) clearTimeout(unmuteTimer);
      playoutIdle = false;
      bridge.muteInput();
      playout.push(pcm8);
    },
    onGreetingDone: () => {
      log.info("greeting done", { callSessionId: live.callSessionId, afterHours });
      if (afterHours) {
        hangupTimer = setTimeout(() => hangup("after-hours-message"), 2_500);
      }
    },
    onTranscript: (role, text) => {
      void sessions.appendTranscript(live!.callSessionId, role, text);
    },
    onEscalate: (esc) => {
      const t = formatVoiceEscalationStaff({
        deal: { id: live!.dealId, client_phone: live!.phone, channel: "voice" },
        phone: live!.phone,
        reason: esc.reason != null ? String(esc.reason) : undefined,
        summary: esc.summary != null ? String(esc.summary) : undefined,
      });
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

  if (cfg.maxCallMinutes > 0) {
    live.maxCallTimer = setTimeout(() => {
      log.warn("max call minutes reached", {
        callSessionId: live!.callSessionId,
        minutes: cfg.maxCallMinutes,
      });
      hangup("max-minutes");
    }, cfg.maxCallMinutes * 60 * 1000);
  }

  try {
    await bridge.connect();
  } catch (err) {
    log.error("realtime connect failed", { err: String(err), callSessionId: live.callSessionId });
    playout.stop();
    await dialog.bye().catch(() => undefined);
    await sessions.endCall(live.callSessionId, "failed");
    return;
  }

  dialog.on("audio", (pcm: Buffer) => {
    bridge.sendPcm8Audio(pcm);
  });

  dialog.on("end", (reason: string) => {
    if (hangupTimer) clearTimeout(hangupTimer);
    playout.stop();
    const rtp = dialog.rtpSession?.getStats?.();
    log.info("dialog end", {
      reason,
      callSessionId: live!.callSessionId,
      rtpSent: rtp?.packetsSent,
      rtpRecv: rtp?.packetsReceived,
      rtpRemote: rtp?.remoteAddress,
    });
    bridge.close();
    const status = live!.transferRequested ? "transferred" : "completed";
    void sessions.endCall(live!.callSessionId, status);
  });

  dialog.on("error", (err: Error) => {
    log.error("dialog error", { err: String(err), callSessionId: live!.callSessionId });
  });
}
