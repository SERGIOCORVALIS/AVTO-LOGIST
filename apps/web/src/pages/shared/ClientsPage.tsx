import { useCallback, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import {
  FACT_LABELS,
  MAILBOX_LABELS,
  MODE_LABELS,
  SERVICE_CATEGORY_LABELS,
  type ArchiveSummary,
  type ClientListResponse,
  type StaffRole,
} from "../../api/types";
import { GoldCard, Hint, Button, inputClass } from "../../components/ui";

function formatWhen(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function clientTitle(c: {
  name?: string | null;
  legal_name?: string | null;
  primary_email?: string | null;
}): string {
  return c.name || c.legal_name || c.primary_email || "Без имени";
}

export function ClientsPage() {
  const { role } = useParams<{ role: StaffRole }>();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "archive" ? "archive" : "clients";
  const [search, setSearch] = useState("");
  const [vipOnly, setVipOnly] = useState(false);
  const [withCalcs, setWithCalcs] = useState(false);
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const loadSummary = useCallback(
    () => api.get<ArchiveSummary>("/clients/archive/summary"),
    []
  );
  const summary = usePoll(loadSummary, 30000);

  const loadClients = useCallback(() => {
    const q = new URLSearchParams();
    q.set("limit", String(limit));
    q.set("offset", String(offset));
    if (search.trim()) q.set("q", search.trim());
    if (vipOnly) q.set("vip", "true");
    if (withCalcs) q.set("has_calcs", "true");
    return api.get<ClientListResponse>(`/clients?${q.toString()}`);
  }, [search, vipOnly, withCalcs, offset]);

  const clientsData = usePoll(loadClients, 12000);
  const items = clientsData?.items ?? [];
  const total = clientsData?.total ?? 0;

  const modes = useMemo(() => summary?.modes ?? [], [summary]);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-serif text-3xl text-gold-300">Клиенты и архив почты</h1>
        <Hint>
          База из выгруженных ящиков m5, m13, a1, m1, info. Робот узнаёт клиента по
          email/телефону/Telegram и подмешивает историю расчётов в диалог. Счета и договоры
          — из ящика info.
        </Hint>
      </header>

      <div className="flex flex-wrap gap-2">
        <Button
          variant={tab === "clients" ? "gold" : "ghost"}
          onClick={() => setParams({})}
        >
          Клиенты ({summary?.totals.clients ?? "…"})
        </Button>
        <Button
          variant={tab === "archive" ? "gold" : "ghost"}
          onClick={() => setParams({ tab: "archive" })}
        >
          Обзор архива
        </Button>
      </div>

      {tab === "archive" ? (
        <ArchiveOverview summary={summary} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Писем в архиве" value={summary?.totals.messages} />
            <StatCard label="Запросов расчёта" value={summary?.totals.calcs} />
            <StatCard label="Сделок привязано" value={summary?.totals.deals_linked} />
            <StatCard
              label="Топ режим"
              value={
                modes[0]
                  ? `${MODE_LABELS[modes[0].mode] || modes[0].mode} (${modes[0].n})`
                  : "—"
              }
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              className={`${inputClass()} max-w-sm`}
              placeholder="Поиск: имя, email, телефон, ИНН…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
            />
            <label className="flex items-center gap-2 text-sm text-white/70">
              <input
                type="checkbox"
                checked={withCalcs}
                onChange={(e) => {
                  setWithCalcs(e.target.checked);
                  setOffset(0);
                }}
              />
              С расчётами
            </label>
            <label className="flex items-center gap-2 text-sm text-white/70">
              <input
                type="checkbox"
                checked={vipOnly}
                onChange={(e) => {
                  setVipOnly(e.target.checked);
                  setOffset(0);
                }}
              />
              VIP
            </label>
          </div>

          <GoldCard className="overflow-x-auto p-0">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-white/10 text-xs uppercase text-gold-300/80">
                <tr>
                  <th className="px-4 py-3">Клиент</th>
                  <th className="px-4 py-3">Контакты</th>
                  <th className="px-4 py-3">Расчёты</th>
                  <th className="px-4 py-3">Файлы</th>
                  <th className="px-4 py-3">Счета</th>
                  <th className="px-4 py-3">Договоры</th>
                  <th className="px-4 py-3">Сделки</th>
                  <th className="px-4 py-3">Обновлён</th>
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-white/5 hover:bg-navy-950/50"
                  >
                    <td className="px-4 py-3">
                      <Link
                        to={`/${role}/clients/${c.id}`}
                        className="font-medium text-gold-300 hover:underline"
                      >
                        {clientTitle(c)}
                        {c.vip ? (
                          <span className="ml-2 rounded bg-gold-500/20 px-1.5 text-[10px] text-gold-200">
                            VIP
                          </span>
                        ) : null}
                      </Link>
                      {c.inn ? (
                        <p className="text-xs text-white/40">ИНН {c.inn}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-xs text-white/70">
                      <p>{c.primary_email || "—"}</p>
                      <p>{c.phone || ""}</p>
                    </td>
                    <td className="px-4 py-3 text-gold-300">{c.calc_count}</td>
                    <td className="px-4 py-3">{c.attachment_count ?? 0}</td>
                    <td className="px-4 py-3">
                      {c.invoice_file_count ?? c.invoice_count}
                    </td>
                    <td className="px-4 py-3">
                      {c.contract_file_count ?? c.contract_count}
                    </td>
                    <td className="px-4 py-3">{c.deal_count}</td>
                    <td className="px-4 py-3 text-xs text-white/50">
                      {formatWhen(c.updated_at)}
                    </td>
                  </tr>
                ))}
                {!items.length ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-white/40">
                      Клиенты не найдены
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </GoldCard>

          <div className="flex items-center justify-between text-sm text-white/50">
            <span>
              Показано {items.length} из {total}
            </span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                disabled={offset <= 0}
                onClick={() => setOffset(Math.max(0, offset - limit))}
              >
                ← Назад
              </Button>
              <Button
                variant="ghost"
                disabled={offset + limit >= total}
                onClick={() => setOffset(offset + limit)}
              >
                Дальше →
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value?: number | string | null }) {
  return (
    <GoldCard className="p-4">
      <p className="text-xs uppercase tracking-wide text-white/40">{label}</p>
      <p className="mt-1 font-serif text-2xl text-gold-300">
        {value ?? "—"}
      </p>
    </GoldCard>
  );
}

function ArchiveOverview({ summary }: { summary: ArchiveSummary | null | undefined }) {
  const [exportErr, setExportErr] = useState("");
  const [exporting, setExporting] = useState(false);

  if (!summary) {
    return <p className="text-gold-300">Загрузка обзора архива…</p>;
  }

  const downloadExcel = async () => {
    setExportErr("");
    setExporting(true);
    try {
      await api.download(
        "/clients/archive/export.xlsx",
        `clients-archive.xlsx`
      );
    } catch (e) {
      setExportErr(
        String((e as Error).message || e) +
          " — сначала: pnpm mail:archive-excel"
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-white/50">
          Вложений: {(summary.totals.attachments ?? 0).toLocaleString("ru-RU")} ·
          поставщиков услуг:{" "}
          {(summary.totals.service_providers ?? 0).toLocaleString("ru-RU")}
        </p>
        <Button variant="gold" onClick={downloadExcel} disabled={exporting}>
          {exporting ? "Скачивание…" : "Скачать Excel"}
        </Button>
      </div>
      {exportErr ? <p className="text-sm text-red-300">{exportErr}</p> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Клиентов" value={summary.totals.clients} />
        <StatCard label="Писем" value={summary.totals.messages} />
        <StatCard label="Тредов" value={summary.totals.threads} />
        <StatCard label="Расчётов" value={summary.totals.calcs} />
        <StatCard label="Сделок с client_id" value={summary.totals.deals_linked} />
      </div>

      <GoldCard>
        <h2 className="font-serif text-lg text-gold-300">Ящики (выгрузка IMAP)</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-white/40">
              <tr>
                <th className="py-2 text-left">Ящик</th>
                <th className="py-2 text-left">Писем</th>
                <th className="py-2 text-left">Клиентов</th>
                <th className="py-2 text-left">Период</th>
              </tr>
            </thead>
            <tbody>
              {summary.mailboxes.map((m) => (
                <tr key={m.mailbox_id} className="border-t border-white/5">
                  <td className="py-2 text-gold-300">
                    {MAILBOX_LABELS[m.mailbox_id] || m.mailbox_id}
                  </td>
                  <td className="py-2">{m.messages.toLocaleString("ru-RU")}</td>
                  <td className="py-2">{m.clients}</td>
                  <td className="py-2 text-xs text-white/50">
                    {formatWhen(m.first_at)} — {formatWhen(m.last_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </GoldCard>

      {(summary.service_providers?.length ?? 0) > 0 ? (
        <GoldCard>
          <h2 className="font-serif text-lg text-gold-300">Поставщики услуг</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-white/40">
                <tr>
                  <th className="py-2 text-left">Название</th>
                  <th className="py-2 text-left">Категория</th>
                  <th className="py-2 text-left">Email</th>
                  <th className="py-2 text-left">Писем</th>
                </tr>
              </thead>
              <tbody>
                {summary.service_providers!.map((s) => (
                  <tr key={s.id} className="border-t border-white/5">
                    <td className="py-2 text-gold-300">{s.name}</td>
                    <td className="py-2">
                      {SERVICE_CATEGORY_LABELS[s.category] || s.category}
                    </td>
                    <td className="py-2 text-xs text-white/60">
                      {s.primary_email || "—"}
                    </td>
                    <td className="py-2">{s.message_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GoldCard>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <GoldCard>
          <h2 className="font-serif text-lg text-gold-300">Виды перевозок (из расчётов)</h2>
          <ul className="mt-3 space-y-1 text-sm">
            {summary.modes.map((m) => (
              <li key={m.mode} className="flex justify-between gap-3">
                <span>{MODE_LABELS[m.mode] || m.mode}</span>
                <span className="text-gold-300">{m.n}</span>
              </li>
            ))}
          </ul>
        </GoldCard>
        <GoldCard>
          <h2 className="font-serif text-lg text-gold-300">Факты из переписки</h2>
          <ul className="mt-3 space-y-1 text-sm">
            {summary.facts.map((f) => (
              <li key={f.fact_type} className="flex justify-between gap-3">
                <span>{FACT_LABELS[f.fact_type] || f.fact_type}</span>
                <span className="text-gold-300">{f.n}</span>
              </li>
            ))}
          </ul>
        </GoldCard>
      </div>

      <Hint>
        Архив на диске: <code className="text-gold-200">data/mail-archive/</code>. Повторная
        выгрузка: <code className="text-gold-200">pnpm mail:archive-dump</code>, обновление БД:{" "}
        <code className="text-gold-200">pnpm mail:archive-ingest</code>. Excel:{" "}
        <code className="text-gold-200">pnpm mail:archive-excel</code>.
      </Hint>
    </div>
  );
}