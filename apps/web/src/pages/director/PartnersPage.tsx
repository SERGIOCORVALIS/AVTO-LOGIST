import { FormEvent, useCallback, useMemo, useState } from "react";
import { api, ApiError } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import type { Partner, PartnerListResponse } from "../../api/types";
import { Button, Field, GoldCard, Hint, inputClass } from "../../components/ui";

type Tab = "active" | "silent" | "left" | "paused" | "all";

const MODE_OPTIONS: { value: string; label: string }[] = [
  { value: "ltl_groupage", label: "Сборка" },
  { value: "ftl_truck", label: "Фура" },
  { value: "road_train", label: "Автопоезд" },
  { value: "container", label: "Контейнер" },
  { value: "rail", label: "ЖД" },
  { value: "sea", label: "Море" },
  { value: "air", label: "Авиа" },
  { value: "night_express", label: "Ночной экспресс" },
];

const TAB_META: { id: Tab; label: string; hint: string }[] = [
  { id: "active", label: "В RFQ", hint: "Получают запросы ставок" },
  { id: "silent", label: "Не отвечают", hint: "Исключены из рассылки до реактивации" },
  { id: "left", label: "Ушли с рынка", hint: "Больше не работаем" },
  { id: "paused", label: "Пауза", hint: "Временно выключены" },
  { id: "all", label: "Все", hint: "Полный список" },
];

function statusLabel(p: Partner): string {
  if (p.status === "silent" || p.silent) return "Не отвечает";
  if (p.status === "left" || p.left_market) return "Ушёл";
  if (p.status === "paused" || !p.active) return "Пауза";
  return "В RFQ";
}

function statusClass(p: Partner): string {
  if (p.status === "silent" || p.silent) return "bg-amber-500/20 text-amber-200";
  if (p.status === "left" || p.left_market) return "bg-red-900/50 text-red-200";
  if (p.status === "paused" || !p.active) return "bg-white/10 text-white/60";
  return "bg-emerald-500/15 text-emerald-200";
}

