import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import type { ParserRun, ParserSettings, ParserStatus } from "../../api/types";
import { Button, Field, GoldCard, Hint, StatusBadge, inputClass } from "../../components/ui";

const STATUS_LABELS: Record<string, string> = {
  queued: "В очереди",
  running: "Выполняется",
  success: "Успех",
  failed: "Ошибка",
};

const TRIGGER_LABELS: Record<string, string> = {
  manual: "Кабинет",
  schedule: "Расписание",
  bat: "BAT / Task Scheduler",
};

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU");
}

export function ParsersPage() {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [form, setForm] = useState<ParserSettings | null>(null);

  const load = useCallback(
    () => api.get<ParserStatus>(`/parsers?_=${tick}`),
    [tick]
  );
  const data = usePoll(load, 5000);

  useEffect(() => {
    if (data?.settings) setForm({ ...data.settings });
  }, [data?.settings?.updated_at]);

  const runs = data?.runs ?? [];
  const active = data?.active_run;

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setErr("");
    setBusy(true);
    try {
      await api.put("/parsers/settings", {
        enabled: form.enabled,
        enrich_emails: form.enrich_emails,
        auto_seed: form.auto_seed,
      });
      setTick((n) => n + 1);
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : "Не удалось сохранить настройки");
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    setErr("");
    setBusy(true);
    try {
      await api.post("/parsers/run");
      setTick((n) => n + 1);
    } catch (ex) {
      if (ex instanceof ApiError && ex.status === 409) {
        setErr("Парсер уже выполняется — дождитесь завершения");
      } else {
        setErr(ex instanceof ApiError ? ex.message : "Не удалось запустить");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-serif text-3xl text-gold-300">Парсеры перевозчиков</h1>
        <Hint>
          Еженедельное обновление базы КазАТО (KZ) и БАМАП (BY): парсинг официальных списков,
          загрузка в CRM и поиск email для белорусских компаний. Расписание: понедельник 09:00
          (MSK) — через workers или Windows Task Scheduler (
          <code className="text-gold-200/80">scripts/weekly-associations-update.bat</code>
          ).
        </Hint>
      </header>

      {err ? <p className="text-sm text-red-300">{err}</p> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <GoldCard>
          <h2 className="mb-4 font-serif text-lg text-gold-200">Статус каталога</h2>
          {data?.catalog_counts ? (
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-gold-200/60">Всего</dt>
                <dd className="text-lg text-gold-100">{data.catalog_counts.total ?? 0}</dd>
              </div>
              <div>
                <dt className="text-gold-200/60">С email</dt>
                <dd className="text-lg text-gold-100">{data.catalog_counts.with_email ?? 0}</dd>
              </div>
              <div>
                <dt className="text-gold-200/60">КазАТО</dt>
                <dd>{data.catalog_counts.kazato ?? 0}</dd>
              </div>
              <div>
                <dt className="text-gold-200/60">БАМАП</dt>
                <dd>{data.catalog_counts.bamap ?? 0}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-gold-200/70">Каталог ещё не собран. Запустите парсер.</p>
          )}
          {active ? (
            <p className="mt-4 text-sm text-amber-200">
              Активный прогон: {STATUS_LABELS[active.status] ?? active.status} с{" "}
              {fmtDate(active.started_at)}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-3">
            <Button onClick={runNow} disabled={busy || Boolean(active)}>
              {active ? "Выполняется…" : "Запустить сейчас"}
            </Button>
            <Button variant="ghost" onClick={() => setTick((n) => n + 1)}>
              Обновить
            </Button>
          </div>
        </GoldCard>

        <GoldCard>
          <h2 className="mb-4 font-serif text-lg text-gold-200">Настройки автозапуска</h2>
          <form onSubmit={saveSettings} className="space-y-4">
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={form?.enabled ?? true}
                onChange={(e) =>
                  setForm((f) => (f ? { ...f, enabled: e.target.checked } : f))
                }
                className="accent-amber-500"
              />
              Автообновление по расписанию (workers, понедельник 09:00 MSK)
            </label>
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={form?.enrich_emails ?? true}
                onChange={(e) =>
                  setForm((f) => (f ? { ...f, enrich_emails: e.target.checked } : f))
                }
                className="accent-amber-500"
              />
              Искать email на сайтах белорусских компаний
            </label>
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                checked={form?.auto_seed ?? true}
                onChange={(e) =>
                  setForm((f) => (f ? { ...f, auto_seed: e.target.checked } : f))
                }
                className="accent-amber-500"
              />
              Загружать результат в CRM (seed)
            </label>
            <Field label="Cron (UTC)">
              <input
                className={inputClass()}
                value={form?.cron ?? "0 6 * * 1"}
                readOnly
                title="Понедельник 09:00 MSK = 06:00 UTC"
              />
            </Field>
            <Button type="submit" disabled={busy || !form}>
              Сохранить настройки
            </Button>
          </form>
        </GoldCard>
      </div>

      <GoldCard>
        <h2 className="mb-4 font-serif text-lg text-gold-200">Журнал запусков</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gold-800/40 text-gold-200/60">
                <th className="py-2 pr-4">Статус</th>
                <th className="py-2 pr-4">Источник</th>
                <th className="py-2 pr-4">Начало</th>
                <th className="py-2 pr-4">Конец</th>
                <th className="py-2 pr-4">Результат</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-4 text-gold-200/60">
                    Запусков пока нет
                  </td>
                </tr>
              ) : (
                runs.map((run: ParserRun) => (
                  <tr key={run.id} className="border-b border-gold-900/30">
                    <td className="py-2 pr-4">
                      <StatusBadge status={STATUS_LABELS[run.status] ?? run.status} />
                    </td>
                    <td className="py-2 pr-4">
                      {TRIGGER_LABELS[run.triggered_by] ?? run.triggered_by}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{fmtDate(run.started_at)}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{fmtDate(run.finished_at)}</td>
                    <td className="py-2 pr-4 text-gold-200/80">
                      {run.error ? (
                        <span className="text-red-300">{run.error.slice(0, 120)}</span>
                      ) : (
                        <>
                          {run.stats?.parse?.total != null
                            ? `${run.stats.parse.total} зап., email: ${run.stats.parse.with_email ?? "?"}`
                            : "—"}
                          {run.stats?.seed?.partners != null
                            ? ` · CRM: ${run.stats.seed.partners}`
                            : null}
                        </>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </GoldCard>
    </div>
  );
}
