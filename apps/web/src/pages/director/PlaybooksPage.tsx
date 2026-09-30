import { useCallback, useState } from "react";
import { api } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import type { Playbook } from "../../api/types";
import { Button, GoldCard, Hint, StatusBadge } from "../../components/ui";

export function PlaybooksPage() {
  const load = useCallback(() => api.get<Playbook[]>("/playbooks"), []);
  const list = usePoll(load, 10000) ?? [];
  const [err, setErr] = useState("");

  async function decide(id: string, decision: "canary" | "active" | "rejected" | "retired") {
    setErr("");
    try {
      await api.post(`/playbooks/${id}/decide`, { decision });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Ошибка");
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-serif text-3xl text-gold-300">Playbooks</h1>
        <Hint>
          Робот предлагает изменения тона и скидок. Canary — тест на части трафика, Active —
          основной сценарий. Reject и Retired выключают версию.
        </Hint>
      </header>
      {err ? <p className="text-sm text-red-300">{err}</p> : null}
      <div className="space-y-3">
        {list.map((p) => (
          <GoldCard key={p.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-serif text-lg text-gold-300">
                  {p.name} · {p.version}
                </p>
                <p className="text-xs text-white/40">{p.created_at}</p>
              </div>
              <StatusBadge status={p.status} />
            </div>
            <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-navy-950 p-3 text-xs text-white/70">
              {JSON.stringify(p.body, null, 2)}
            </pre>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="ghost" onClick={() => decide(p.id, "canary")}>
                Canary
              </Button>
              <Button onClick={() => decide(p.id, "active")}>Active</Button>
              <Button variant="ghost" onClick={() => decide(p.id, "rejected")}>
                Reject
              </Button>
              <Button variant="danger" onClick={() => decide(p.id, "retired")}>
                Retired
              </Button>
            </div>
          </GoldCard>
        ))}
        {!list.length ? <p className="text-white/40">Версий нет.</p> : null}
      </div>
    </div>
  );
}