export function PartnersPage() {
  const [tab, setTab] = useState<Tab>("active");
  const [search, setSearch] = useState("");
  const [tick, setTick] = useState(0);
  const [err, setErr] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [emails, setEmails] = useState("");
  const [modes, setModes] = useState<string[]>(["ltl_groupage"]);
  const [note, setNote] = useState("");
  const [creating, setCreating] = useState(false);

  const [actionNote, setActionNote] = useState("");
  const [pendingAction, setPendingAction] = useState<{
    id: string;
    path: "silent" | "left-market";
    name: string;
  } | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams({ status: tab });
    if (search.trim()) params.set("q", search.trim());
    params.set("_", String(tick));
    return api.get<PartnerListResponse>(`/partners?${params}`);
  }, [tab, search, tick]);

  const data = usePoll(load, 12000);
  const items = data?.items ?? [];
  const counts = data?.counts ?? {
    active: 0,
    silent: 0,
    left: 0,
    paused: 0,
    all: 0,
  };

  const countFor = useMemo(
    () =>
      ({
        active: counts.active,
        silent: counts.silent,
        left: counts.left,
        paused: counts.paused,
        all: counts.all,
      }) as Record<Tab, number>,
    [counts]
  );

  function refresh() {
    setTick((n) => n + 1);
  }

  async function createPartner(e: FormEvent) {
    e.preventDefault();
    setErr("");
    setCreating(true);
    try {
      await api.post("/partners", {
        name: name.trim(),
        emails,
        modes,
        notes: note.trim() || undefined,
      });
      setName("");
      setEmails("");
      setNote("");
      setTab("active");
      refresh();
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : "Не удалось добавить");
    } finally {
      setCreating(false);
    }
  }

  async function runAction(
    id: string,
    path: "silent" | "reactivate" | "left-market" | "pause",
    noteText?: string
  ) {
    setErr("");
    setBusyId(id);
    try {
      await api.post(
        `/partners/${id}/${path}`,
        noteText?.trim() ? { note: noteText.trim() } : {}
      );
      if (path === "silent") setTab("silent");
      if (path === "left-market") setTab("left");
      if (path === "reactivate") setTab("active");
      if (path === "pause") setTab("paused");
      setPendingAction(null);
      setActionNote("");
      refresh();
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : "Действие не выполнено");
    } finally {
      setBusyId(null);
    }
  }

  function toggleMode(m: string) {
    setModes((prev) =>
      prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]
    );
  }

  function fmtWhen(iso?: string | null) {
    if (!iso) return null;
    try {
      return new Date(iso).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return null;
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-serif text-3xl text-gold-300">Поставщики</h1>
        <Hint>
          «Не отвечают» не получают RFQ. Автопометка: после 3 RFQ без ответа или 72 ч
          тишины (настраивается в .env). Ответ по IMAP снимает auto-silent.
        </Hint>
      </header>

      {err ? <p className="text-sm text-red-300">{err}</p> : null}

      {pendingAction ? (
        <GoldCard className="border-amber-400/40">
          <p className="text-xs uppercase tracking-widest text-amber-200">
            {pendingAction.path === "silent" ? "Не отвечает" : "Ушёл с рынка"}
          </p>
          <p className="mt-1 font-serif text-lg text-gold-300">{pendingAction.name}</p>
          <Field label="Комментарий" hint="Опционально — видно во вкладке">
            <input
              className={inputClass()}
              value={actionNote}
              onChange={(e) => setActionNote(e.target.value)}
              placeholder="Не берёт трубку / ушёл из отрасли…"
              autoFocus
            />
          </Field>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              onClick={() =>
                runAction(pendingAction.id, pendingAction.path, actionNote)
              }
              disabled={busyId === pendingAction.id}
            >
              Подтвердить
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setPendingAction(null);
                setActionNote("");
              }}
            >
              Отмена
            </Button>
          </div>
        </GoldCard>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {TAB_META.map((t) => (
          <button
            key={t.id}
            type="button"
            title={t.hint}
            onClick={() => setTab(t.id)}
            className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
              tab === t.id
                ? "bg-gold-500 text-navy-950"
                : "border border-gold-500/30 text-gold-300/90 hover:bg-gold-500/10"
            }`}
          >
            {t.label}
            <span className="ml-2 opacity-70">{countFor[t.id]}</span>
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <GoldCard>
          <h2 className="font-serif text-xl text-gold-300">Добавить</h2>
          <form onSubmit={createPartner} className="mt-4 space-y-3">
            <Field label="Компания">
              <input
                className={inputClass()}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                placeholder="Optimalog"
              />
            </Field>
            <Field label="Email" hint="Несколько через запятую или с новой строки">
              <textarea
                className={inputClass()}
                rows={3}
                value={emails}
                onChange={(e) => setEmails(e.target.value)}
                required
                placeholder="rates@partner.ru"
              />
            </Field>
            <Field label="Режимы">
              <div className="flex flex-wrap gap-2">
                {MODE_OPTIONS.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => toggleMode(m.value)}
                    className={`rounded-md px-2 py-1 text-xs ${
                      modes.includes(m.value)
                        ? "bg-gold-500/30 text-gold-200"
                        : "bg-white/5 text-white/50"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Заметка">
              <input
                className={inputClass()}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Контакт с выставки…"
              />
            </Field>
            <Button type="submit" disabled={creating || !name.trim() || !emails.trim()}>
              {creating ? "Сохраняю…" : "В базу RFQ"}
            </Button>
          </form>
        </GoldCard>

        <div className="space-y-3">
          <GoldCard className="!p-3">
            <input
              className={inputClass()}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск: имя, код, email…"
            />
          </GoldCard>

          <GoldCard className="overflow-x-auto p-0">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gold-500/20 text-xs uppercase text-gold-300/80">
                <tr>
                  <th className="px-4 py-3">Компания</th>
                  <th className="px-4 py-3">Статус</th>
                  <th className="px-4 py-3">Режимы</th>
                  <th className="px-4 py-3">Почта</th>
                  <th className="px-4 py-3">Score</th>
                  <th className="px-4 py-3">Действия</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-white/40">
                      Пусто в этой вкладке
                    </td>
                  </tr>
                ) : null}
                {items.map((p) => {
                  const modeList = p.supplier_modes?.length
                    ? p.supplier_modes
                    : p.modes || [];
                  const emailList = p.emails || [];
                  const busy = busyId === p.id;
                  return (
                    <tr key={p.id} className="border-b border-white/5 align-top">
                      <td className="px-4 py-3">
                        <div className="font-medium text-white">{p.name}</div>
                        <div className="text-xs text-white/40">{p.code || "—"}</div>
                        {p.silent_note ? (
                          <div className="mt-1 text-xs text-amber-200/80">
                            {p.silent_note}
                          </div>
                        ) : null}
                        <div className="mt-1 space-y-0.5 text-[11px] text-white/35">
                          {p.no_reply_streak ? (
                            <div>RFQ без ответа: {p.no_reply_streak}</div>
                          ) : null}
                          {fmtWhen(p.last_rfq_at) ? (
                            <div>Последний RFQ: {fmtWhen(p.last_rfq_at)}</div>
                          ) : null}
                          {fmtWhen(p.last_reply_at) ? (
                            <div>Ответ: {fmtWhen(p.last_reply_at)}</div>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${statusClass(p)}`}
                        >
                          {statusLabel(p)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-white/60">
                        {modeList.length
                          ? modeList
                              .map(
                                (m) =>
                                  MODE_OPTIONS.find((o) => o.value === m)?.label || m
                              )
                              .join(", ")
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-xs text-white/70">
                        {emailList.length ? emailList.slice(0, 2).join(", ") : "—"}
                        {emailList.length > 2 ? ` +${emailList.length - 2}` : ""}
                      </td>
                      <td className="px-4 py-3 text-gold-300">
                        {Number(p.score).toFixed(2)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          {p.status === "active" ? (
                            <>
                              <Button
                                variant="ghost"
                                disabled={busy}
                                onClick={() =>
                                  setPendingAction({
                                    id: p.id,
                                    path: "silent",
                                    name: p.name,
                                  })
                                }
                              >
                                Не отвечает
                              </Button>
                              <Button
                                variant="ghost"
                                disabled={busy}
                                onClick={() => runAction(p.id, "pause")}
                              >
                                Пауза
                              </Button>
                              <Button
                                variant="danger"
                                disabled={busy}
                                onClick={() =>
                                  setPendingAction({
                                    id: p.id,
                                    path: "left-market",
                                    name: p.name,
                                  })
                                }
                              >
                                Ушёл
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="gold"
                              disabled={busy}
                              onClick={() => runAction(p.id, "reactivate")}
                            >
                              Вернуть в RFQ
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </GoldCard>
        </div>
      </div>
    </div>
  );
}
