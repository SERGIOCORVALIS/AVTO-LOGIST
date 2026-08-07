import { createLogger } from "@alo/shared";
import type { Dialog } from "@vexyl.ai/sip";
import { managerSipUri, type SipConfig } from "./config";

const log = createLogger("voice-transfer");

export async function transferDialogToManager(
  dialog: Dialog | undefined,
  cfg: SipConfig,
  reason: string
): Promise<boolean> {
  const transferTo = cfg.managerTransferNumber || process.env.VOICE_MANAGER_TRANSFER_NUMBER;
  if (!dialog) {
    log.warn("transfer skipped — no active SIP dialog", { reason });
    return false;
  }
  if (!transferTo) {
    log.warn("transfer skipped — VOICE_MANAGER_TRANSFER_NUMBER not set", { reason });
    return false;
  }

  const targetUri = managerSipUri(transferTo, cfg.domain);
  try {
    await dialog.refer(targetUri);
    log.info("SIP REFER ok", {
      reason,
      to: transferTo,
      targetUri,
      provider: cfg.provider,
    });
    return true;
  } catch (err) {
    log.error("SIP REFER failed", { err: String(err), reason, targetUri });
    return false;
  }
}
