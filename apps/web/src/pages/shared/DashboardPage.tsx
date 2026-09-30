import { useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import {
  PIPELINE,
  STATUS_LABELS,
  type ArchiveSummary,
  type CalendarEvent,
  type Escalation,
  type PolicyConfig,
  type StaffRole,
  type StatsSummary,
} from "../../api/types";
import { GoldCard, Hint, StatusBadge } from "../../components/ui";
import { RobotCore } from "../../scenes/RobotCore";
import { useAuth } from "../../auth/AuthContext";

export function DashboardPage() {
  const { role } = useParams<{ role: StaffRole }>();
  const { user } = useAuth();
  const load = useCallback(
    () =>
      Promise.all([
        api.get<StatsSummary>("/stats/summary"),
        api.get<Escalation[]>("/escalations?status=pending"),
        api.get<CalendarEvent[]>("/calendar/events"),
        api.get<PolicyConfig>("/policy"),
        api.get<ArchiveSummary>("/clients/archive/summary"),
      ]),
    []
  );
  const data = usePoll(load, 7000);
  const stats = data?.[0];
  const escalations = data?.[1] ?? [];
  const events = data?.[2] ?? [];
  const policy = data?.[3];
  const archive = data?.[4];
  const robot = stats?.robot;
  const byStatus = stats?.by_status ?? [];
  const map = Object.fromEntries(byStatus.map((s) => [s.status, s]));

  const robotLabel = robot?.takeover
    ? "Человек ведёт чат"
    : robot?.paused
      ? "На паузе"
      : robot?.awaiting_manager
        ? "Ждёт решения"
        : "Работает автономно";

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-[0.3em] text-gold-400">
          {user?.role === "director" ? "Кабинет директора" : "Кабинет менеджера"}
        </p>
        <h1 className="font-serif text-3xl text-gold-300">Пульт робота</h1>
        <Hint>
          Робот ведёт клиента от заявки до договора. Здесь видно, где он работает сам, а где
          ждёт вас.
        </Hint>
      </header>

      <div className="grid gap-4 lg:grid-cols-4">
        <GoldCard>
          <p className="text-xs uppercase tracking-widest text-white/50">Статус</p>
          <p className="mt-2 font-serif text-2xl text-gold-300">{robotLabel}</p>
          <p className="mt-3 text-sm text-white/70">
            Открытых сделок: {robot?.open_deals ?? "—"} · на паузе: {robot?.paused ?? 0} ·
            takeover: {robot?.takeover ?? 0}
          </p>
        </GoldCard>
        <GoldCard>
          <p className="text-xs uppercase tracking-widest text-white/50">Эскалации</p>
          <p className="mt-2 font-serif text-2xl text-gold-300">
            {stats?.pending_escalations ?? "—"}
          </p>
          <Hint>Очередь решений. Сумма и юр. риск — только директору.</Hint>
        </GoldCard>
        <GoldCard>
          <Link to={`/${role}/clients`} className="block hover:opacity-90">
            <p className="text-xs uppercase tracking-widest text-white/50">Архив клиентов</p>
            <p className="mt-2 font-serif text-2xl text-gold-300">
              {archive?.totals.clients ?? "—"}
            </p>
            <p className="mt-3 text-sm text-white/70">
              {archive?.totals.messages?.toLocaleString("ru-RU") ?? "—"} писем ·{" "}
              {archive?.totals.calcs ?? "—"} расчётов
            </p>
          </Link>
        </GoldCard>
        <GoldCard>
          <p className="text-xs uppercase tracking-widest text-white/50">Политика</p>
          <p className="mt-2 text-sm text-white/80">
            Маржа {policy?.target_margin_pct ?? "—"}% · пол {policy?.floor_margin_pct ?? "—"}% ·
            порог {(policy?.escalate_amount_rub ?? 0).toLocaleString("ru-RU")} ₽
          </p>
          <p className="mt-2 text-sm text-white/60">
            Обучение: {policy?.learning_enabled ? "вкл" : "выкл"} · canary {policy?.canary_pct ?? 0}%
          </p>
        </GoldCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RobotCore byStatus={byStatus} />
        <GoldCard>
          <h2 className="font-serif text-xl text-gold-300">Воронка</h2>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {PIPELINE.map((st) => (
              <div key={st} className="rounded-lg bg-navy-950/80 p-3">
                <p className="text-[10px] uppercase tracking-wide text-white/40">
                  {STATUS_LABELS[st]}
                </p>
                <p className="font-serif text-xl text-gold-300">{map[st]?.n ?? 0}</p>
              </div>
            ))}
          </div>
        </GoldCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <GoldCard>
          <h2 className="font-serif text-xl text-gold-300">Очередь эскалаций</h2>
          <div className="mt-3 space-y-2">
            {escalations.slice(0, 6).map((e) => (
              <Link
                key={e.id}
                to={`/${role}/escalations`}
                className="block rounded-lg border border-white/5 p-3 hover:border-gold-500/30"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm text-white">{e.client_name || e.deal_id.slice(0, 8)}</p>
                  <StatusBadge status={e.reason} />
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-white/50">{e.summary}</p>
              </Link>
            ))}
            {!escalations.length ? (
              <p className="text-sm text-white/40">Робот никого не ждёт.</p>
            ) : null}
          </div>
        </GoldCard>
        <GoldCard>
          <h2 className="font-serif text-xl text-gold-300">SLA и календарь</h2>
          <div className="mt-3 space-y-2">
            {events.slice(0, 8).map((ev) => (
              <div key={ev.id} className="flex justify-between gap-3 text-sm">
                <span className="text-white/80">{ev.title}</span>
                <span className="text-gold-300/80">
                  {new Date(ev.due_at).toLocaleString("ru-RU")}
                </span>
              </div>
            ))}
            {!events.length ? (
              <p className="text-sm text-white/40">Нет открытых SLA-событий.</p>
            ) : null}
          </div>
        </GoldCard>
      </div>
    </div>
  );
}
