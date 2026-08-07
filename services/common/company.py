"""Legal entity profile for customer-facing channels (voice, email, contracts)."""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class CompanyProfile:
    legal_name: str
    short_name: str
    ogrn: str
    ogrn_date: str
    registration_date: str
    inn: str
    kpp: str
    legal_address: str
    director_title: str
    director_name: str
    director_since: str
    status: str
    status_assigned: str
    okved_code: str
    okved_name: str
    tax_authority: str
    tax_authority_since: str
    okpo: str
    okato: str
    oktmo: str
    okfs: str
    okfs_name: str
    okogu: str
    okogu_name: str
    okopf: str
    okopf_name: str
    phone: str = ""
    email: str = ""
    website: str = ""


DEFAULT_COMPANY = CompanyProfile(
    legal_name='ООО «ЖД Трансинвест»',
    short_name="ЖД Трансинвест",
    ogrn="1205400060260",
    ogrn_date="16.12.2020",
    registration_date="16.12.2020",
    inn="5401401513",
    kpp="540601001",
    legal_address=(
        "630007, Новосибирская область, г Новосибирск, "
        "Октябрьская ул, зд. 42, офис 308"
    ),
    director_title="Директор",
    director_name="Тарасова Александра Викторовна",
    director_since="16.12.2020",
    status="микропредприятие",
    status_assigned="10.01.2021",
    okved_code="52.29",
    okved_name="Деятельность вспомогательная прочая, связанная с перевозками",
    tax_authority=(
        "Межрайонная инспекция ФНС России № 22 по Новосибирской области"
    ),
    tax_authority_since="23.08.2022",
    okpo="46701699",
    okato="50401386000",
    oktmo="50701000001",
    okfs="16",
    okfs_name="Частная собственность",
    okogu="4210014",
    okogu_name=(
        "Организации, учрежденные юридическими лицами или гражданами, "
        "или юридическими лицами и гражданами совместно"
    ),
    okopf="12300",
    okopf_name="Общества с ограниченной ответственностью",
)


def _env(key: str, fallback: str) -> str:
    v = os.getenv(key)
    return v.strip() if v and v.strip() else fallback


def load_company() -> CompanyProfile:
    d = DEFAULT_COMPANY
    return CompanyProfile(
        legal_name=_env("COMPANY_LEGAL_NAME", d.legal_name),
        short_name=_env("COMPANY_SHORT_NAME", d.short_name),
        ogrn=_env("COMPANY_OGRN", d.ogrn),
        ogrn_date=_env("COMPANY_OGRN_DATE", d.ogrn_date),
        registration_date=_env("COMPANY_REGISTRATION_DATE", d.registration_date),
        inn=_env("COMPANY_INN", d.inn),
        kpp=_env("COMPANY_KPP", d.kpp),
        legal_address=_env("COMPANY_LEGAL_ADDRESS", d.legal_address),
        director_title=_env("COMPANY_DIRECTOR_TITLE", d.director_title),
        director_name=_env("COMPANY_DIRECTOR_NAME", d.director_name),
        director_since=_env("COMPANY_DIRECTOR_SINCE", d.director_since),
        status=_env("COMPANY_STATUS", d.status),
        status_assigned=_env("COMPANY_STATUS_ASSIGNED", d.status_assigned),
        okved_code=_env("COMPANY_OKVED_CODE", d.okved_code),
        okved_name=_env("COMPANY_OKVED_NAME", d.okved_name),
        tax_authority=_env("COMPANY_TAX_AUTHORITY", d.tax_authority),
        tax_authority_since=_env(
            "COMPANY_TAX_AUTHORITY_SINCE", d.tax_authority_since
        ),
        okpo=_env("COMPANY_OKPO", d.okpo),
        okato=_env("COMPANY_OKATO", d.okato),
        oktmo=_env("COMPANY_OKTMO", d.oktmo),
        okfs=_env("COMPANY_OKFS", d.okfs),
        okfs_name=_env("COMPANY_OKFS_NAME", d.okfs_name),
        okogu=_env("COMPANY_OKOGU", d.okogu),
        okogu_name=_env("COMPANY_OKOGU_NAME", d.okogu_name),
        okopf=_env("COMPANY_OKOPF", d.okopf),
        okopf_name=_env("COMPANY_OKOPF_NAME", d.okopf_name),
        phone=_env("COMPANY_PHONE", d.phone),
        email=_env("COMPANY_EMAIL", d.email),
        website=_env("COMPANY_WEBSITE", d.website),
    )


def company_display_name(company: CompanyProfile | None = None) -> str:
    c = company or load_company()
    voice = os.getenv("VOICE_COMPANY_NAME", "").strip()
    return voice or c.short_name or c.legal_name


def company_as_dict(company: CompanyProfile | None = None) -> dict[str, Any]:
    return asdict(company or load_company())


def company_requisites_md(company: CompanyProfile | None = None) -> str:
    c = company or load_company()
    lines = [
        f"**{c.legal_name}**",
        f"ОГРН {c.ogrn} от {c.ogrn_date}",
        f"Дата регистрации: {c.registration_date}",
        f"ИНН/КПП: {c.inn} / {c.kpp}",
        f"Юридический адрес: {c.legal_address}",
        (
            f"Руководитель: {c.director_title} {c.director_name} "
            f"(с {c.director_since})"
        ),
        f"Статус: {c.status} (присвоен {c.status_assigned})",
        f"ОКВЭД: {c.okved_code} — {c.okved_name}",
        f"Налоговый орган: {c.tax_authority} (с {c.tax_authority_since})",
        f"ОКПО {c.okpo}; ОКАТО {c.okato}; ОКТМО {c.oktmo}",
        (
            f"ОКФС {c.okfs} ({c.okfs_name}); ОКОГУ {c.okogu}; "
            f"ОКОПФ {c.okopf} ({c.okopf_name})"
        ),
    ]
    if c.phone:
        lines.append(f"Тел.: {c.phone}")
    if c.email:
        lines.append(f"Email: {c.email}")
    if c.website:
        lines.append(f"Сайт: {c.website}")
    return "\n".join(lines)
