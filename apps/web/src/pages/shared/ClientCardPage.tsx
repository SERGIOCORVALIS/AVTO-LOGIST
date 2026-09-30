import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../api/client";
import {
  ATTACHMENT_KIND_LABELS,
  MAILBOX_LABELS,
  MODE_LABELS,
  STATUS_LABELS,
  type ClientCard,
  type MailAttachment,
  type StaffRole,
} from "../../api/types";
import { GoldCard, Hint, StatusBadge, Button } from "../../components/ui";

type DocFilter =
  | "all"
  | "contracts"
  | "invoices"
  | "payments"
  | "kp"
  | "other";

function formatWhen(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
}

function formatBytes(bytes?: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function clientTitle(data: ClientCard | null): string {
  if (!data) return "Клиент";
  const c = data.client;
  return String(c.name || c.legal_name || c.primary_email || "Клиент");
}

function matchesFilter(a: MailAttachment, filter: DocFilter): boolean {
  if (filter === "all") return true;
  if (filter === "other") {
    return !["contracts", "invoices", "payments", "kp"].includes(a.kind);
  }
  if (filter === "invoices") {
    return a.kind === "invoices" || a.kind === "payments";
  }
  return a.kind === filter;
}

export function ClientCardPage() {
  const { id, role } = useParams<{ id: string; role: StaffRole }>();
  const [data, setData] = useState<ClientCard | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<
    "overview" | "calcs" | "docs" | "mail" | "deals"
  >("overview");
  const [docFilter, setDocFilter] = useState<DocFilter>("all");
  const [dlErr, setDlErr] = useState("");

  const refresh = useCallback(async () => {
    if (!id) return;
    const card = await api.get<ClientCard>(`/clients/${id}`);
    setData(card);
  }, [id]);

  useEffect(() => {
    refresh().catch((e) => setErr(String(e.message || e)));
  }, [refresh]);

  const factsByType = useMemo(() => {
    const map = new Map<string, ClientCard["facts"]>();
    for (const f of data?.facts ?? []) {
      const list = map.get(f.fact_type) || [];
      list.push(f);
      map.set(f.fact_type, list);
    }
    return map;
  }, [data]);

  const modes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of data?.calc_requests ?? []) {
      if (!c.mode) continue;
      counts.set(c.mode, (counts.get(c.mode) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

  const attachments = data?.attachments ?? [];
  const summary = data?.docs_summary ?? {
    contracts: attachments.filter((a) => a.kind === "contracts").length,
    invoices: attachments.filter((a) => a.kind === "invoices").length,
    payments: attachments.filter((a) => a.kind === "payments").length,
    kp: attachments.filter((a) => a.kind === "kp").length,
    other: attachments.filter(
      (a) => !["contracts", "invoices", "payments", "kp"].includes(a.kind)
    ).length,
    total: attachments.length,
  };

  const filteredDocs = useMemo(
    () => attachments.filter((a) => matchesFilter(a, docFilter)),
    [attachments, docFilter]
  );

  if (!data) {
    return <p className="text-gold-300">{err || "Загрузка карточки клиента…"}</p>;
  }

  const c = data.client;
  const ctx = (c.personal_context || {}) as Record<string, unknown>;
  const invoiceFacts = factsByType.get("invoice") ?? [];
  const contractFacts = factsByType.get("contract") ?? [];

  const downloadAttachment = async (attId: string, filename: string) => {
    setDlErr("");
    try {
      await api.download(`/clients/attachments/${attId}/file`, filename);
    } catch (e) {
      setDlErr(String((e as Error).message || e));
    }
  };

  const docsTabLabel = `Документы (${summary.total})`;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link
            to={`/${role}/clients`}
            className="text-xs text-white/40 hover:text-gold-300"
          >
            ← все клиенты
          </Link>
          <h1 className="font-serif text-3xl text-gold-300">{clientTitle(data)}</h1>
          <p className="text-sm text-white/50">{String(c.id)}</p>
        </div>
        {c.vip ? (
          <span className="rounded-lg bg-gold-500/20 px-3 py-1 text-sm text-gold-200">
            VIP
          </span>
        ) : null}
      </div>

      <Hint>
        Файлы из почты (договоры, счета, платёжки) — во вкладке «Документы». Скачивание
        сразу из карточки.
      </Hint>
      {err ? <p className="text-sm text-red-300">{err}</p> : null}

      <div className="flex flex-wrap gap-2">
        {(
          [
            ["overview", "Обзор"],
            ["calcs", `Расчёты (${data.calc_requests.length})`],
            ["docs", docsTabLabel],
            ["mail", `Почта (${data.recent_mail.length})`],
            ["deals", `Сделки (${data.deals.length})`],
          ] as const
        ).map(([key, label]) => (
          <Button
            key={key}
            variant={tab === key ? "gold" : "ghost"}
            onClick={() => setTab(key)}
          >
            {label}
          </Button>
        ))}
      </div>
      {dlErr ? <p className="text-sm text-red-300">{dlErr}</p> : null}

      {tab === "overview" ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <GoldCard>
            <h2 className="font-serif text-lg text-gold-300">Контакты</h2>
            <dl className="mt-3 space-y-1 text-sm text-white/80">
              <Row k="Email" v={String(c.primary_email || "—")} />
              <Row k="Телефон" v={String(c.phone || "—")} />
              <Row k="ИНН" v={String(c.inn || "—")} />
              <Row k="Юрлицо" v={String(c.legal_name || "—")} />
            </dl>
          </GoldCard>
          <GoldCard>
            <h2 className="font-serif text-lg text-gold-300">Документы из почты</h2>
            <dl className="mt-3 space-y-1 text-sm text-white/80">
              <Row k="Всего файлов" v={String(summary.total)} />
              <Row k="Договоры" v={String(summary.contracts)} />
              <Row
                k="Счета / платёжки"
                v={String(summary.invoices + summary.payments)}
              />
              <Row k="КП" v={String(summary.kp)} />
            </dl>
            {summary.total > 0 ? (
              <Button
                className="mt-3"
                variant="ghost"
                onClick={() => setTab("docs")}
              >
                Открыть документы →
              </Button>
            ) : null}
          </GoldCard>
          <GoldCard>
            <h2 className="font-serif text-lg text-gold-300">Память робота</h2>
            <dl className="mt-3 space-y-1 text-sm text-white/80">
              <Row k="Расчётов" v={String(ctx.calc_count ?? data.calc_requests.length)} />
              <Row
                k="Последний расчёт"
                v={formatWhen(String(ctx.last_calc_at || ""))}
              />
              <Row
                k="Режимы"
                v={
                  modes.length
                    ? modes
                        .slice(0, 4)
                        .map(([m, n]) => `${MODE_LABELS[m] || m} (${n})`)
                        .join(", ")
                    : "—"
                }
              />
            </dl>
          </GoldCard>
        </div>
      ) : null}

      {tab === "calcs" ? (
        <GoldCard className="overflow-x-auto p-0">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-white/10 text-xs uppercase text-gold-300/80">
              <tr>
                <th className="px-4 py-3 text-left">Дата</th>
                <th className="px-4 py-3 text-left">Маршрут</th>
                <th className="px-4 py-3 text-left">Режим</th>
                <th className="px-4 py-3 text-left">Груз / тема</th>
              </tr>
            </thead>
            <tbody>
              {data.calc_requests.map((r) => (
                <tr key={r.id} className="border-b border-white/5">
                  <td className="px-4 py-2 text-xs text-white/50">
                    {formatWhen(r.requested_at)}
                  </td>
                  <td className="px-4 py-2">
                    {r.origin || "?"} → {r.destination || "?"}
                  </td>
                  <td className="px-4 py-2 text-gold-300">
                    {r.mode ? MODE_LABELS[r.mode] || r.mode : "—"}
                  </td>
                  <td className="max-w-md truncate px-4 py-2 text-white/70">
                    {r.cargo_desc || "—"}
                  </td>
                </tr>
              ))}
              {!data.calc_requests.length ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-white/40">
                    Расчётов в архиве нет
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </GoldCard>
      ) : null}

      {tab === "docs" ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {(
              [
                ["all", `Все (${summary.total})`],
                ["contracts", `Договоры (${summary.contracts})`],
                [
                  "invoices",
                  `Счета / платёжки (${summary.invoices + summary.payments})`,
                ],
                ["payments", `Только платёжки (${summary.payments})`],
                ["kp", `КП (${summary.kp})`],
                ["other", `Прочее (${summary.other})`],
              ] as const
            ).map(([key, label]) => (
              <Button
                key={key}
                variant={docFilter === key ? "gold" : "ghost"}
                onClick={() => setDocFilter(key)}
              >
                {label}
              </Button>
            ))}
          </div>

          <GoldCard className="overflow-x-auto p-0">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-white/10 text-xs uppercase text-gold-300/80">
                <tr>
                  <th className="px-4 py-3 text-left">Тип</th>
                  <th className="px-4 py-3 text-left">Файл</th>
                  <th className="px-4 py-3 text-left">Письмо</th>
                  <th className="px-4 py-3 text-left">Размер</th>
                  <th className="px-4 py-3 text-left">Дата</th>
                  <th className="px-4 py-3 text-left" />
                </tr>
              </thead>
              <tbody>
                {filteredDocs.map((a) => (
                  <tr key={a.id} className="border-b border-white/5">
                    <td className="px-4 py-2 whitespace-nowrap text-gold-300">
                      {ATTACHMENT_KIND_LABELS[a.kind] || a.kind}
                    </td>
                    <td className="max-w-xs truncate px-4 py-2" title={a.filename}>
                      {a.filename}
                    </td>
                    <td className="max-w-xs truncate px-4 py-2 text-xs text-white/50">
                      {a.mail_subject ||
                        (a.mailbox_id
                          ? MAILBOX_LABELS[a.mailbox_id] || a.mailbox_id
                          : "—")}
                    </td>
                    <td className="px-4 py-2 text-xs text-white/50">
                      {formatBytes(a.bytes)}
                    </td>
                    <td className="px-4 py-2 text-xs text-white/50">
                      {formatWhen(a.mail_sent_at || a.created_at)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button
                        variant="ghost"
                        onClick={() => downloadAttachment(a.id, a.filename)}
                      >
                        Скачать
                      </Button>
                    </td>
                  </tr>
                ))}
                {!filteredDocs.length ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-6 text-center text-white/40">
                      Файлов в этой категории нет
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </GoldCard>

          {(contractFacts.length > 0 || invoiceFacts.length > 0) &&
          docFilter === "all" ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <FactList
                title="Упоминания договоров в письмах"
                items={contractFacts}
              />
              <FactList
                title="Упоминания счетов в письмах"
                items={invoiceFacts}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === "mail" ? (
        <div className="space-y-4">
          {data.threads.length ? (
            <GoldCard>
              <h2 className="font-serif text-lg text-gold-300">Треды</h2>
              <ul className="mt-2 space-y-2 text-sm">
                {data.threads.slice(0, 20).map((t) => (
                  <li key={t.id} className="rounded-lg bg-navy-950 p-3">
                    <p className="text-gold-300">{t.subject_norm || t.thread_key}</p>
                    <p className="text-xs text-white/40">
                      {t.message_count} пис. · {formatWhen(t.last_at)}
                    </p>
                  </li>
                ))}
              </ul>
            </GoldCard>
          ) : null}
          <GoldCard>
            <h2 className="font-serif text-lg text-gold-300">Последние письма</h2>
            <div className="mt-3 space-y-2">
              {data.recent_mail.map((m) => (
                <div key={m.id} className="rounded-lg border border-white/5 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-white/40">
                    <span>
                      {MAILBOX_LABELS[m.mailbox_id] || m.mailbox_id} · {m.folder}
                    </span>
                    <span>{formatWhen(m.sent_at)}</span>
                  </div>
                  <p className="mt-1 text-sm font-medium text-gold-300">
                    {m.subject || "(без темы)"}
                  </p>
                  <p className="text-xs text-white/50">{m.from_email}</p>
                  {m.preview ? (
                    <p className="mt-2 line-clamp-3 text-sm text-white/70">{m.preview}</p>
                  ) : null}
                </div>
              ))}
              {!data.recent_mail.length ? (
                <p className="text-sm text-white/40">Писем нет</p>
              ) : null}
            </div>
          </GoldCard>
        </div>
      ) : null}

      {tab === "deals" ? (
        <GoldCard className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-white/10 text-xs uppercase text-gold-300/80">
              <tr>
                <th className="px-4 py-3 text-left">Сделка</th>
                <th className="px-4 py-3 text-left">Статус</th>
                <th className="px-4 py-3 text-left">Канал</th>
                <th className="px-4 py-3 text-left">Маршрут</th>
                <th className="px-4 py-3 text-left">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {data.deals.map((d) => {
                const route = d.route || {};
                return (
                  <tr key={d.id} className="border-b border-white/5 hover:bg-navy-950/50">
                    <td className="px-4 py-3">
                      <Link
                        to={`/${role}/deals/${d.id}`}
                        className="text-gold-300 hover:underline"
                      >
                        {d.client_name || d.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={STATUS_LABELS[d.status] || d.status} />
                    </td>
                    <td className="px-4 py-3">{d.channel}</td>
                    <td className="px-4 py-3 text-xs">
                      {String(route.origin_city || "?")} →{" "}
                      {String(route.destination_city || "?")}
                    </td>
                    <td className="px-4 py-3">
                      {d.amount_rub != null ? `${d.amount_rub} ₽` : "—"}
                    </td>
                  </tr>
                );
              })}
              {!data.deals.length ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-white/40">
                    Сделок с этим client_id пока нет — появятся после диалога в Telegram/АТС
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </GoldCard>
      ) : null}
    </div>
  );
}

function FactList({
  title,
  items,
}: {
  title: string;
  items: ClientCard["facts"];
}) {
  return (
    <GoldCard>
      <h2 className="font-serif text-lg text-gold-300">{title}</h2>
      <ul className="mt-3 max-h-[320px] space-y-2 overflow-y-auto text-sm">
        {items.map((f) => (
          <li key={f.id} className="rounded-lg bg-navy-950 p-3">
            <p className="line-clamp-2 text-white/80">{f.value}</p>
            <p className="mt-1 text-xs text-white/40">{formatWhen(f.created_at)}</p>
          </li>
        ))}
        {!items.length ? (
          <li className="text-white/40">В архиве не найдено</li>
        ) : null}
      </ul>
    </GoldCard>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-white/40">{k}</dt>
      <dd className="text-right">{v}</dd>
    </div>
  );
}
