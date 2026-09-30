import { createLogger } from "@alo/shared";
import { SipStack } from "@vexyl.ai/sip/stack";
import type { Queue } from "bullmq";
import type { SessionManager } from "../sessions";
import { loadSipConfig, type SipConfig } from "./config";
import { SipRegistrar } from "./register";
import { handleInboundInvite } from "./calls";

const log = createLogger("sip-trunk");

function sipPreview(msg: unknown): string {
  if (typeof msg === "string") return msg.slice(0, 220);
  if (msg && typeof msg === "object") {
    const m = msg as {
      method?: string;
      status?: number;
      reason?: string;
      uri?: unknown;
      headers?: { "call-id"?: string };
    };
    const uri = typeof m.uri === "string" ? m.uri : "";
    return [m.method || m.status, uri || m.reason, m.headers?.["call-id"]]
      .filter(Boolean)
      .join(" ")
      .slice(0, 220);
  }
  return String(msg).slice(0, 220);
}

export interface SipTrunk {
  cfg: SipConfig;
  stack: SipStack;
  registrar: SipRegistrar | null;
  stop: () => Promise<void>;
}

export async function startSipTrunk(deps: {
  sessions: SessionManager;
  apiBase: string;
  channelQueue: Queue;
}): Promise<SipTrunk | null> {
  const cfg = loadSipConfig();
  if (!cfg.enabled) {
    log.warn("SIP trunk not started");
    return null;
  }

  const stack = new SipStack({
    port: cfg.port,
    address: cfg.bindHost === "0.0.0.0" ? undefined : cfg.bindHost,
    publicAddress: cfg.publicHost,
    hostname: cfg.publicHost,
    udp: cfg.transport !== "tcp",
    tcp: cfg.transport === "tcp",
    credentials: cfg.username
      ? {
          user: cfg.authUsername || cfg.username,
          password: cfg.password,
          realm: cfg.domain,
        }
      : undefined,
    allowedIps: cfg.allowedIps.length ? cfg.allowedIps : undefined,
    maxConcurrentCalls: cfg.maxConcurrentCalls,
    rtpPortMin: cfg.rtpPortMin,
    rtpPortMax: cfg.rtpPortMax,
    keepaliveTargets: [],
    logger: {
      error: (err: unknown) => log.error(String(err)),
      send: (msg: unknown) => log.info("sip send", { preview: sipPreview(msg) }),
      recv: (msg: unknown) => log.info("sip recv", { preview: sipPreview(msg) }),
    },
  });

  stack.on("invite", (dialog) => {
    void handleInboundInvite(dialog, {
      sessions: deps.sessions,
      cfg,
      apiBase: deps.apiBase,
      channelQueue: deps.channelQueue,
    });
  });

  stack.on("error", (err) => {
    log.error("stack error", { err: String(err) });
  });

  await stack.start();
  log.info("SIP stack listening", {
    provider: cfg.provider,
    label: cfg.providerLabel,
    port: cfg.port,
    publicHost: cfg.publicHost,
    domain: cfg.domain,
    outboundProxy: cfg.outboundProxy || undefined,
    uriMode: cfg.uriMode,
    transport: cfg.transport,
    codec: cfg.payloadType === 8 ? "PCMA" : "PCMU",
  });

  const registrar = new SipRegistrar(stack, cfg);
  registrar.start();

  return {
    cfg,
    stack,
    registrar,
    stop: async () => {
      registrar.stop();
      await stack.stop();
    },
  };
}
