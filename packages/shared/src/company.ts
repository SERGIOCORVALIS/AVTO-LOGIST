/**
 * Legal entity profile for customer-facing channels (voice, email, contracts).
 * Override via COMPANY_* env vars. Product name remains AutoLogistics OS.
 */
export interface CompanyProfile {
  legal_name: string;
  short_name: string;
  ogrn: string;
  ogrn_date: string;
  registration_date: string;
  inn: string;
  kpp: string;
  legal_address: string;
  director_title: string;
  director_name: string;
  director_since: string;
  status: string;
  status_assigned: string;
  okved_code: string;
  okved_name: string;
  tax_authority: string;
  tax_authority_since: string;
  okpo: string;
  okato: string;
  oktmo: string;
  okfs: string;
  okfs_name: string;
  okogu: string;
  okogu_name: string;
  okopf: string;
  okopf_name: string;
  phone: string;
  email: string;
  website: string;
}

export const DEFAULT_COMPANY: CompanyProfile = {
  legal_name: 'ООО «ЖД Трансинвест»',
  short_name: "ЖД Трансинвест",
  ogrn: "1205400060260",
  ogrn_date: "16.12.2020",
  registration_date: "16.12.2020",
  inn: "5401401513",
  kpp: "540601001",
  legal_address:
    "630007, Новосибирская область, г Новосибирск, Октябрьская ул, зд. 42, офис 308",
  director_title: "Директор",
  director_name: "Тарасова Александра Викторовна",
  director_since: "16.12.2020",
  status: "микропредприятие",
  status_assigned: "10.01.2021",
  okved_code: "52.29",
  okved_name: "Деятельность вспомогательная прочая, связанная с перевозками",
  tax_authority:
    "Межрайонная инспекция ФНС России № 22 по Новосибирской области",
  tax_authority_since: "23.08.2022",
  okpo: "46701699",
  okato: "50401386000",
  oktmo: "50701000001",
  okfs: "16",
  okfs_name: "Частная собственность",
  okogu: "4210014",
  okogu_name:
    "Организации, учрежденные юридическими лицами или гражданами, или юридическими лицами и гражданами совместно",
  okopf: "12300",
  okopf_name: "Общества с ограниченной ответственностью",
  phone: "",
  email: "",
  website: "",
};

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v != null && v.trim() !== "" ? v.trim() : fallback;
}

/** Load company profile from COMPANY_* env (falls back to DEFAULT_COMPANY). */
export function loadCompanyFromEnv(
  envMap: NodeJS.ProcessEnv = process.env
): CompanyProfile {
  const get = (key: string, fallback: string) => {
    const v = envMap[key];
    return v != null && v.trim() !== "" ? v.trim() : fallback;
  };
  return {
    legal_name: get("COMPANY_LEGAL_NAME", DEFAULT_COMPANY.legal_name),
    short_name: get("COMPANY_SHORT_NAME", DEFAULT_COMPANY.short_name),
    ogrn: get("COMPANY_OGRN", DEFAULT_COMPANY.ogrn),
    ogrn_date: get("COMPANY_OGRN_DATE", DEFAULT_COMPANY.ogrn_date),
    registration_date: get(
      "COMPANY_REGISTRATION_DATE",
      DEFAULT_COMPANY.registration_date
    ),
    inn: get("COMPANY_INN", DEFAULT_COMPANY.inn),
    kpp: get("COMPANY_KPP", DEFAULT_COMPANY.kpp),
    legal_address: get("COMPANY_LEGAL_ADDRESS", DEFAULT_COMPANY.legal_address),
    director_title: get("COMPANY_DIRECTOR_TITLE", DEFAULT_COMPANY.director_title),
    director_name: get("COMPANY_DIRECTOR_NAME", DEFAULT_COMPANY.director_name),
    director_since: get("COMPANY_DIRECTOR_SINCE", DEFAULT_COMPANY.director_since),
    status: get("COMPANY_STATUS", DEFAULT_COMPANY.status),
    status_assigned: get(
      "COMPANY_STATUS_ASSIGNED",
      DEFAULT_COMPANY.status_assigned
    ),
    okved_code: get("COMPANY_OKVED_CODE", DEFAULT_COMPANY.okved_code),
    okved_name: get("COMPANY_OKVED_NAME", DEFAULT_COMPANY.okved_name),
    tax_authority: get("COMPANY_TAX_AUTHORITY", DEFAULT_COMPANY.tax_authority),
    tax_authority_since: get(
      "COMPANY_TAX_AUTHORITY_SINCE",
      DEFAULT_COMPANY.tax_authority_since
    ),
    okpo: get("COMPANY_OKPO", DEFAULT_COMPANY.okpo),
    okato: get("COMPANY_OKATO", DEFAULT_COMPANY.okato),
    oktmo: get("COMPANY_OKTMO", DEFAULT_COMPANY.oktmo),
    okfs: get("COMPANY_OKFS", DEFAULT_COMPANY.okfs),
    okfs_name: get("COMPANY_OKFS_NAME", DEFAULT_COMPANY.okfs_name),
    okogu: get("COMPANY_OKOGU", DEFAULT_COMPANY.okogu),
    okogu_name: get("COMPANY_OKOGU_NAME", DEFAULT_COMPANY.okogu_name),
    okopf: get("COMPANY_OKOPF", DEFAULT_COMPANY.okopf),
    okopf_name: get("COMPANY_OKOPF_NAME", DEFAULT_COMPANY.okopf_name),
    phone: get("COMPANY_PHONE", DEFAULT_COMPANY.phone),
    email: get("COMPANY_EMAIL", DEFAULT_COMPANY.email),
    website: get("COMPANY_WEBSITE", DEFAULT_COMPANY.website),
  };
}

/** Display name for voice / email From / signatures. */
export function companyDisplayName(
  company: CompanyProfile = loadCompanyFromEnv()
): string {
  return (
    env("VOICE_COMPANY_NAME", "") ||
    company.short_name ||
    company.legal_name
  );
}

/** Markdown block for contract drafts / legal context. */
export function companyRequisitesMd(
  company: CompanyProfile = loadCompanyFromEnv()
): string {
  const lines = [
    `**${company.legal_name}**`,
    `ОГРН ${company.ogrn} от ${company.ogrn_date}`,
    `Дата регистрации: ${company.registration_date}`,
    `ИНН/КПП: ${company.inn} / ${company.kpp}`,
    `Юридический адрес: ${company.legal_address}`,
    `Руководитель: ${company.director_title} ${company.director_name} (с ${company.director_since})`,
    `Статус: ${company.status} (присвоен ${company.status_assigned})`,
    `ОКВЭД: ${company.okved_code} — ${company.okved_name}`,
    `Налоговый орган: ${company.tax_authority} (с ${company.tax_authority_since})`,
    `ОКПО ${company.okpo}; ОКАТО ${company.okato}; ОКТМО ${company.oktmo}`,
    `ОКФС ${company.okfs} (${company.okfs_name}); ОКОГУ ${company.okogu}; ОКОПФ ${company.okopf} (${company.okopf_name})`,
  ];
  if (company.phone) lines.push(`Тел.: ${company.phone}`);
  if (company.email) lines.push(`Email: ${company.email}`);
  if (company.website) lines.push(`Сайт: ${company.website}`);
  return lines.join("\n");
}
