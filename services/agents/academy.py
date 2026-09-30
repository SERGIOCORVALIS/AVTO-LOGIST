"""Academy of the TRANSINVEST logist — executable playbook.

Source: TRANSINVEST_AI_Logist_TZ_v1/Академия_логиста_TRANSINVEST_версия_1.md
Conflict rule: TZ v1 (Alexandra / tz_policy) wins on numbers, stop-lists and
commercial policy. Academy fills operational technology where TZ is silent.

Lecture figures (container cubes, example surcharges, historical ETAs) are
benchmarks, never live tariffs.
"""

from __future__ import annotations

from typing import Any

from agents.geography import CN_IMPORT, DOMESTIC, INTERNATIONAL, is_international

# ---------------------------------------------------------------------------
# Four entities a logist must not mix (Academy §1)
# ---------------------------------------------------------------------------
ENTITIES = (
    "cargo",  # тарно-штучный / опасный / негабарит / температурный
    "equipment",  # фура / вагон / 20DC / 40HC / OT / FR
    "route_tech",  # авто / ЖД / море+ЖД / мультимодалка
    "service_boundary",  # склад–склад / терминал–терминал + Incoterms
)

COMPARE_AXES = ("cost", "transit", "safety", "uncontrolled_extras")

SERVICE_BOUNDARIES = (
    "warehouse_warehouse",
    "warehouse_terminal",
    "terminal_warehouse",
    "terminal_terminal",
)

SERVICE_BOUNDARY_LABELS_RU = {
    "warehouse_warehouse": "склад–склад",
    "warehouse_terminal": "склад–терминал",
    "terminal_warehouse": "терминал–склад",
    "terminal_terminal": "терминал–терминал",
}

# Lecture CSC-style guides — always re-check the actual unit plate.
CONTAINER_SPECS: dict[str, dict[str, Any]] = {
    "20DC": {
        "ext_l_m": 6.058,
        "ext_w_m": 2.438,
        "ext_h_m": 2.591,
        "int_l_m": 5.898,
        "int_w_m": 2.352,
        "int_h_m": 2.390,
        "door_w_m": 2.340,
        "door_h_m": 2.280,
        "volume_m3": 33.2,
        "usable_m3": 28.0,
    },
    "40DC": {
        "ext_l_m": 12.192,
        "ext_w_m": 2.438,
        "ext_h_m": 2.591,
        "int_l_m": 12.024,
        "int_w_m": 2.352,
        "int_h_m": 2.390,
        "door_w_m": 2.340,
        "door_h_m": 2.280,
        "volume_m3": 67.7,
        "usable_m3": 58.0,
    },
    "40HC": {
        "ext_l_m": 12.192,
        "ext_w_m": 2.438,
        "ext_h_m": 2.698,
        "int_l_m": 12.031,
        "int_w_m": 2.352,
        "int_h_m": 2.698,
        "door_w_m": 2.340,
        "door_h_m": 2.585,
        "volume_m3": 76.3,
        "usable_m3": 65.0,
    },
    "45HC": {
        "ext_l_m": 13.716,
        "ext_w_m": 2.438,
        "ext_h_m": 2.698,
        "int_l_m": 13.554,
        "int_w_m": 2.352,
        "int_h_m": 2.698,
        "door_w_m": 2.340,
        "door_h_m": 2.585,
        "volume_m3": 86.0,
        "usable_m3": 73.0,
    },
}

CONTAINER_TYPES_RU = {
    "GP": "сухогрузный DC/DV",
    "HC": "High Cube",
    "PW": "Pallet Wide",
    "OT": "Open Top",
    "HT": "Hard Top",
    "FR": "Flat Rack / платформа",
    "REEFER": "рефрижератор",
    "TANK": "танк-контейнер (налив — у нас стоп по ТЗ)",
    "INSULATED": "изотерм/термос (не активный reefer)",
}

