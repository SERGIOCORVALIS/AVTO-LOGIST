import { useCallback, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import {
  PIPELINE,
  STATUS_LABELS,
  type Deal,
  type StaffRole,
} from "../../api/types";
import { GoldCard, Hint, StatusBadge, inputClass } from "../../components/ui";

function formatWhen(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isTodayMsk(iso?: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const msk = new Date(d.toLocaleString("en-US", { timeZone: "Europe/Moscow" }));
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Moscow" }));
  return (
    msk.getFullYear() === now.getFullYear() &&
    msk.getMonth() === now.getMonth() &&
    msk.getDate() === now.getDate()
  );
}

export function DealsPage() {
  const { role } = useParams<{ role: StaffRole }>();
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [hideClosed, setHideClosed] = useState(true);
  const [todayOnly, setTodayOnly] = useState(false);

  const load = useCallback(() => {
    const q = new URLSearchParams();
    q.set("limit", "100");
    if (status) q.set("status", status);
    if (search.trim()) q.set("q", search.trim());
    return api.get<Deal[]>(`/deals?${q.toString()}`);
  }, [status, search]);

  const dealsRaw = usePoll(load, 8000) ?? [];

  const deals = useMemo(() => {
    let rows = dealsRaw;
    if (hideClosed && !status) {
      rows = rows.filter(
        (d) => !["cancelled", "closed_won", "closed_lost"].includes(d.status)
      );
    }
    if (todayOnly) {
      rows = rows.filter(
        (d) => isTodayMsk(d.created_at) || isTodayMsk(d.updated_at)
      );
    }
    return rows;
  }, [dealsRaw, hideClosed, status, todayOnly]);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-serif text-3xl text-gold-300">Сделки</h1>
        <Hint>
          Каждая сделка — диалог робота с клиентом. Статус «Ждёт человека» значит, что AI
          остановился и нужна кнопка. Дата — по Москве.
        </Hint>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${inputClass()} max-w-xs`}
          placeholder="Поиск: клиент, город, id…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className={`${inputClass()} max-w-xs`}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">Все статусы</option>
          {[...PIPELINE, "awaiting_manager", "closed_won", "closed_lost", "cancelled"].map(
            (s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s] || s}
              </option>
            )
          )}
        </select>
        <label className="flex items-center gap-2 text-sm text-white/70">
          <input
            type="checkbox"
            checked={todayOnly}
            onChange={(e) => setTodayOnly(e.target.checked)}
          />
          Только сегодня
        </label>
        <label className="flex items-center gap-2 text-sm text-white/70">
          <input
            type="checkbox"
            checked={hideClosed}
            onChange={(e) => setHideClosed(e.target.checked)}
            disabled={Boolean(status)}
          />
          Скрыть отменённые/закрытые
        </label>
      </div>
      <GoldCard className="overflow-x-auto p-0">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead className="border-b border-gold-500/20 text-xs uppercase tracking-wider text-gold-300/80">
            <tr>
              <th className="px-4 py-3">Клиент</th>
              <th className="px-4 py-3">Маршрут</th>
              <th className="px-4 py-3">Статус</th>
              <th className="px-4 py-3">Дата</th>
              <th className="px-4 py-3">Сумма</th>
              <th className="px-4 py-3">Робот</th>
            </tr>
          </thead>
          <tbody>
            {deals.map((d) => {
              const route = d.route || {};
              const today = isTodayMsk(d.created_at) || isTodayMsk(d.updated_at);
              return (
                <tr
                  key={d.id}
                  className={`border-b border-white/5 hover:bg-navy-800/50 ${
                    today ? "bg-gold-500/5" : ""
                  }`}
                >
                  <td className="px-4 py-3">
                    <Link className="text-gold-300 hover:underline" to={`/${role}/deals/${d.id}`}>
                      {d.client_name || "Без имени"}
                    </Link>
                    <p className="text-xs text-white/40">{d.channel}</p>
                  </td>
                  <td className="px-4 py-3 text-white/70">
                    {[route.origin_city, route.destination_city].filter(Boolean).join(" → ") ||
                      "—"}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={STATUS_LABELS[d.status] || d.status} />
                  </td>
                  <td className="px-4 py-3 text-xs text-white/60">
                    <div>{formatWhen(d.created_at)}</div>
                    {d.updated_at && d.updated_at !== d.created_at ? (
                      <div className="text-white/35">обн. {formatWhen(d.updated_at)}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    {d.amount_rub != null
                      ? `${Number(d.amount_rub).toLocaleString("ru-RU")} ₽`
                      : "—"}
                    {d.margin_pct != null ? (
                      <span className="block text-xs text-white/40">маржа {d.margin_pct}%</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs text-white/60">
                    {d.takeover ? "человек" : d.paused ? "пауза" : "AI"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!deals.length ? (
          <p className="p-6 text-sm text-white/40">
            Сделок по фильтру нет. Снимите «Скрыть отменённые» или выберите статус «Отмена».
          </p>
        ) : null}
      </GoldCard>
    </div>
  );
}
