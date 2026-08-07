import { createLogger } from "@alo/shared";
import { SipStack } from "@vexyl.ai/sip/stack";
import type { Queue } from "bullmq";
import type { SessionManager } from "../sessions";
import { loadSipConfig, type SipConfig } from "./config";
import { SipRegistrar } from "./register";
import { handleInboundInvite } from "./calls";

const log = createLogger("sip-trunk");

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
    address: cfg.bindHost,
    publicAddress: cfg.publicHost,
    hostname: cfg.publicHost,
    udp: true,
    tcp: false,
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
    keepaliveTargets: [{ uri: cfg.keepaliveUri, interval: 30000 }],
    logger: {
      error: (err: unknown) => log.error(String(err)),
      send: (msg: string) => log.info("sip send", { msg: String(msg).slice(0, 120) }),
      recv: (msg: string) => log.info("sip recv", { msg: String(msg).slice(0, 120) }),
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