# Academy air: ~167 kg/m³ ≡ divisor 6000. Confirm per airline.
AIR_KG_PER_M3 = 167.0
HEAVY_PLACE_HINT_KG = 1500.0  # place >1.5 t → loading scheme; verify vs carrier TУ

CN_PORT_HINTS = (
    "shanghai",
    "шанхай",
    "ningbo",
    "нинбо",
    "shenzhen",
    "шэньчжэнь",
    "шенчжэнь",
    "guangzhou",
    "гуанчжоу",
    "qingdao",
    "циндао",
    "tianjin",
    "тяньцзинь",
    "xiamen",
    "сямынь",
    "yantian",
    "яньтянь",
)

CN_INLAND_HINTS = (
    "chengdu",
    "чунцин",
    "chongqing",
    "чэнду",
    "wuhan",
    "ухань",
    "xi'an",
    "сиань",
    "zhengzhou",
    "чжэнчжоу",
    "hefei",
    "хэфэй",
    "urumqi",
    "урумчи",
    "harbin",
    "харбин",
    "changsha",
    "чанша",
)

REMOTE_RU_HINTS = (
    "камчат",
    "kamchat",
    "магадан",
    "magadan",
    "сахалин",
    "sakhalin",
    "южно-сахалин",
    "yuzhno-sakhalinsk",
    "петропавловск",
    "petropavlovsk",
    "южносахалин",
    "анадыр",
    "anadyr",
    "чукот",
    "chukot",
)

SZFO_HINTS = (
    "петербург",
    "petersburg",
    "спб",
    "saint",
    "калининград",
    "мурманск",
    "псков",
    "новгород",
    "выборг",
    "архангельск",
)

SIBIR_URAL_HINTS = (
    "москв",
    "moscow",
    "новосибир",
    "екатеринбург",
    "тюмен",
    "челябинск",
    "омск",
    "красноярск",
    "иркутск",
    "пермь",
    "уфа",
    "казан",
    "самар",
)

BORDER_CROSSINGS = (
    {"ru": "Гродеково", "cn": "Суйфэньхэ", "kind": "rail_land"},
    {"ru": "Благовещенск", "cn": "Хэйхэ", "kind": "land_amur"},
    {"ru": "Забайкальск", "cn": "Маньчжурия", "kind": "rail_road"},
    {"ru": "Кяхта", "cn": "Монголия→Китай", "kind": "less_used"},
    {"kz": "Достык", "cn": "Алашанькоу", "kind": "transit_kz"},
)

INCOTERM_SCOPE = {
    "EXW": {
        "seller": "товар на своём складе",
        "we_organize": (
            "забор/подача, доставка до порта/станции, экспорт КНР, локальные сборы "
            "(THC, DOC, clearance, wharfage, handling, VGM, trucking; buy docs если нет экспортного права)"
        ),
    },
    "FOB": {
        "seller": "до порта погрузки + экспорт в рамках согласованного FOB-порта",
        "we_organize": "морское плечо и всё после POL; состав сверять с котировкой и named port",
    },
    "FCA": {
        "seller": "экспортное оформление; named place обязателен",
        "we_organize": "часть доставки/оборудования до согласованного места, если не на продавце",
    },
}

SEA_TERMS = {
    "COC": "контейнер линии; оборудование в линейной модели",
    "SOC": "свой/арендованный контейнер; у линии покупаем перевозку без их оборудования",
    "FILO": "погрузка в POL не включена линией, выгрузка в POD включена",
    "LILO": "линейная погрузка и выгрузка включены по условиям линии",
    "OTHC": "терминалка порта отправления",
    "DTHC": "терминалка порта назначения",
    "VGM": "подтверждённая масса брутто контейнера",
    "detention": "сверхнормативное пользование контейнером после вывоза до возврата порожнего",
    "demurrage": "сверхнормативное нахождение на терминале после выгрузки до вывоза",
    "drop_off": "сдача контейнера не в базовом месте",
}

