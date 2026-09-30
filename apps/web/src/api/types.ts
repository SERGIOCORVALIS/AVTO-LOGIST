export type StaffRole = "director" | "manager";

export interface StaffUser {
  id: string;
  email: string;
  role: StaffRole;
  name: string;
  active?: boolean;
  last_login_at?: string | null;
  created_at?: string;
}

export interface ManagerAccount extends StaffUser {
  active: boolean;
}

export interface IssuedCredentials {
  user: ManagerAccount;
  login: string;
  password: string;
}

export interface StaffEvent {
  id: string;
  actor_id?: string | null;
  actor_email?: string | null;
  actor_role?: string | null;
  action: string;
  target_id?: string | null;
  target_email?: string | null;
  summary: string;
  meta?: Record<string, unknown>;
  ip?: string | null;
  created_at: string;
}

export interface Deal {
  id: string;
  channel?: string;
  client_id?: string | null;
  tg_chat_id?: number | null;
  client_name?: string | null;
  client_phone?: string | null;
  status: string;
  previous_status?: string | null;
  cargo: Record<string, unknown>;
  route: Record<string, unknown>;
  hs_codes?: unknown[];
  cost_breakdown?: Record<string, unknown>;
  offer: Record<string, unknown>;
  margin_pct?: number | null;
  currency?: string;
  amount_rub?: number | null;
  risks?: Array<{ code?: string; severity?: string; description?: string }>;
  next_actions?: string[];
  takeover: boolean;
  paused: boolean;
  escalate: boolean;
  playbook_version?: string | null;
  confidence?: number | null;
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export interface DealMessage {
  id: string;
  deal_id: string;
  direction: string;
  sender: string;
  text: string;
  created_at: string;
}

export interface Escalation {
  id: string;
  deal_id: string;
  reason: string;
  summary: string;
  numbers?: Record<string, unknown>;
  risks?: unknown[];
  recommendation?: string | null;
  needed_decision?: string | null;
  status: string;
  manager_note?: string | null;
  created_at: string;
  client_name?: string | null;
  amount_rub?: number | null;
  margin_pct?: number | null;
}

export interface PolicyConfig {
  target_margin_pct: number;
  floor_margin_pct: number;
  max_discount_pct: number;
  escalate_amount_rub: number;
  require_human_kp_approve?: boolean;
  first_reply_sla_sec: number;
  quote_sla_hours: number;
  learning_enabled: boolean;
  canary_pct: number;
  min_gross_profit_rub?: number;
  ru_vat_pct?: number;
  broker_cost_rub?: number;
  broker_client_price_rub?: number;
  certification_markup_pct?: number;
  buyout_commission_pct?: number;
  buyout_fx_markup_rub?: number;
  rfq_target_min?: number;
  rfq_target_max?: number;
  importer_scheme?: string;
  [key: string]: unknown;
}

export interface Playbook {
  id: string;
  name: string;
  version: string;
  body: Record<string, unknown>;
  status: string;
  canary_pct?: number;
  created_at: string;
}

export interface Partner {
  id: string;
  name: string;
  code?: string | null;
  api_base_url?: string | null;
  score: number;
  active: boolean;
  modes?: string[] | null;
  emails?: string[] | null;
  supplier_id?: string | null;
  supplier_active?: boolean | null;
  supplier_modes?: string[] | null;
  supplier_corridors?: string[] | null;
  left_market?: boolean;
  silent?: boolean;
  silent_at?: string | null;
  silent_note?: string | null;
  last_rfq_at?: string | null;
  last_reply_at?: string | null;
  no_reply_streak?: number;
  status?: "active" | "silent" | "left" | "paused";
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface PartnerListResponse {
  items: Partner[];
  counts: {
    active: number;
    silent: number;
    left: number;
    paused: number;
    all: number;
  };
}

export interface ArchiveItem {
  id: string;
  deal_id: string;
  client_name: string | null;
  folder: DocumentFolder;
  kind: string;
  filename: string;
  source: "attachment" | "quote" | "contract";
  content_type?: string;
  bytes?: number;
  created_at?: string;
  extra?: Record<string, unknown>;
}

export type DocumentFolder =
  | "kp"
  | "contracts"
  | "invoices"
  | "customs"
  | "client"
  | "other";

export interface StatsSummary {
  by_status: Array<{ status: string; n: number; avg_margin: number; revenue: number }>;
  pending_escalations: number;
  robot?: {
    paused: number;
    takeover: number;
    awaiting_manager: number;
    open_deals: number;
  };
}

export interface CalendarEvent {
  id: string;
  deal_id?: string | null;
  kind: string;
  title: string;
  due_at: string;
  done: boolean;
}

export interface CallBundle {
  active: Record<string, unknown> | null;
  recent: Array<Record<string, unknown>>;
}

export const STATUS_LABELS: Record<string, string> = {
  intake: "Приём",
  sizing: "Замеры",
  customs: "Таможня",
  quoting: "Котировки",
  pricing: "Цена",
  negotiation: "Переговоры",
  contract: "Договор",
  execution: "Исполнение",
  awaiting_manager: "Ждёт человека",
  closed_won: "Выиграна",
  closed_lost: "Проиграна",
  cancelled: "Отмена",
};

export const FOLDER_LABELS: Record<DocumentFolder, string> = {
  kp: "КП и расчёты",
  contracts: "Договоры",
  invoices: "Счета и инвойсы",
  customs: "Таможня и сертификаты",
  client: "Вложения клиента",
  other: "Прочее",
};

export const PIPELINE = [
  "intake",
  "sizing",
  "customs",
  "quoting",
  "pricing",
  "negotiation",
  "contract",
  "execution",
] as const;

export interface ClientListItem {
  id: string;
  name: string | null;
  legal_name: string | null;
  primary_email: string | null;
  phone: string | null;
  inn: string | null;
  vip: boolean;
  abc: Record<string, unknown>;
  personal_context: Record<string, unknown>;
  preferred_comm: string | null;
  created_at: string;
  updated_at: string;
  calc_count: number;
  identity_count: number;
  deal_count: number;
  invoice_count: number;
  contract_count: number;
  attachment_count?: number;
  contract_file_count?: number;
  invoice_file_count?: number;
}

export interface ClientListResponse {
  items: ClientListItem[];
  limit: number;
  offset: number;
  total: number;
}

export interface ClientIdentity {
  id: string;
  kind: string;
  value: string;
  value_norm: string;
  source: string | null;
  confidence: number;
  created_at: string;
}

export interface ClientCalcRequest {
  id: string;
  origin: string | null;
  destination: string | null;
  mode: string | null;
  cargo_desc: string | null;
  ready_date: string | null;
  amount: number | null;
  currency: string | null;
  requested_at: string | null;
  source_message_id: string | null;
  raw: Record<string, unknown>;
}

export interface ClientFact {
  id: string;
  fact_type: string;
  value: string;
  confidence: number;
  source_message_id: string | null;
  created_at: string;
}

export interface MailThread {
  id: string;
  thread_key: string;
  subject_norm: string | null;
  first_at: string | null;
  last_at: string | null;
  message_count: number;
}

export interface ClientMailPreview {
  id: string;
  mailbox_id: string;
  folder: string;
  subject: string | null;
  from_email: string | null;
  sent_at: string | null;
  role: string;
  direction: string | null;
  preview: string | null;
}

export interface ClientCard {
  client: ClientListItem & Record<string, unknown>;
  identities: ClientIdentity[];
  calc_requests: ClientCalcRequest[];
  facts: ClientFact[];
  threads: MailThread[];
  deals: Array<{
    id: string;
    status: string;
    channel: string;
    client_name: string | null;
    client_phone: string | null;
    route: Record<string, unknown>;
    cargo: Record<string, unknown>;
    amount_rub: number | null;
    margin_pct: number | null;
    created_at: string;
    updated_at: string;
  }>;
  recent_mail: ClientMailPreview[];
  attachments?: MailAttachment[];
  docs_summary?: ClientDocsSummary;
}

export interface ArchiveSummary {
  totals: {
    clients: number;
    messages: number;
    threads: number;
    calcs: number;
    deals_linked: number;
    attachments?: number;
    service_providers?: number;
  };
  mailboxes: Array<{
    mailbox_id: string;
    messages: number;
    clients: number;
    first_at: string | null;
    last_at: string | null;
  }>;
  modes: Array<{ mode: string; n: number }>;
  facts: Array<{ fact_type: string; n: number }>;
  service_providers?: ServiceProviderRow[];
}

export const MODE_LABELS: Record<string, string> = {
  sea: "Море",
  rail: "Ж/Д",
  air: "Авиа",
  road: "Авто",
  ftl_truck: "Фура FTL",
  ltl_groupage: "Сборка LTL",
  multimodal: "Мультимодал",
};

export const FACT_LABELS: Record<string, string> = {
  invoice: "Счета",
  contract: "Договоры",
  phone: "Телефоны",
  inn: "ИНН",
  preferred_mode: "Режим перевозки",
  folder_client: "Папка в почте",
};

export const MAILBOX_LABELS: Record<string, string> = {
  m5: "m5 (менеджер 5)",
  m13: "m13 (менеджер 13)",
  a1: "a1 (Александра)",
  m1: "m1 (менеджер 1)",
  info: "info (офис, счета/договоры)",
  "rzd-perevoz": "rzd-perevoz (личная Яндекс)",
};

export interface MailAttachment {
  id: string;
  filename: string;
  content_type: string | null;
  bytes: number | null;
  kind: string;
  sha256: string;
  storage_key: string;
  created_at: string;
  mail_subject?: string | null;
  mail_sent_at?: string | null;
  mailbox_id?: string | null;
  folder?: string | null;
}

export interface ClientDocsSummary {
  contracts: number;
  invoices: number;
  payments: number;
  kp: number;
  other: number;
  total: number;
}

export const ATTACHMENT_KIND_LABELS: Record<string, string> = {
  contracts: "Договор",
  invoices: "Счёт / УПД",
  payments: "Платёжка",
  kp: "КП / расчёт",
  customs: "Таможня",
  client: "Документ клиента",
  other: "Прочее",
};


export interface ServiceProviderRow {
  id: string;
  name: string;
  category: string;
  primary_email: string | null;
  message_count: number;
}

export const SERVICE_CATEGORY_LABELS: Record<string, string> = {
  post: "Почта / доставка",
  fuel: "Топливные карты",
  glonass: "ГЛОНАСС",
  tracking: "Трекинг",
  telecom: "Связь / телефония",
  bank: "Банк",
  it_saas: "IT / SaaS",
  other_service: "Прочие услуги",
};

export const DIRECTOR_ESCALATION_REASONS = new Set([
  "amount_threshold",
  "margin_or_discount_policy",
  "profit_below_minimum",
  "cashflow_gap",
  "legal_must_approve",
  "grey_scheme_hard_block",
  "grey_scheme_request",
  "sanctioned_goods",
  "procurement_loss_pattern",
]);

export interface ParserSettings {
  id: string;
  enabled: boolean;
  cron: string;
  enrich_emails: boolean;
  auto_seed: boolean;
  updated_at?: string;
}

export interface ParserRun {
  id: string;
  parser_id: string;
  status: string;
  triggered_by: string;
  triggered_by_staff_id?: string | null;
  started_at: string;
  finished_at?: string | null;
  stats?: {
    parse?: { total?: number; with_email?: number; kazato?: number; bamap?: number };
    seed?: { partners?: number; contacts?: number; suppliers?: number };
    enrich?: { found?: number; not_found?: number; errors?: number };
    error?: string;
  };
  error?: string | null;
  log_path?: string | null;
}

export interface ParserStatus {
  parser_id: string;
  settings: ParserSettings;
  catalog_counts?: Record<string, number> | null;
  active_run?: { id: string; status: string; started_at: string } | null;
  runs: ParserRun[];
}
