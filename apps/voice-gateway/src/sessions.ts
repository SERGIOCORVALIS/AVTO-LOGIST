import { Pool } from "pg";
import { createLogger } from "@alo/shared";
import type { RealtimeBridge } from "./realtime/bridge";
import type { Dialog } from "@vexyl.ai/sip";

const log = createLogger("voice-sessions");

export interface LiveSession {
  callSessionId: string;
  dealId: string;
  phone: string;
  providerCallId?: string;
  bridge?: RealtimeBridge;
  dialog?: Dialog;
  transferRequested?: boolean;
  maxCallTimer?: ReturnType<typeof setTimeout>;
}

export class SessionManager {
  private live = new Map<string, LiveSession>();
  private byProviderId = new Map<string, string>();

  constructor(private pool: Pool) {}

  get(callSessionId: string): LiveSession | undefined {
    return this.live.get(callSessionId);
  }

  getByProviderCallId(providerCallId: string): LiveSession | undefined {
    const id = this.byProviderId.get(providerCallId);
    return id ? this.live.get(id) : undefined;
  }

  set(session: LiveSession) {
    this.live.set(session.callSessionId, session);
    if (session.providerCallId) {
      this.byProviderId.set(session.providerCallId, session.callSessionId);
    }
  }

  remove(callSessionId: string) {
    const s = this.live.get(callSessionId);
    if (s?.maxCallTimer) clearTimeout(s.maxCallTimer);
    s?.bridge?.close();
    if (s?.providerCallId) this.byProviderId.delete(s.providerCallId);
    this.live.delete(callSessionId);
  }

  normalizePhone(phone: string): string {
    const raw = phone.trim();
    if (raw.startsWith("+")) return `+${raw.slice(1).replace(/\D/g, "")}`;
    const digits = raw.replace(/\D/g, "");
    if (digits.startsWith("8") && digits.length === 11) return `+7${digits.slice(1)}`;
    if (digits.startsWith("7") && digits.length === 11) return `+${digits}`;
    return `+${digits}`;
  }

  async startCall(params: {
    phone: string;
    providerCallId?: string;
    clientName?: string;
  }): Promise<LiveSession> {
    const phone = this.normalizePhone(params.phone);
    const dealRes = await this.pool.query(
      `SELECT id FROM deals
       WHERE channel = 'voice' AND client_phone = $1
         AND status NOT IN ('closed_won','closed_lost','cancelled')
       ORDER BY updated_at DESC LIMIT 1`,
      [phone]
    );
    let dealId: string;
    if (dealRes.rows[0]) {
      dealId = dealRes.rows[0].id;
    } else {
      const ins = await this.pool.query(
        `INSERT INTO deals (channel, client_phone, client_name, status)
         VALUES ('voice', $1, $2, 'intake') RETURNING id`,
        [phone, params.clientName ?? null]
      );
      dealId = ins.rows[0].id;
    }

    const cs = await this.pool.query(
      `INSERT INTO call_sessions (deal_id, provider_call_id, phone, status)
       VALUES ($1, $2, $3, 'ringing') RETURNING id`,
      [dealId, params.providerCallId ?? null, phone]
    );
    const callSessionId = cs.rows[0].id as string;
    const session: LiveSession = {
      callSessionId,
      dealId,
      phone,
      providerCallId: params.providerCallId,
    };
    this.set(session);
    log.info("call started", { callSessionId, dealId, phone });
    return session;
  }

  async markActive(callSessionId: string) {
    await this.pool.query(`UPDATE call_sessions SET status = 'active' WHERE id = $1`, [
      callSessionId,
    ]);
  }

  async appendTranscript(callSessionId: string, role: string, text: string) {
    const entry = { role, text, ts: new Date().toISOString() };
    await this.pool.query(
      `UPDATE call_sessions SET transcript = transcript || $2::jsonb WHERE id = $1`,
      [callSessionId, JSON.stringify([entry])]
    );
  }

  async endCall(
    callSessionId: string,
    status: "completed" | "transferred" | "failed",
    recordingUrl?: string
  ) {
    await this.pool.query(
      `UPDATE call_sessions
       SET status = $2, ended_at = NOW(), recording_url = COALESCE($3, recording_url)
       WHERE id = $1`,
      [callSessionId, status, recordingUrl ?? null]
    );
    this.remove(callSessionId);
    log.info("call ended", { callSessionId, status });
  }

  async getById(callSessionId: string) {
    const r = await this.pool.query(`SELECT * FROM call_sessions WHERE id = $1`, [callSessionId]);
    return r.rows[0] ?? null;
  }

  async loadLive(callSessionId: string): Promise<LiveSession | null> {
    const existing = this.live.get(callSessionId);
    if (existing) return existing;
    const row = await this.getById(callSessionId);
    if (!row) return null;
    const session: LiveSession = {
      callSessionId: row.id,
      dealId: row.deal_id,
      phone: row.phone,
      providerCallId: row.provider_call_id ?? undefined,
    };
    this.set(session);
    return session;
  }

  async getActiveForDeal(dealId: string) {
    const r = await this.pool.query(
      `SELECT * FROM call_sessions
       WHERE deal_id = $1 AND status IN ('ringing', 'active')
       ORDER BY started_at DESC LIMIT 1`,
      [dealId]
    );
    return r.rows[0] ?? null;
  }
}
