/** Business-hours check for after-hours voice mode (Europe/Moscow by default). */

export function isAfterHours(now = new Date()): boolean {
  const tz = process.env.VOICE_TZ || "Europe/Moscow";
  const start = Number(process.env.VOICE_HOURS_START || 9);
  const end = Number(process.env.VOICE_HOURS_END || 19);
  const skipWeekends = process.env.VOICE_SKIP_WEEKENDS !== "false";

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "12");
  const weekday = parts.find((p) => p.type === "weekday")?.value || "";
  if (skipWeekends && (weekday === "Sat" || weekday === "Sun")) return true;
  return hour < start || hour >= end;
}

export function afterHoursMessage(): string {
  return (
    process.env.VOICE_AFTER_HOURS_MESSAGE ||
    "Сейчас нерабочее время логистики. Оставьте заявку в Telegram или перезвоните в рабочие часы с 9 до 19 по Москве. До свидания."
  );
}
