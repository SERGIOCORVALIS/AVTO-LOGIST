import type { FastifyInstance } from "fastify";
import { createLogger } from "@alo/shared";
import type { SessionManager } from "../sessions";
import type { SipConfig } from "./config";
import { transferDialogToManager } from "./transfer";

const log = createLogger("sip-routes");

export function registerSipHttpRoutes(
  app: FastifyInstance,
  sessions: SessionManager,
  getCfg: () => SipConfig | null
) {
  app.post("/internal/takeover/:dealId", async (req, reply) => {
    const { dealId } = req.params as { dealId: string };
    const active = await sessions.getActiveForDeal(dealId);
    if (!active) return reply.code(404).send({ error: "no_active_call" });

    const live = sessions.get(active.id);
    if (!live) return reply.code(404).send({ error: "no_live_session" });

    live.transferRequested = true;
    live.bridge?.requestTransfer("manager_takeover");

    const cfg = getCfg();
    if (cfg) {
      const ok = await transferDialogToManager(live.dialog, cfg, "manager_takeover");
      if (!ok) log.warn("takeover REFER failed", { dealId, callSessionId: live.callSessionId });
    } else {
      log.warn("takeover — SIP config missing", { dealId });
    }

    await sessions.endCall(live.callSessionId, "transferred");
    return reply.send({ ok: true, call_session_id: live.callSessionId });
  });
}
