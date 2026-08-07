import { createLogger } from "@alo/shared";
import type { SipStack, SipRequest, SipResponse } from "@vexyl.ai/sip";
import * as digest from "@vexyl.ai/sip/digest";
import type { SipConfig } from "./config";

const log = createLogger("sip-register");

type DigestCtx = Record<string, unknown>;

/**
 * RFC 3261 REGISTER for SIP login/password mode (Zadarma, Beeline Business, …).
 */
export class SipRegistrar {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private cseq = 1;
  private callId = `reg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  private authCtx: DigestCtx = {};

  constructor(
    private stack: SipStack,
    private cfg: SipConfig
  ) {}

  start() {
    if (this.cfg.uriMode || !this.cfg.username || !this.cfg.password) {
      log.info("REGISTER skipped (URI mode or missing credentials)", {
        provider: this.cfg.provider,
      });
      return;
    }
    this.stopped = false;
    void this.registerOnce();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.registerOnce(0);
  }

  private aor(): string {
    return `sip:${this.cfg.username}@${this.cfg.domain}`;
  }

  private contact(): string {
    return `<sip:${this.cfg.username}@${this.cfg.publicHost}:${this.cfg.port}>`;
  }

  private buildRegister(expires: number): SipRequest {
    const aor = this.aor();
    const headers: Record<string, unknown> = {
      to: { uri: aor },
      from: { uri: aor, params: { tag: `r${Math.random().toString(36).slice(2, 10)}` } },
      "call-id": this.callId,
      cseq: { seq: this.cseq++, method: "REGISTER" },
      contact: [{ uri: `sip:${this.cfg.username}@${this.cfg.publicHost}:${this.cfg.port}` }],
      expires,
      "max-forwards": 70,
      "user-agent": `alo-voice-gateway/${this.cfg.provider}`,
    };

    // Beeline (and some trunks) require routing via outbound proxy
    if (this.cfg.outboundProxy) {
      headers.route = [{ uri: `sip:${this.cfg.outboundProxy};lr` }];
    }

    return {
      method: "REGISTER",
      uri: `sip:${this.cfg.domain}`,
      version: "2.0",
      headers,
    } as SipRequest;
  }

  private registerOnce(expires = this.cfg.registerExpires): Promise<void> {
    return new Promise((resolve) => {
      const creds = {
        user: this.cfg.authUsername || this.cfg.username,
        password: this.cfg.password,
        realm: this.cfg.domain,
      };

      const send = (rq: SipRequest) => {
        this.stack.send(rq, (rs: SipResponse) => {
          if (!rs) {
            log.error("REGISTER no response", { provider: this.cfg.provider });
            this.scheduleRetry(30);
            resolve();
            return;
          }

          if (rs.status === 401 || rs.status === 407) {
            digest.signRequest(this.authCtx as never, rq, rs, creds);
            rq.headers.cseq = { seq: this.cseq++, method: "REGISTER" };
            this.stack.send(rq, (rs2: SipResponse) => this.onFinal(rs2, expires, resolve));
            return;
          }

          this.onFinal(rs, expires, resolve);
        });
      };

      send(this.buildRegister(expires));
    });
  }

  private onFinal(rs: SipResponse | undefined, expires: number, resolve: () => void) {
    if (!rs) {
      log.error("REGISTER final empty", { provider: this.cfg.provider });
      this.scheduleRetry(30);
      resolve();
      return;
    }
    if (rs.status >= 200 && rs.status < 300) {
      const contact0 = Array.isArray(rs.headers.contact) ? rs.headers.contact[0] : undefined;
      const granted =
        Number(rs.headers.expires) ||
        Number((contact0 as { params?: { expires?: string } } | undefined)?.params?.expires) ||
        expires;
      log.info("REGISTER ok", {
        provider: this.cfg.provider,
        expires: granted,
        contact: this.contact(),
        outboundProxy: this.cfg.outboundProxy || undefined,
      });
      if (!this.stopped && expires > 0) {
        const refreshMs = Math.max(30, Math.floor(granted * 0.8)) * 1000;
        this.timer = setTimeout(() => void this.registerOnce(), refreshMs);
      }
    } else {
      log.error("REGISTER failed", {
        provider: this.cfg.provider,
        status: rs.status,
        reason: rs.reason,
      });
      if (!this.stopped && expires > 0) this.scheduleRetry(60);
    }
    resolve();
  }

  private scheduleRetry(seconds: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.registerOnce(), seconds * 1000);
  }
}