EXTRA_COST_GROUPS = {
    "customs_ops": (
        "физдосмотр",
        "пробы",
        "МИДК",
        "взвешивание",
        "радиационный контроль",
        "выставление под контроль",
    ),
    "terminal_stay": (
        "хранение",
        "demurrage",
        "detention",
        "сверхнормативное оборудование",
        "перестановки",
    ),
    "must_quote_upfront": (
        "выдача на смежный вид транспорта",
        "знаки опасности",
        "ЗПУ",
        "допкрепление",
        "обработка DG",
        "расформирование при частичной выдаче",
        "вывоз и сдача порожнего",
        "пропуск авто",
        "перемещения по порту",
    ),
}

LOADING_PHOTO_STEPS = (
    "порожний контейнер: двери, пол, стены/крыша",
    "ход погрузки: ряды, масса, крепление",
    "финал до закрытия дверей: щит/крепление",
    "закрытые двери и ЗПУ с читаемым номером",
    "на выгрузке: пломба и груз до разгрузки, затем повреждения",
)

SUPPLIER_CATEGORIES = (
    "ускоренные контейнерные поезда",
    "FESCO / Трансконтейнер и операторы",
    "собственники контейнеров",
    "контейнеровозы first/last mile",
    "авто FTL",
    "ЖД / вагоны",
    "морские линии",
    "китайские агенты",
    "портовые/станционные экспедиторы",
    "СВХ / брокеры",
    "сборные перевозчики",
    "DG / негабарит",
    "страхование",
)


def _blob(*parts: Any) -> str:
    return " ".join(str(p or "") for p in parts).lower()


def _city_pair(route: dict[str, Any] | None) -> tuple[str, str]:
    route = route or {}
    return (
        str(route.get("origin_city") or ""),
        str(route.get("destination_city") or ""),
    )


def looks_cn_port(origin: str) -> bool:
    low = origin.lower()
    return any(h in low for h in CN_PORT_HINTS)


def looks_cn_inland(origin: str) -> bool:
    low = origin.lower()
    return any(h in low for h in CN_INLAND_HINTS)


def looks_remote_ru(dest: str) -> bool:
    low = dest.lower()
    return any(h in low for h in REMOTE_RU_HINTS)


def looks_szfo(dest: str) -> bool:
    low = dest.lower()
    return any(h in low for h in SZFO_HINTS)


def looks_sibir_ural_center(dest: str) -> bool:
    low = dest.lower()
    return any(h in low for h in SIBIR_URAL_HINTS)


def infer_service_boundary(route: dict[str, Any] | None) -> str | None:
    route = route or {}
    existing = route.get("service_boundary")
    if existing in SERVICE_BOUNDARIES:
        return existing
    o_addr = bool(route.get("origin_address"))
    d_addr = bool(route.get("destination_address"))
    o_term = bool(route.get("origin_terminal"))
    d_term = bool(route.get("destination_terminal"))
    if o_addr and d_addr:
        return "warehouse_warehouse"
    if o_addr and d_term:
        return "warehouse_terminal"
    if o_term and d_addr:
        return "terminal_warehouse"
    if o_term and d_term:
        return "terminal_terminal"
    if o_addr and not d_addr:
        return "warehouse_warehouse"
    return None


