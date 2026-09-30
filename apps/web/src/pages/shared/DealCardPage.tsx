import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../api/client";
import {
  FOLDER_LABELS,
  STATUS_LABELS,
  type ArchiveItem,
  type CallBundle,
  type Deal,
  type DealMessage,
  type DocumentFolder,
  type PolicyConfig,
  type StaffRole,
} from "../../api/types";
import { Button, GoldCard, Hint, StatusBadge, inputClass } from "../../components/ui";
import { useAuth } from "../../auth/AuthContext";

export function DealCardPage() {
  const { id, role } = useParams<{ id: string; role: StaffRole }>();
  const { user } = useAuth();
  const [deal, setDeal] = useState<Deal | null>(null);
  const [messages, setMessages] = useState<DealMessage[]>([]);
  const [docs, setDocs] = useState<ArchiveItem[]>([]);
  const [calls, setCalls] = useState<CallBundle | null>(null);
  const [policy, setPolicy] = useState<PolicyConfig | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const refresh = useCallback(async () => {
    if (!id) return;
    const [d, m, doc, c, p] = await Promise.all([
      api.get<Deal>(`/deals/${id}`),
      api.get<DealMessage[]>(`/deals/${id}/messages`),
      api.get<{ items: ArchiveItem[] }>(`/documents?deal_id=${id}`),
      api.get<CallBundle>(`/calls/deal/${id}`),
      api.get<PolicyConfig>("/policy"),
    ]);
    setDeal(d);
    setMessages(m);
    setDocs(doc.items);
    setCalls(c);
    setPolicy(p);
  }, [id]);

  useEffect(() => {
    refresh().catch((e) => setErr(String(e.message || e)));
    const t = setInterval(() => refresh().catch(() => undefined), 8000);
    return () => clearInterval(t);
  }, [refresh]);

  async function patch(body: Record<string, unknown>) {
    if (!id) return;
    setErr("");
    try {
      const d = await api.patch<Deal>(`/deals/${id}`, body);
      setDeal(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Ошибка");
    }
  }

  async function approveKp() {
    if (!id) return;
    setErr("");
    try {
      await api.post(`/deals/${id}/approve-kp`, {});
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Ошибка");
    }
  }

  async function sendNote(e: FormEvent) {
    e.preventDefault();
    if (!id || !note.trim() || !deal) return;
    await api.post(`/deals/${id}/messages`, {
      tg_chat_id: deal.tg_chat_id || 0,
      direction: "system",
      sender: user?.name || "manager",
      text: note.trim(),
    });
    setNote("");
    await refresh();
  }

  async function cut3() {
    if (!deal || !policy) return;
    const price = Number(deal.offer?.price || deal.amount_rub || 0);
    if (!price) return;
    const next = Math.round(price * 0.97);
    const floor = Number(policy.floor_margin_pct || 10);
    const margin = Number(deal.margin_pct || 0);
    if (margin - 3 < floor && user?.role !== "director") {
      setErr("Скидка упрётся в пол маржи — это решает только директор.");
      return;
    }
    await patch({
      offer: { ...deal.offer, price: next },
      amount_rub: next,
      margin_pct: Math.max(floor, margin - 3),
    });
  }

  if (!deal) {
    return <p className="text-gold-300">{err || "Загрузка сделки…"}</p>;
  }

  const cargo = deal.cargo || {};
  const route = deal.route || {};
  const offer = deal.offer || {};
  const robotState = deal.takeover
    ? "Человек ведёт переписку. Робот молчит, пока не снимете takeover."
    : deal.paused
      ? "Робот на паузе и не отвечает клиенту."
      : deal.status === "awaiting_manager"
        ? "Робот ждёт вашего решения по эскалации."
        : "Робот отвечает клиенту сам.";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to={`/${role}/deals`} className="text-xs text-white/40 hover:text-gold-300">
            ← все сделки
          </Link>
          <h1 className="font-serif text-3xl text-gold-300">
            {deal.client_name || "Клиент"}
          </h1>
          <p className="text-sm text-white/50">{deal.id}</p>
          {deal.client_id ? (
            <Link
              to={`/${role}/clients/${deal.client_id}`}
              className="mt-1 inline-block text-sm text-gold-300 hover:underline"
            >
              карточка клиента в архиве →
            </Link>
          ) : null}
        </div>
        <StatusBadge status={STATUS_LABELS[deal.status] || deal.status} />
      </div>
      <Hint>{robotState}</Hint>
      {err ? <p className="text-sm text-red-300">{err}</p> : null}

      <div className="flex flex-wrap gap-2">
        <Button onClick={approveKp}>Утвердить КП</Button>
        <Button variant="ghost" onClick={cut3}>
          Скидка −3%
        </Button>
        <Button variant="ghost" onClick={() => patch({ paused: true })}>
          Пауза AI
        </Button>
        <Button
          variant="ghost"
          onClick={() => patch({ paused: false, takeover: false, escalate: false })}
        >
          Снять паузу
        </Button>
        <Button variant="ghost" onClick={() => patch({ takeover: true, paused: true })}>
          Takeover
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            if (
              window.confirm(
                "Отклонить сделку? Она исчезнет из активного списка (статус «Отмена»)."
              )
            ) {
              patch({ status: "cancelled" });
            }
          }}
        >
          Отклонить
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <GoldCard>
          <h2 className="font-serif text-lg text-gold-300">Груз</h2>
          <dl className="mt-3 space-y-1 text-sm text-white/80">
            <Row k="Название" v={String(cargo.name || "—")} />
            <Row k="Вес, кг" v={String(cargo.weight_kg ?? "—")} />
            <Row k="Инвойс" v={String(cargo.invoice_value ?? "—")} />
            <Row k="Класс" v={String(cargo.cargo_class || "—")} />
          </dl>
        </GoldCard>
        <GoldCard>
          <h2 className="font-serif text-lg text-gold-300">Маршрут</h2>
          <dl className="mt-3 space-y-1 text-sm text-white/80">
            <Row
              k="Плечо"
              v={`${route.origin_city || "?"} → ${route.destination_city || "?"}`}
            />
            <Row k="Коридор" v={String(route.corridor || "—")} />
            <Row k="Режим" v={String(route.transport_mode || "—")} />
            <Row
              k="Incoterms"
              v={`${route.origin_incoterm || "—"} / ${route.dest_incoterm || "—"}`}
            />
          </dl>
        </GoldCard>
        <GoldCard>
          <h2 className="font-serif text-lg text-gold-300">Оффер</h2>
          <dl className="mt-3 space-y-1 text-sm text-white/80">
            <Row k="Цена" v={offer.price != null ? `${offer.price} ${offer.currency || "RUB"}` : "—"} />
            <Row k="Маржа" v={deal.margin_pct != null ? `${deal.margin_pct}%` : "—"} />
            <Row
              k="Срок"
              v={
                offer.eta_days_min
                  ? `${offer.eta_days_min}–${offer.eta_days_max} дн.`
                  : "—"
              }
            />
            <Row k="Сумма" v={deal.amount_rub != null ? `${deal.amount_rub} ₽` : "—"} />
          </dl>
        </GoldCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <GoldCard className="flex max-h-[480px] flex-col">
          <h2 className="font-serif text-lg text-gold-300">Переписка</h2>
          <div className="mt-3 flex-1 space-y-2 overflow-y-auto pr-1">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`rounded-lg px-3 py-2 text-sm ${
                  m.direction === "inbound"
                    ? "bg-navy-700/60"
                    : m.direction === "system"
                      ? "bg-gold-500/10 text-gold-200"
                      : "bg-navy-950"
                }`}
              >
                <p className="text-[10px] uppercase text-white/40">
                  {m.sender} · {new Date(m.created_at).toLocaleString("ru-RU")}
                </p>
                <p className="whitespace-pre-wrap">{m.text}</p>
              </div>
            ))}
          </div>
          <form onSubmit={sendNote} className="mt-3 flex gap-2">
            <input
              className={inputClass()}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Заметка в карточку (клиент в Telegram её не увидит)"
            />
            <Button type="submit">Записать</Button>
          </form>
        </GoldCard>
        <div className="space-y-4">
          <GoldCard>
            <h2 className="font-serif text-lg text-gold-300">Риски и следующие шаги</h2>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-white/70">
              {(deal.risks || []).map((r, i) => (
                <li key={i}>
                  {r.severity}: {r.description}
                </li>
              ))}
              {(deal.next_actions || []).map((a, i) => (
                <li key={`a${i}`}>{a}</li>
              ))}
              {!deal.risks?.length && !deal.next_actions?.length ? (
                <li className="list-none text-white/40">Пока пусто</li>
              ) : null}
            </ul>
          </GoldCard>
          <GoldCard>
            <h2 className="font-serif text-lg text-gold-300">Звонки</h2>
            {calls?.active ? (
              <p className="text-sm text-gold-300">Идёт звонок</p>
            ) : (
              <p className="text-sm text-white/50">Активного звонка нет</p>
            )}
            <ul className="mt-2 space-y-1 text-xs text-white/50">
              {(calls?.recent || []).map((c) => (
                <li key={String(c.id)}>
                  {String(c.status)} · {String(c.phone)} · {String(c.started_at || "")}
                </li>
              ))}
            </ul>
          </GoldCard>
        </div>
      </div>

      <GoldCard>
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-lg text-gold-300">Документы сделки</h2>
          <Link className="text-xs text-gold-300" to={`/${role}/documents?deal=${deal.id}`}>
            открыть архив →
          </Link>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {(Object.keys(FOLDER_LABELS) as DocumentFolder[]).map((f) => {
            const n = docs.filter((d) => d.folder === f).length;
            return (
              <div key={f} className="rounded-lg bg-navy-950 p-3">
                <p className="text-xs text-white/40">{FOLDER_LABELS[f]}</p>
                <p className="font-serif text-xl text-gold-300">{n}</p>
              </div>
            );
          })}
        </div>
      </GoldCard>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-white/40">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
