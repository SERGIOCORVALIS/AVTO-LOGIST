export type Corridor = "ru_domestic" | "cn_import" | "international";

export type TransportMode =
  | "ltl_groupage"
  | "road_train"
  | "container"
  | "rail"
  | "air"
  | "ftl_truck"
  | "sea"
  | "night_express";

export type CargoClass =
  | "tare_piece"
  | "dimensional"
  | "oversized"
  | "dangerous";

export type Incoterm2020 =
  | "EXW"
  | "FCA"
  | "FAS"
  | "FOB"
  | "CFR"
  | "CIF"
  | "CPT"
  | "CIP"
  | "DAP"
  | "DPU"
  | "DDP";

export type ServiceId =
  | "logistics"
  | "buyout"
  | "supplier_sourcing"
  | "customs_clearance"
  | "certification"
  | "insurance"
  | "night_express";

/** @deprecated use ServiceId — kept for existing imports */
export type CnServiceId = ServiceId;

export interface DealServices {
  logistics?: boolean;
  buyout?: boolean;
  supplier_sourcing?: boolean;
  customs_clearance?: boolean;
  certification?: boolean;
  insurance?: boolean;
  night_express?: boolean;
}

export const INCOTERMS_2020: Incoterm2020[] = [
  "EXW",
  "FCA",
  "FAS",
  "FOB",
  "CFR",
  "CIF",
  "CPT",
  "CIP",
  "DAP",
  "DPU",
  "DDP",
];

export const CORRIDORS: Corridor[] = [
  "ru_domestic",
  "cn_import",
  "international",
];

export const SERVICE_IDS: ServiceId[] = [
  "logistics",
  "buyout",
  "supplier_sourcing",
  "customs_clearance",
  "certification",
  "insurance",
  "night_express",
];

/** @deprecated use SERVICE_IDS */
export const CN_SERVICE_IDS = SERVICE_IDS;

/**
 * Courier networks we do not auto-RFQ. Mentioning them is not a hard product ban.
 * Groupage players (ПЭК, ДЛ, Байкал, …) may be TRANSINVEST suppliers.
 */
export const COURIER_HINT_LABELS = ["СДЭК"] as const;

/** @deprecated TZ v1: groupage competitors may be suppliers — use GROUPAGE_SUPPLIER_LABELS */
export const FORBIDDEN_CARRIER_LABELS = COURIER_HINT_LABELS;

/** Groupage: competitor may simultaneously be a supplier — do not forbid RFQ. */
export const GROUPAGE_SUPPLIER_LABELS = [
  "ПЭК",
  "Деловые Линии",
  "Байкал-Сервис",
  "КИТ",
  "Энергия",
  "Шерл",
  "Азимут",
  "Дальэкспресс",
] as const;

/** Competitor AND possible groupage supplier (benchmark + RFQ ok). */
export const COMPETITOR_LABELS = ["ПЭК"] as const;

export const HARD_STOP_LABELS = [
  "налив / liquid bulk",
  "частный переезд",
  "санкционные товары",
  "серые схемы",
] as const;

export function formatIncotermsPair(
  origin?: string | null,
  dest?: string | null
): string {
  const o = (origin || "").toUpperCase().trim();
  const d = (dest || "").toUpperCase().trim();
  if (o && d) return `${o}-${d}`;
  return o || d || "";
}

export function isInternationalCorridor(
  corridor?: Corridor | string | null
): boolean {
  return corridor === "cn_import" || corridor === "international";
}

export function defaultServices(
  corridor?: Corridor | string | null
): DealServices {
  if (corridor === "ru_domestic") {
    return {
      logistics: true,
      buyout: false,
      supplier_sourcing: false,
      customs_clearance: false,
      certification: false,
      insurance: false,
      night_express: false,
    };
  }
  return {
    logistics: true,
    buyout: false,
    supplier_sourcing: false,
    customs_clearance: true,
    certification: false,
    insurance: false,
    night_express: false,
  };
}