def suggest_container_type(
    cargo: dict[str, Any] | None,
    route: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Lecture cubes only — CSC/owner limits always win."""
    cargo = cargo or {}
    vol = _num(cargo.get("volume_m3"))
    oversized = bool(cargo.get("oversized") or cargo.get("cargo_class") == "oversized")
    temp = cargo.get("temperature_c") is not None or bool(cargo.get("temperature_required"))
    dg = bool(cargo.get("hazardous") or cargo.get("cargo_class") == "dangerous")
    notes = [
        "габариты и масса конкретного контейнера — по CSC-табличке, не по учебной таблице",
    ]
    if temp:
        return {
            "primary": "REEFER",
            "alternatives": ["INSULATED"],
            "notes": notes
            + ["убедиться, что нужен активный reefer, а не термос/изотерм"],
        }
    if oversized:
        return {
            "primary": "OT",
            "alternatives": ["FR", "HT", "обычный контейнер со спецпогрузкой если ТУ позволяют"],
            "notes": notes + ["негабарит задаёт оборудование, а не наоборот"],
        }
    primary = "20DC"
    alts = ["40DC", "40HC"]
    if vol is not None:
        if vol > CONTAINER_SPECS["40DC"]["usable_m3"]:
            primary = "40HC"
            alts = ["40DC", "два 20DC", "45HC"]
        elif vol > CONTAINER_SPECS["20DC"]["usable_m3"]:
            primary = "40DC"
            alts = ["40HC", "20DC если плотность позволяет"]
        else:
            primary = "20DC"
            alts = ["сборная вместо целого 20'", "40DC если места не встают по ширине/высоте"]
            notes.append(
                "объёма мало — параллельно считать сборную: места могут не встать в 20' по габариту"
            )
    if dg:
        notes.append("DG: не все линии/станции принимают класс; знаки и крепление в ставке")
    if looks_remote_ru(str((route or {}).get("destination_city") or "")):
        notes.append("Сахалин/Камчатка/Магадан: отдельно выдача на смежный вид транспорта")
    return {"primary": primary, "alternatives": alts, "notes": notes}


def route_matrix_priority(route: dict[str, Any] | None, cargo: dict[str, Any] | None) -> list[dict[str, str]]:
    """Academy §28 — first schemes to price, not a hard choice."""
    route = route or {}
    cargo = cargo or {}
    origin, dest = _city_pair(route)
    corridor = route.get("corridor")
    out: list[dict[str, str]] = []
    if cargo.get("hazardous") or cargo.get("cargo_class") == "dangerous":
        out.append(
            {
                "id": "dg_accepting",
                "label": "перевозчики, принимающие класс + MSDS по всем плечам",
            }
        )
    if cargo.get("oversized") or cargo.get("cargo_class") == "oversized":
        out.append(
            {
                "id": "special_equipment",
                "label": "спецконтейнер/трал и схема крепления",
            }
        )
    if looks_remote_ru(dest):
        out.extend(
            [
                {"id": "ltl_groupage", "label": "сборная до порта/региона"},
                {"id": "container_20", "label": "отдельный 20' если сборная невыгодна по габаритам"},
            ]
        )
        return out
    if corridor == DOMESTIC:
        pair = f"{origin} {dest}".lower()
        if ("москв" in pair or "moscow" in pair) and ("владивосток" in pair or "находк" in pair):
            return [
                {"id": "container", "label": "ускоренный контейнерный поезд + свои автоплечи"},
                {"id": "rail", "label": "Трансконтейнер/FESCO/другие УКП"},
                {"id": "road_train", "label": "прямое авто для срочности"},
            ]
        return []
    if corridor not in (CN_IMPORT, INTERNATIONAL) and not is_international(corridor):
        return out
    if looks_cn_port(origin) and looks_szfo(dest):
        return out + [
            {"id": "sea", "label": "прямое море до Балтики/Чёрного моря"},
            {"id": "sea_rail", "label": "Владивосток/Находка + ЖД, если срок/ставка лучше"},
            {"id": "rail", "label": "сухопутное ЖД"},
            {"id": "ftl_truck", "label": "авто"},
            {"id": "air", "label": "авиа"},
        ]
    if looks_cn_port(origin) and looks_sibir_ural_center(dest):
        return out + [
            {"id": "sea_rail", "label": "море + ЖД через Владивосток/Находку"},
            {"id": "rail", "label": "сухопутный контейнерный ЖД"},
            {"id": "ftl_truck", "label": "прямое авто"},
            {"id": "air", "label": "авиа"},
        ]
    if looks_cn_inland(origin):
        return out + [
            {"id": "rail", "label": "сухопутный маршрут через ближайший переход"},
            {"id": "ftl_truck", "label": "авто до перехода / прямое авто"},
            {"id": "sea_rail", "label": "довоз до порта + море/ЖД"},
            {"id": "air", "label": "авиа"},
        ]
    return out


def scheme_legs(
    route: dict[str, Any] | None,
    cargo: dict[str, Any] | None = None,
    *,
    mode: str | None = None,
) -> list[str]:
    """Split a scheme into cost shoulders (Academy §11.1 / §15 / §42)."""
    route = route or {}
    cargo = cargo or {}
    mode = mode or route.get("transport_mode")
    boundary = infer_service_boundary(route) or "warehouse_warehouse"
    corridor = route.get("corridor")
    origin_inc = str(route.get("origin_incoterm") or "").upper()
    dest = str(route.get("destination_city") or "")
    legs: list[str] = []

    if corridor == DOMESTIC:
        if mode in ("container", "rail"):
            if boundary != "terminal_terminal":
                legs += ["выдача порожнего", "автоподвоз на склад отправителя", "погрузка/крепление/ЗПУ"]
                legs.append("автоподвоз гружёного на терминал")
            legs += ["терминалка отправления", "ЖД / УКП", "терминалка назначения"]
            if boundary in ("warehouse_warehouse", "terminal_warehouse"):
                legs += ["автовывоз", "выгрузка", "сдача порожнего"]
        elif mode == "ltl_groupage":
            legs = ["забор (если адрес)", "консолидация", "магистраль", "ПРР", "выдача/доставка", "хранение сверх free time"]
        else:
            legs = ["подача/холостой пробег", "магистраль FTL", "простой сверх льготного", "доставка"]
        if looks_remote_ru(dest):
            legs += [
                "выдача на смежный вид транспорта",
                "каботаж/море",
                "хранение до судозахода",
                "локальный автовывоз",
            ]
        return legs

    if origin_inc == "EXW":
        legs += ["pickup КНР", "экспорт КНР / local charges", "trucking до POL/станции"]
    elif origin_inc == "FCA":
        legs += ["участок до named place FCA, если не на продавце"]
    if mode in ("sea", "container") or not mode:
        legs += ["морской фрахт POL→POD", "OTHC/DTHC", "VGM/DOC"]
        if looks_sibir_ural_center(dest) or looks_remote_ru(dest):
            legs += ["ПРР Дальний Восток", "таможня в порту или ВТТ", "выдача на ЖД", "ЖД по РФ"]
        legs.append("автовывоз / last mile")
    elif mode == "rail":
        legs += ["внутренняя КНР до станции", "экспорт", "перегруз/колея на границе", "ЖД РФ", "терминал", "last mile"]
    elif mode == "ftl_truck":
        legs += ["довоз по КНР до перехода", "терминалка границы", "экспорт/CMR", "free time на таможне", "доставка по РФ"]
    elif mode == "air":
        legs += ["air freight", "AWB/doc", "экспорт", "терминалка", "surcharges", "таможня прибытия", "выдача на авто"]
        if origin_inc == "EXW":
            legs.append("pickup КНР")
    elif mode == "ltl_groupage":
        legs += ["забор", "консолидация", "экспорт", "магистраль", "деконсолидация", "терминалка", "таможня", "доставка"]
    if looks_remote_ru(dest):
        legs += ["выдача на смежный вид", "каботаж", "хранение до судозахода"]
    return list(dict.fromkeys(legs))


def quote_inclusions(
    route: dict[str, Any] | None,
    cargo: dict[str, Any] | None,
    services: dict[str, Any] | None = None,
) -> dict[str, list[str]]:
    """What a honest KP must name as included / excluded (Academy §34)."""
    route = route or {}
    cargo = cargo or {}
    services = services or {}
    includes = list(scheme_legs(route, cargo))
    excludes = [
        "таможенные платежи (пошлина/НДС), если не заказана очистка",
        "досмотры / пробы / МИДК — по факту с первичкой",
        "хранение и простой сверх заявленного free time",
        "detention / demurrage сверх льготного",
        "страхование, если не выбрано",
    ]
    if services.get("customs_clearance"):
        excludes = [e for e in excludes if "таможенные платежи" not in e]
        excludes.append("финальное подтверждение ТН ВЭД брокером")
    if cargo.get("hazardous") or cargo.get("cargo_class") == "dangerous":
        includes += ["знаки опасности", "декларация DG", "согласование класса по всем плечам"]
        excludes.append("ставка до MSDS и допуска линии/станции")
    if looks_remote_ru(str(route.get("destination_city") or "")):
        includes.append("выдача на смежный вид транспорта — отдельной строкой")
    return {
        "includes": includes[:16],
        "excludes": excludes,
        "must_disclose_free_time": True,
    }


def extra_cost_protocol() -> list[str]:
    return [
        "сначала убрать расход: правомерен ли, можно ли договориться",
        "если нельзя — минимизировать сумму",
        "сразу уведомить менеджера/клиента о факте и возможной сумме",
        "за 2–3 дня собрать первичку (отметки в накладной, счёт терминала, акт хранения)",
        "передать на перевыставление и закрытие; НДС перевыставления — с бухгалтерией",
    ]


def dg_workflow() -> list[str]:
    return [
        "MSDS + UN/class на запросе",
        "линия принимает класс",
        "ограничения POL/POD",
        "ЖД оператор/станция",
        "годность контейнера и знаки",
        "разрешительные у брокера по ТН ВЭД",
        "упаковка / сертификат упаковки",
        "наценка терминала и хранения DG",
        "знаки, крепление, декларация DG в ставке",
        "фото упаковки и маркировки до погрузки",
        "фото размещения и знаков после затарки",
        "B/L, ЖД и таможня не противоречат MSDS",
    ]


def sea_quote_checklist() -> list[str]:
    return [
        "POL/POD и терминал",
        "тип/размер контейнера",
        "COC или SOC",
        "freight и local charges",
        "OTHC/DTHC, DOC/B/L, VGM",
        "release / telex release",
        "free time и от какого события",
        "detention/demurrage",
        "DG/reefer/OOG surcharge",
        "валидность, валюта, конвертация",
        "оплата агенту и банк. комиссия",
    ]


def intake_checklist(route: dict[str, Any] | None, cargo: dict[str, Any] | None) -> list[str]:
    cargo = cargo or {}
    route = route or {}
    items = [
        ("маршрут", bool(route.get("origin_city") and route.get("destination_city"))),
        ("наименование", bool(cargo.get("name") or cargo.get("url"))),
        ("вес или объём", bool(cargo.get("weight_kg") or cargo.get("volume_m3") or cargo.get("chargeable_weight_kg"))),
        ("габариты нестандартных мест", bool(cargo.get("length_cm") and cargo.get("width_cm") and cargo.get("height_cm"))),
        ("упаковка", bool(cargo.get("packaging"))),
        ("опасность/температура", cargo.get("hazardous") is not None or cargo.get("temperature_required") is not None),
        ("дата готовности", bool(route.get("ready_date"))),
        ("граница услуги", infer_service_boundary(route) is not None),
    ]
    if is_international(route.get("corridor")) or route.get("corridor") in (CN_IMPORT, INTERNATIONAL):
        items += [
            ("Incoterms + named place", bool(route.get("origin_incoterm") and (route.get("origin_incoterm_place") or route.get("origin_city")))),
            ("invoice/packing или сумма", bool(cargo.get("invoice_value") or cargo.get("url"))),
            ("где таможня (порт / ВТТ)", bool(route.get("customs_scenario"))),
        ]
    missing = [label for label, ok in items if not ok]
    return missing


def carrier_rfq_fields(
    cargo: dict[str, Any] | None,
    route: dict[str, Any] | None,
) -> dict[str, Any]:
    """Academy §35 — short technical RFQ, no client identity."""
    cargo = cargo or {}
    route = route or {}
    dg = bool(cargo.get("hazardous") or cargo.get("cargo_class") == "dangerous")
    return {
        "route": f"{route.get('origin_city') or ''} → {route.get('destination_city') or ''}".strip(" →"),
        "pol_pod": {
            "origin_terminal": route.get("origin_terminal"),
            "destination_terminal": route.get("destination_terminal"),
        },
        "cargo_name": cargo.get("name"),
        "gw_kg": cargo.get("weight_kg") or cargo.get("chargeable_weight_kg"),
        "cbm": cargo.get("volume_m3"),
        "pcs": cargo.get("quantity") or cargo.get("pieces"),
        "dimensions": {
            "l_cm": cargo.get("length_cm"),
            "w_cm": cargo.get("width_cm"),
            "h_cm": cargo.get("height_cm"),
        },
        "equipment": route.get("container_type") or route.get("transport_mode"),
        "incoterms": route.get("incoterms") or route.get("origin_incoterm"),
        "ready_date": route.get("ready_date"),
        "dg": "DG" if dg else "Non-DG",
        "msds": bool(cargo.get("msds") or cargo.get("dg_un_number")),
        "temperature": cargo.get("temperature_c"),
        "scope": scheme_legs(route, cargo),
        "customs_scenario": route.get("customs_scenario"),
        "ask": [
            "all local charges",
            "free time and trigger event",
            "validity",
            "inclusions / exclusions",
            "VAT / currency",
        ],
    }


def manager_quote_card(
    *,
    route: dict[str, Any] | None,
    cargo: dict[str, Any] | None,
    cost: dict[str, Any] | None = None,
    offer: dict[str, Any] | None = None,
    alternatives: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Academy §34 — product for the sales manager, not a naked number."""
    route = route or {}
    cargo = cargo or {}
    cost = cost or {}
    offer = offer or {}
    inc = quote_inclusions(route, cargo)
    return {
        "route": f"{route.get('origin_city') or '—'} → {route.get('destination_city') or '—'}",
        "scheme": route.get("scheme_label") or ", ".join(scheme_legs(route, cargo)[:6]),
        "cargo": {
            "name": cargo.get("name"),
            "weight_kg": cargo.get("weight_kg"),
            "volume_m3": cargo.get("volume_m3"),
            "pcs": cargo.get("quantity") or cargo.get("pieces"),
        },
        "equipment": route.get("container_type") or route.get("transport_mode"),
        "cost": cost.get("total") or cost.get("freight"),
        "client_price": offer.get("price") or offer.get("offer_price"),
        "eta": {
            "min": offer.get("eta_days_min"),
            "max": offer.get("eta_days_max"),
        },
        "validity": offer.get("valid_until"),
        "includes": inc["includes"],
        "excludes": inc["excludes"],
        "free_time": offer.get("free_time") or "запросить в котировке и назвать клиенту до продажи",
        "risks": _risk_flags(cargo, route),
        "alternatives": alternatives or [],
        "benchmark_not_tariff": True,
    }


def _risk_flags(cargo: dict[str, Any], route: dict[str, Any]) -> list[str]:
    flags: list[str] = []
    if cargo.get("hazardous") or cargo.get("cargo_class") == "dangerous":
        flags.append("опасность: без MSDS не считать неопасным")
    if cargo.get("oversized") or cargo.get("cargo_class") == "oversized":
        flags.append("негабарит относительно выбранного оборудования")
    w = _num(cargo.get("weight_kg"))
    if w and w >= 18000:
        flags.append("вес: контроль фактической погрузки и развесовки")
    if looks_remote_ru(str(route.get("destination_city") or "")):
        flags.append("удалённый регион: судозаход, хранение, выдача на смежный вид")
    flags.append("просроченная ставка не продаётся без переподтверждения")
    return flags


def classify_cargo_hints(cargo: dict[str, Any] | None) -> dict[str, Any]:
    cargo = cargo or {}
    name = str(cargo.get("name") or "").lower()
    hints: list[str] = []
    if any(x in name for x in ("краск", "paint", "хими", "acid", "battery", "аккумул", "литие")):
        hints.append("наименование вызывает сомнение по DG — запросить MSDS, не верить словам «неопасный»")
    if any(x in name for x in ("мебел", "дерев", "изделия деревянные")):
        hints.append("не принимать заведомо упрощённое наименование ради экономии на охране")
    place_kg = _num(cargo.get("place_weight_kg"))
    if place_kg and place_kg > HEAVY_PLACE_HINT_KG:
        hints.append("место >1.5 т: возможна спецсхема размещения/крепления — сверить ТУ перевозчика")
    if cargo.get("temperature_required") is False and "реф" in name:
        hints.append("уточнить: активный reefer или достаточно изотерма")
    return {"hints": hints, "entities_do_not_mix": list(ENTITIES)}


def compact_academy_for_llm() -> dict[str, Any]:
    """Digest injected into concierge/orchestrator. TZ numbers still win."""
    return {
        "source": "Академия логиста TRANSINVEST v1",
        "tz_overrides_academy_on": [
            "маржа 18/10 и прибыль <3000 ₽",
            "НДС 22% / международный фрахт 0%",
            "RFQ 10–20, не «минимум пять»",
            "стоп: налив, частный переезд, санкции, серые схемы",
        ],
        "thinking": {
            "do_not_mix": list(ENTITIES),
            "compare": list(COMPARE_AXES),
            "result": "продаваемая и исполнимая схема, не «нашёл машину»",
            "cabinet_is_benchmark": True,
            "never_invent_rates": True,
            "never_sell_expired_rate": True,
            "compare_vat_and_fx_first": True,
        },
        "incoterms": INCOTERM_SCOPE,
        "sea_terms": SEA_TERMS,
        "extra_costs": EXTRA_COST_GROUPS,
        "extra_cost_protocol": extra_cost_protocol(),
        "dg_workflow": dg_workflow(),
        "sea_quote_checklist": sea_quote_checklist(),
        "loading_photos": list(LOADING_PHOTO_STEPS),
        "container_specs_lecture_only": {
            k: {"volume_m3": v["volume_m3"], "usable_m3": v["usable_m3"], "door_h_m": v["door_h_m"]}
            for k, v in CONTAINER_SPECS.items()
        },
        "air_chargeable": "max(actual_kg, ~167 кг/м³); делитель 6000 — подтверждать у авиакомпании",
        "remote_ru_extra_lines": [
            "выдача на смежный вид транспорта",
            "каботаж",
            "хранение до судозахода",
            "локальный автовывоз",
            "порожний возврат",
        ],
        "kp_must_have": [
            "маршрут",
            "схема",
            "груз",
            "оборудование",
            "себестоимость/цена",
            "срок от какого события",
            "валидность",
            "включено",
            "не включено",
            "free time",
            "риски",
            "альтернатива",
        ],
        "rfq_to_carrier": "короткий технический запрос без ИНН/имени клиента/завода",
        "direct_carriers_preferred": "клиент → мы → прямой перевозчик, без лишнего экспедитора",
    }


def client_academy_messages(
    cargo: dict[str, Any] | None,
    route: dict[str, Any] | None,
) -> list[str]:
    """Short coaching lines for the client-facing logist."""
    msgs: list[str] = []
    matrix = route_matrix_priority(route, cargo)
    if matrix:
        msgs.append("Схемы к сравнению: " + "; ".join(a["label"] for a in matrix[:4]) + ".")
    if looks_remote_ru(str((route or {}).get("destination_city") or "")):
        msgs.append(
            "Удалённый регион: в калькуляции отдельно выдача на смежный вид транспорта, каботаж и хранение до судозахода."
        )
    hints = classify_cargo_hints(cargo).get("hints") or []
    msgs.extend(hints[:2])
    if (route or {}).get("transport_mode") in ("sea", "container") and is_international(
        (route or {}).get("corridor")
    ):
        msgs.append("В котировке моря читаем local charges, free time, COC/SOC — кабинет не конечная цена.")
    return msgs


def _num(v: Any) -> float | None:
    try:
        if v is None or v == "":
            return None
        return float(v)
    except (TypeError, ValueError):
        return None
