from pathlib import Path

root = Path(r"c:\logist-conserg\docs")
main = root / "ENV_SETUP.md"
sec_path = root / "_voice_section10.md"
sec = sec_path.read_text(encoding="utf-8")
text = main.read_text(encoding="utf-8")
start = text.index("## 10. Голос:")
end = text.index("## 11. Observability")
new_text = text[:start] + sec + text[end:]

old_err = (
    "| Звонок молчит / нет RTP | NAT / нет `SIP_PUBLIC_HOST` / закрыт UDP | "
    "Белый IP или port-forward SIP+RTP; проверить `/health` → sip |\n"
    "| REGISTER 403/401 | Неверный SIP login/password | Кабинет Zadarma → SIP Connection |\n"
    "| Нет колонок call_sessions / provider_call_id | Старая БД | "
    "`002_voice.sql` + `003_provider_call_id.sql` |\n"
    "| Дорогой Realtime | Длинные звонки | `VOICE_MAX_CALL_MINUTES` |"
)
new_err = (
    "| `sip.active: false` в /health | Нет `SIP_PUBLIC_HOST` или логина | "
    "Заполните `SIP_PUBLIC_HOST` + `SIP_USERNAME`/`SIP_PASSWORD` (или `SIP_URI_MODE=1`) |\n"
    "| Звонок молчит / нет RTP | NAT / неверный `SIP_PUBLIC_HOST` / закрыт UDP RTP | "
    "Белый IP или port-forward **SIP+RTP**; `SIP_PUBLIC_HOST` = внешний IP, не 127.0.0.1 |\n"
    "| REGISTER 401/403 (Zadarma) | Неверный login/password | "
    "Кабинет → Settings → SIP Connection; пересоздайте пароль |\n"
    "| REGISTER fail (Билайн) | Неверный domain / proxy / auth | "
    "Сверьте `SIP_DOMAIN`, `SIP_OUTBOUND_PROXY`, `SIP_AUTH_USERNAME` с ЛК; порт 5060 |\n"
    "| Звонок сбрасывается сразу | Нет `OPENAI_API_KEY` / Realtime ошибка | "
    "Ключ OpenAI + логи `logs/voice/` |\n"
    "| Transfer не доходит до менеджера | Пустой `VOICE_MANAGER_TRANSFER_NUMBER` | "
    "Задайте E.164 `+7900...`; проверьте, что транк умеет REFER/исходящие |\n"
    "| Нет колонок call_sessions / provider_call_id | Старая БД | "
    "`002_voice.sql` + `003_provider_call_id.sql` |\n"
    "| Дорогой Realtime | Длинные звонки | `VOICE_MAX_CALL_MINUTES` |"
)
if old_err not in new_text:
    raise SystemExit("troubleshooting block not found")
new_text = new_text.replace(old_err, new_err)

old_db = "голос — [`infra/migrations/002_voice.sql`](../infra/migrations/002_voice.sql)"
new_db = (
    "голос — [`002_voice.sql`](../infra/migrations/002_voice.sql), "
    "[`003_provider_call_id.sql`](../infra/migrations/003_provider_call_id.sql)"
)
new_text = new_text.replace(old_db, new_db, 1)

main.write_text(new_text, encoding="utf-8")
sec_path.unlink(missing_ok=True)
print("OK", len(new_text.splitlines()), "lines")
