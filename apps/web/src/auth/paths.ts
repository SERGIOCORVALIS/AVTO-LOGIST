import type { StaffRole } from "../api/types";

export function homePath(role: StaffRole): string {
  return role === "director" ? "/director" : "/manager";
}

export const MANAGER_NAV = [
  { to: "", label: "Пульт" },
  { to: "deals", label: "Сделки" },
  { to: "clients", label: "Клиенты" },
  { to: "escalations", label: "Эскалации" },
  { to: "documents", label: "Документы" },
] as const;

export const DIRECTOR_NAV = [
  ...MANAGER_NAV,
  { to: "policy", label: "Политика робота" },
  { to: "playbooks", label: "Playbooks" },
  { to: "partners", label: "Поставщики" },
  { to: "parsers", label: "Парсеры" },
  { to: "managers", label: "Менеджеры" },
  { to: "company", label: "Компания" },
] as const;

export const DIRECTOR_ONLY_SEGMENTS = [
  "policy",
  "playbooks",
  "partners",
  "parsers",
  "managers",
  "company",
] as const;

export function navForRole(role: StaffRole) {
  return role === "director" ? DIRECTOR_NAV : MANAGER_NAV;
}

export function isDirectorOnlySegment(segment: string): boolean {
  return (DIRECTOR_ONLY_SEGMENTS as readonly string[]).includes(segment);
}
