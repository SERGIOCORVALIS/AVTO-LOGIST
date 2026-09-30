import { useCallback, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import {
  DIRECTOR_ESCALATION_REASONS,
  type Escalation,
  type StaffRole,
} from "../../api/types";
import { Button, GoldCard, Hint, StatusBadge, inputClass } from "../../components/ui";
import { useAuth } from "../../auth/AuthContext";

export function EscalationsPage() {
  const { role } = useParams<{ role: StaffRole }>();
  const { user } = useAuth();
  const [note, setNote] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const load = useCallback(() => api.get<Escalation[]>("/escalations?status=pending"), []);
  const list = usePoll(load, 6000) ?? [];

  async function decide(id: string, decision: "approved" | "rejected", reason: string) {
    setErr("");
    if (DIRECTOR_ESCALATION_REASONS.has(reason) && user?.role !== "director") {
      setErr("Эту эскалацию может закрыть только директор.");
      return;
    }
    try {
      await api.post(`/escalations/${id}/decide`, {
        decision,
        manager_note: note[id] || undefined,
      });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Ошибка решения");
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-serif text-3xl text-gold-300">Эскалации</h1>
        <Hint>
          Робот останавливается, когда сумма велика, нет поставщика, нужен инвойс или юрист.
          Approve возвращает сделку в работу, Reject закрывает её.
        </Hint>
      </header>
      {err ? <p className="text-sm text-red-300">{err}</p> : null}
      <div className="space-y-3">
        {list.map((e) => {
          const locked =
            DIRECTOR_ESCALATION_REASONS.has(e.reason) && user?.role !== "director";
          return (
            <GoldCard key={e.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <Link
                    className="font-serif text-lg text-gold-300 hover:underline"
                    to={`/${role}/deals/${e.deal_id}`}
                  >
                    {e.client_name || e.deal_id.slice(0, 8)}
                  </Link>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <StatusBadge status={e.reason} />
                    {e.needed_decision ? <StatusBadge status={e.needed_decision} /> : null}
                  </div>
                </div>
                <p className="text-sm text-white/50">
                  {e.amount_rub != null
                    ? `${Number(e.amount_rub).toLocaleString("ru-RU")} ₽`
                    : ""}
                </p>
              </div>
              <p className="mt-3 text-sm text-white/80">{e.summary}</p>
              {e.recommendation ? (
                <p className="mt-2 text-sm text-gold-200/80">Рекомендация: {e.recommendation}</p>
              ) : null}
              {locked ? (
                <Hint>Заблокировано: решение директора (сумма / маржа / юристы / серая схема).</Hint>
              ) : (
                <div className="mt-4 flex flex-wrap items-end gap-2">
                  <input
                    className={`${inputClass()} max-w-sm`}
                    placeholder="Комментарий"
                    value={note[e.id] || ""}
                    onChange={(ev) => setNote((s) => ({ ...s, [e.id]: ev.target.value }))}
                  />
                  <Button onClick={() => decide(e.id, "approved", e.reason)}>Approve</Button>
                  <Button
                    variant="danger"
                    onClick={() => decide(e.id, "rejected", e.reason)}
                  >
                    Reject
                  </Button>
                </div>
              )}
            </GoldCard>
          );
        })}
        {!list.length ? (
          <GoldCard>
            <p className="text-white/50">Очередь пуста — робот справляется сам.</p>
          </GoldCard>
        ) : null}
      </div>
    </div>
  );
}
