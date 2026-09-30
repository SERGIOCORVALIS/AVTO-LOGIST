import { FormEvent, useCallback, useState } from "react";
import { api, ApiError } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import type {
  IssuedCredentials,
  ManagerAccount,
  StaffEvent,
} from "../../api/types";
import { Button, Field, GoldCard, Hint, StatusBadge, inputClass } from "../../components/ui";

const ACTION_LABELS: Record<string, string> = {
  login_ok: "Вход",
  login_fail: "Ошибка входа",
  manager_created: "Создан менеджер",
  manager_deleted: "Удалён менеджер",
  manager_password_reset: "Новый пароль",
  deal_patch: "Сделка",
  escalation_decide: "Эскалация",
};

export function ManagersPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [err, setErr] = useState("");
  const [issued, setIssued] = useState<IssuedCredentials | null>(null);
  const [actionFilter, setActionFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const loadManagers = useCallback(
    () => api.get<{ items: ManagerAccount[] }>(`/staff/managers?_=${tick}`),
    [tick]
  );
  const loadEvents = useCallback(() => {
    const q = actionFilter ? `?action=${encodeURIComponent(actionFilter)}` : "";
    return api.get<{ items: StaffEvent[] }>(`/staff/events${q}`);
  }, [actionFilter, tick]);

  const managers = usePoll(loadManagers, 8000)?.items ?? [];
  const events = usePoll(loadEvents, 6000)?.items ?? [];

  async function createManager(e: FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const r = await api.post<IssuedCredentials>("/staff/managers", {
        name: name.trim(),
        email: email.trim() || undefined,
      });
      setIssued(r);
      setName("");
      setEmail("");
      setTick((n) => n + 1);
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : "Не удалось создать менеджера");
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(id: string) {
    setErr("");
    try {
      const r = await api.post<IssuedCredentials>(`/staff/managers/${id}/password`);
      setIssued(r);
      setTick((n) => n + 1);
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : "Не удалось выдать пароль");
    }
  }

  async function removeManager(m: ManagerAccount) {
    if (!confirm(`Удалить менеджера ${m.name} (${m.email})? Вход с этой учёткой станет невозможен.`)) {
      return;
    }
    setErr("");
    try {
      await api.delete(`/staff/managers/${m.id}`);
      if (issued?.user.id === m.id) setIssued(null);
      setTick((n) => n + 1);
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : "Не удалось удалить");
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-serif text-3xl text-gold-300">Менеджеры</h1>
        <Hint>
          Директор создаёт учётки менеджеров, выдаёт логин и пароль и видит журнал: кто вошёл,
          кого добавили, какие сделки трогали. Пароль показывается один раз — скопируйте его
          сотруднику сразу.
        </Hint>
      </header>
      {err ? <p className="text-sm text-red-300">{err}</p> : null}

      {issued ? (
        <GoldCard className="border-gold-400/50">
          <p className="text-xs uppercase tracking-widest text-gold-400">Выданные доступы</p>
          <p className="mt-1 font-serif text-xl text-gold-300">{issued.user.name}</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <Cred label="Логин (email)" value={issued.login} />
            <Cred label="Пароль" value={issued.password} />
          </div>
          <Hint>После закрытия карточки пароль из журнала не восстановить — только выдать новый.</Hint>
          <div className="mt-3">
            <Button variant="ghost" onClick={() => setIssued(null)}>
              Скрыть
            </Button>
          </div>
        </GoldCard>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <GoldCard>
          <h2 className="font-serif text-xl text-gold-300">Добавить менеджера</h2>
          <form onSubmit={createManager} className="mt-4 space-y-4">
            <Field label="ФИО" hint="По имени соберём логин, если email не указать.">
              <input
                className={inputClass()}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Иван Петров"
                required
              />
            </Field>
            <Field
              label="Логин (email), необязательно"
              hint="Пустое поле — логин вида ivan.petrov@transinvest.local"
            >
              <input
                className={inputClass()}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ivan.petrov@transinvest.local"
                type="email"
              />
            </Field>
            <Button type="submit" disabled={busy}>
              {busy ? "Создаём…" : "Создать и выдать пароль"}
            </Button>
          </form>
        </GoldCard>

        <GoldCard className="overflow-x-auto p-0">
          <div className="border-b border-gold-500/20 px-5 py-4">
            <h2 className="font-serif text-xl text-gold-300">Команда</h2>
            <p className="text-xs text-white/40">{managers.length} менеджеров</p>
          </div>
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-gold-300/80">
              <tr>
                <th className="px-4 py-2">Имя</th>
                <th className="px-4 py-2">Логин</th>
                <th className="px-4 py-2">Вход</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {managers.map((m) => (
                <tr key={m.id} className="border-t border-white/5">
                  <td className="px-4 py-3">
                    {m.name}
                    {!m.active ? (
                      <span className="ml-2 text-xs text-white/40">выкл</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-white/70">{m.email}</td>
                  <td className="px-4 py-3 text-xs text-white/50">
                    {m.last_login_at
                      ? new Date(m.last_login_at).toLocaleString("ru-RU")
                      : "ещё не входил"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button variant="ghost" onClick={() => resetPassword(m.id)}>
                        Новый пароль
                      </Button>
                      <Button variant="danger" onClick={() => removeManager(m)}>
                        Удалить
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!managers.length ? (
            <p className="p-5 text-sm text-white/40">Пока нет менеджеров — создайте первого.</p>
          ) : null}
        </GoldCard>
      </div>

      <GoldCard>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-serif text-xl text-gold-300">Журнал событий</h2>
            <Hint>Входы, создание/удаление учёток, takeover, эскалации.</Hint>
          </div>
          <select
            className={`${inputClass()} max-w-xs`}
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
          >
            <option value="">Все события</option>
            {Object.entries(ACTION_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <ul className="mt-4 divide-y divide-white/5">
          {events.map((ev) => (
            <li key={ev.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={ACTION_LABELS[ev.action] || ev.action} />
                  <span className="text-xs text-white/40">
                    {ev.actor_email || "система"}
                    {ev.actor_role ? ` · ${ev.actor_role}` : ""}
                  </span>
                </div>
                <p className="mt-1 text-sm text-white/85">{ev.summary}</p>
              </div>
              <p className="text-xs text-gold-300/70">
                {new Date(ev.created_at).toLocaleString("ru-RU")}
              </p>
            </li>
          ))}
        </ul>
        {!events.length ? (
          <p className="mt-3 text-sm text-white/40">Журнал пуст — события появятся после входов и действий.</p>
        ) : null}
      </GoldCard>
    </div>
  );
}

function Cred({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg bg-navy-950 p-3">
      <p className="text-[10px] uppercase tracking-wider text-white/40">{label}</p>
      <p className="mt-1 break-all font-mono text-sm text-gold-200">{value}</p>
      <button
        type="button"
        className="mt-2 text-xs text-gold-300 hover:underline"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Скопировано" : "Копировать"}
      </button>
    </div>
  );
}
