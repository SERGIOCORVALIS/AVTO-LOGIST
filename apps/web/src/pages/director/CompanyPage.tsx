import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { GoldCard, Hint } from "../../components/ui";

interface CompanyPayload {
  company: Record<string, string>;
  requisites_md: string;
}

export function CompanyPage() {
  const [data, setData] = useState<CompanyPayload | null>(null);
  useEffect(() => {
    api.get<CompanyPayload>("/company").then(setData);
  }, []);
  if (!data) return <p className="text-gold-300">Загрузка реквизитов…</p>;
  const c = data.company;
  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-serif text-3xl text-gold-300">Компания</h1>
        <Hint>
          Карточка юридического лица, которую робот подставляет в договоры и голос. Секреты .env
          сюда не попадают.
        </Hint>
      </header>
      <GoldCard>
        <p className="font-serif text-2xl text-gold-300">{c.legal_name}</p>
        <p className="text-white/60">{c.short_name}</p>
        <dl className="mt-4 grid gap-2 text-sm md:grid-cols-2">
          {Object.entries(c).map(([k, v]) => (
            <div key={k} className="rounded-lg bg-navy-950/80 p-3">
              <dt className="text-[10px] uppercase tracking-wide text-white/40">{k}</dt>
              <dd className="text-white/90">{v || "—"}</dd>
            </div>
          ))}
        </dl>
      </GoldCard>
      <GoldCard>
        <h2 className="font-serif text-lg text-gold-300">Блок для договора</h2>
        <pre className="mt-3 whitespace-pre-wrap text-sm text-white/70">{data.requisites_md}</pre>
      </GoldCard>
    </div>
  );
}
