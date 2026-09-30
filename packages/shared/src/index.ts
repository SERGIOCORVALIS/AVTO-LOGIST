import type {
  CargoClass,
  Corridor,
  Incoterm2020,
  TransportMode,
} from "./catalog";

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
  cargo_class?: CargoClass;
  quantity?: number;
  material?: string;
  brand?: string;
  model?: string;
  url?: string;
  notes?: string;
  hazardous?: boolean;
  battery?: boolean;
  is_liquid?: boolean;
  dual_use?: boolean;
  dg_un_number?: string;
  dg_class?: string;
  length_cm?: number;
  width_cm?: number;
  height_cm?: number;
  weight_kg?: number;
  volume_m3?: number;
  cargo_value?: number;
  invoice_value?: number;
  invoice_currency?: string;
  invoice_value_rub?: number;
}

export interface RouteInfo {
  origin_city?: string;
  origin_country?: string;
  destination_city?: string;
  destination_country?: string;
  corridor?: Corridor;
  transport_mode?: TransportMode;
  origin_incoterm?: Incoterm2020;
  dest_incoterm?: Incoterm2020;
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
  effective_supplier_cost?: number;
  supplier_vat_mode?: string;
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
  raw_supplier_quote?: number;
  supplier_vat_mode?: string;
  effective_supplier_cost?: number;
  client_price_vat_mode?: string;
  gross_profit_rub?: number;
  margin_pct?: number;
  calculation_assumptions?: string[];
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
  /** Pilot: hold client KP until staff approve (Management Bot / cabinet). */
  require_human_kp_approve?: boolean;
  first_reply_sla_sec: number;
  quote_sla_hours: number;
  learning_enabled: boolean;
  canary_pct: number;
  /** TZ v1 — configurable commercial rules */
  min_gross_profit_rub?: number;
  ru_vat_pct?: number;
  client_ru_sells_with_vat?: boolean;
  intl_freight_vat_pct?: number;
  broker_cost_rub?: number;
  broker_client_price_rub?: number;
  certification_markup_pct?: number;
  buyout_commission_pct?: number;
  buyout_fx_markup_rub?: number;
  prepay_preferred_pct?: number;
  prepay_min_pct_under_1m?: number;
  staged_payment_threshold_rub?: number;
  rfq_target_min?: number;
  rfq_target_max?: number;
  importer_scheme?: string;
  customs_confirmed_autonomy_threshold?: number;
  followup_default_hours?: number[];
  followup_urgent_hours?: number;
  shipment_urgent_days?: number;
  vip_volume_min?: number;
  vip_volume_max?: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  target_margin_pct: 18,
  floor_margin_pct: 10,
  max_discount_pct: 8,
  escalate_amount_rub: 500_000,
  require_human_kp_approve: true,
  first_reply_sla_sec: 120,
  quote_sla_hours: 2,
  learning_enabled: true,
  canary_pct: 10,
  min_gross_profit_rub: 3000,
  ru_vat_pct: 22,
  client_ru_sells_with_vat: true,
  intl_freight_vat_pct: 0,
  broker_cost_rub: 15000,
  broker_client_price_rub: 20000,
  certification_markup_pct: 5,
  buyout_commission_pct: 5,
  buyout_fx_markup_rub: 0.45,
  prepay_preferred_pct: 100,
  prepay_min_pct_under_1m: 50,
  staged_payment_threshold_rub: 1_000_000,
  rfq_target_min: 10,
  rfq_target_max: 20,
  importer_scheme: "manual",
  customs_confirmed_autonomy_threshold: 500,
  followup_default_hours: [24, 72, 168],
  followup_urgent_hours: 2,
  shipment_urgent_days: 14,
  vip_volume_min: 5,
  vip_volume_max: 50,
};

export const QUEUES = {
  inbound: "alo-inbound",
  outbound: "alo-outbound",
  orchestrate: "alo-orchestrate",
  escalate: "alo-escalate",
  channel: "alo-channel",
  email: "alo-email",
  ocr: "alo-ocr",
  calendar: "alo-calendar",
  sla: "alo-sla",
  digest: "alo-digest",
  learning: "alo-learning",
  voice: "alo-voice",
  dlq: "alo-dlq",
} as const;

export * from "./logger";
export * from "./tgAccounts";
export * from "./company";
export * from "./license";
export * from "./proxy";
export * from "./catalog";
export * from "./office";
export * from "./staffCopy";
export * from "./loadRootEnv";
export * from "./pdfSimple";
export * from "./openai";
export * from "./mailRules";
