export type DealStatus =
  | "intake"
  | "sizing"
  | "customs"
  | "quoting"
  | "pricing"
  | "negotiation"
  | "contract"
  | "execution"
  | "awaiting_manager"
  | "closed_won"
  | "closed_lost"
  | "cancelled";

export type Channel = "telegram" | "voice" | "email";

export type CallSessionStatus =
  | "ringing"
  | "active"
  | "completed"
  | "transferred"
  | "failed";

export interface CargoInfo {
  name?: string;
  category?: string;
  quantity?: number;
  material?: string;
  brand?: string;
  model?: string;
  url?: string;
  notes?: string;
  hazardous?: boolean;
  battery?: boolean;
  length_cm?: number;
  width_cm?: number;
  height_cm?: number;
  weight_kg?: number;
  invoice_value?: number;
  invoice_currency?: string;
  invoice_value_rub?: number;
}

export interface RouteInfo {
  origin_city?: string;
  origin_country?: string;
  destination_city?: string;
  destination_country?: string;
  incoterms?: string;
  ready_date?: string;
}

export interface CostBreakdown {
  freight?: number;
  customs?: number;
  duty?: number;
  vat?: number;
  excise?: number;
  broker?: number;
  certs?: number;
  local?: number;
  insurance?: number;
  ops?: number;
  risk_buffer?: number;
  total?: number;
  duties_estimate?: Record<string, unknown>;
}

export interface OfferInfo {
  price?: number;
  currency?: string;
  includes?: string[];
  excludes?: string[];
  eta_days_min?: number;
  eta_days_max?: number;
  valid_until?: string;
  is_estimate?: boolean;
}

export interface RiskItem {
  code: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  mitigation?: string;
}

export interface DealCard {
  id: string;
  channel?: Channel;
  tg_chat_id?: number | null;
  tg_user_id?: number | null;
  client_phone?: string | null;
  client_name?: string | null;
  status: DealStatus;
  previous_status?: DealStatus | null;
  cargo: CargoInfo;
  route: RouteInfo;
  dims_source?: string | null;
  hs_codes: unknown[];
  cost_breakdown: CostBreakdown;
  offer: OfferInfo;
  margin_pct?: number | null;
  currency: string;
  amount_rub?: number | null;
  risks: RiskItem[];
  next_actions: string[];
  takeover: boolean;
  paused: boolean;
  escalate: boolean;
  playbook_version?: string | null;
  confidence?: number | null;
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
}

export interface VoiceInboundEvent {
  type: "voice.inbound";
  call_session_id: string;
  phone: string;
  provider_call_id?: string;
  text?: string;
  timestamp: string;
  idempotency_key: string;
}

export interface VoiceEscalateCommand {
  type: "voice.escalate";
  deal_id: string;
  call_session_id: string;
  phone: string;
  reason: string;
  summary: string;
}

export type MessageDirection = "inbound" | "outbound" | "system";

export interface CallSession {
  id: string;
  deal_id?: string | null;
  provider_call_id?: string | null;
  phone: string;
  direction: "inbound" | "outbound";
  status: CallSessionStatus;
  started_at?: string;
  ended_at?: string | null;
  recording_url?: string | null;
  transcript: Array<{ role: string; text: string; ts?: string }>;
  metadata: Record<string, unknown>;
}

export interface InboundMessageEvent {
  type: "tg.inbound";
  chat_id: number;
  user_id?: number;
  message_id?: number;
  text: string;
  client_name?: string;
  timestamp: string;
  idempotency_key: string;
}

export interface OutboundMessageCommand {
  type: "tg.outbound";
  chat_id: number;
  text: string;
  deal_id?: string;
  delay_ms?: number;
  idempotency_key: string;
}

export interface EscalateCommand {
  type: "escalate";
  deal_id: string;
  reason: string;
  summary: string;
  numbers?: Record<string, unknown>;
  risks?: RiskItem[];
  recommendation?: string;
  needed_decision?: string;
}

export interface ChannelPostCommand {
  type: "channel.post";
  kind: "alert" | "digest" | "learning" | "info";
  text: string;
  deal_id?: string;
}

export interface QuoteCompareItem {
  id: string;
  partner?: string;
  source: string;
  price: number;
  currency: string;
  eta_days_min?: number;
  eta_days_max?: number;
  valid_until?: string;
  total_landed?: number;
  score?: number;
}

export interface LegalResearchResult {
  hs_candidates: Array<{
    code: string;
    description: string;
    duty_rate?: string;
    uncertainty: number;
  }>;
  duties_estimate: Record<string, unknown>;
  compliance_flags: string[];
  law_changes_relevant: string[];
  contract_draft_md: string;
  client_risk_summary: string;
  must_approve: boolean;
  confidence: number;
  sources: string[];
}

export interface PolicyConfig {
  target_margin_pct: number;
  floor_margin_pct: number;
  max_discount_pct: number;
  escalate_amount_rub: number;
  first_reply_sla_sec: number;
  quote_sla_hours: number;
  learning_enabled: boolean;
  canary_pct: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  target_margin_pct: 18,
  floor_margin_pct: 10,
  max_discount_pct: 8,
  escalate_amount_rub: 500_000,
  first_reply_sla_sec: 120,
  quote_sla_hours: 2,
  learning_enabled: true,
  canary_pct: 10,
};

export const QUEUES = {
  inbound: "alo:inbound",
  outbound: "alo:outbound",
  orchestrate: "alo:orchestrate",
  escalate: "alo:escalate",
  channel: "alo:channel",
  email: "alo:email",
  ocr: "alo:ocr",
  calendar: "alo:calendar",
  sla: "alo:sla",
  digest: "alo:digest",
  learning: "alo:learning",
  voice: "alo:voice",
  dlq: "alo:dlq",
} as const;

export * from "./logger";
export * from "./tgAccounts";
export * from "./company";
export * from "./license";
