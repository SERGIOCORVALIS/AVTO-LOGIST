import { useCallback, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../api/client";
import { usePoll } from "../../api/usePoll";
import {
  FOLDER_LABELS,
  type ArchiveItem,
  type DocumentFolder,
  type StaffRole,
} from "../../api/types";
import { Button, GoldCard, Hint, inputClass } from "../../components/ui";

const FOLDERS = Object.keys(FOLDER_LABELS) as DocumentFolder[];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || "");
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function DocumentsPage() {
  const { role } = useParams<{ role: StaffRole }>();
  const [params, setParams] = useSearchParams();
  const dealId = params.get("deal") || "";
  const folder = (params.get("folder") || "") as DocumentFolder | "";
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadFolder, setUploadFolder] = useState<DocumentFolder>("client");
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    const q = new URLSearchParams();
    if (dealId) q.set("deal_id", dealId);
    if (folder) q.set("folder", folder);
    return api.get<{
      folders: DocumentFolder[];
      counts: Record<string, number>;
      items: ArchiveItem[];
    }>(`/documents?${q.toString()}`);
  }, [dealId, folder]);
  const data = usePoll(load, 10000);
  const items = data?.items ?? [];
  const counts = data?.counts ?? {};

  const grouped = useMemo(() => {
    const m: Record<string, ArchiveItem[]> = {};
    for (const it of items) {
      (m[it.folder] ||= []).push(it);
    }
    return m;
  }, [items]);

  async function download(it: ArchiveItem) {
    if (it.source === "attachment") {
      await api.download(
        `/deals/${it.deal_id}/attachments/${it.id}/file`,
        it.filename
      );
      return;
    }
    if (it.source === "contract") {
      try {
        await api.download(
          `/deals/${it.deal_id}/contract.pdf?contract_id=${it.id}`,
          `contract-${it.deal_id.slice(0, 8)}.pdf`
        );
        return;
      } catch {
        /* markdown fallback */
      }
      const c = await api.get<{ draft_md?: string }>(
        `/deals/${it.deal_id}/contracts/${it.id}`
      );
      const blob = new Blob([c.draft_md || ""], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = it.filename;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    const quotes = await api.get<unknown[]>(`/deals/${it.deal_id}/quotes`);
    const one = (quotes as Array<{ id: string }>).find((q) => q.id === it.id);
    try {
      await api.download(
        `/deals/${it.deal_id}/kp.pdf`,
        `kp-${it.deal_id.slice(0, 8)}.pdf`
      );
      return;
    } catch {
      /* JSON fallback below */
    }
    const blob = new Blob([JSON.stringify(one ?? quotes, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = it.filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function move(it: ArchiveItem, next: DocumentFolder) {
    if (it.source !== "attachment") {
      setMsg("Виртуальные КП и договоры нельзя переносить — это записи робота.");
      return;
    }
    await api.patch(`/deals/${it.deal_id}/attachments/${it.id}`, { folder: next });
  }

  async function onFile(file: File) {
    if (!dealId) {
      setMsg("Выберите сделку (откройте архив из карточки), чтобы загрузить файл.");
      return;
    }
    const b64 = await fileToBase64(file);
    await api.post(`/deals/${dealId}/attachments`, {
      filename: file.name,
      content_base64: b64,
      content_type: file.type || "application/octet-stream",
      folder: uploadFolder,
    });
    setMsg("Файл загружен в выбранную папку.");
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-serif text-3xl text-gold-300">Архив документов</h1>
        <Hint>
          Файлы сделки лежат по папкам: КП, договоры, счета, таможня, вложения клиента. КП и
          черновики договоров робот кладёт сюда сам.
        </Hint>
      </header>
      {msg ? <p className="text-sm text-gold-300">{msg}</p> : null}

      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        <GoldCard className="h-fit">
          <button
            className={`mb-2 block w-full rounded-lg px-3 py-2 text-left text-sm ${
              !folder ? "bg-gold-500/15 text-gold-300" : "text-white/70"
            }`}
            onClick={() => {
              params.delete("folder");
              setParams(params);
            }}
          >
            Все папки
          </button>
          {FOLDERS.map((f) => (
            <button
              key={f}
              className={`mb-1 block w-full rounded-lg px-3 py-2 text-left text-sm ${
                folder === f ? "bg-gold-500/15 text-gold-300" : "text-white/70"
              }`}
              onClick={() => {
                params.set("folder", f);
                setParams(params);
              }}
            >
              {FOLDER_LABELS[f]}
              <span className="float-right text-white/40">{counts[f] ?? 0}</span>
            </button>
          ))}
        </GoldCard>

        <div className="space-y-4">
          {dealId ? (
            <GoldCard>
              <p className="text-sm text-white/60">
                Загрузка в сделку{" "}
                <Link className="text-gold-300" to={`/${role}/deals/${dealId}`}>
                  {dealId.slice(0, 8)}
                </Link>
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <select
                  className={`${inputClass()} max-w-xs`}
                  value={uploadFolder}
                  onChange={(e) => setUploadFolder(e.target.value as DocumentFolder)}
                >
                  {FOLDERS.map((f) => (
                    <option key={f} value={f}>
                      {FOLDER_LABELS[f]}
                    </option>
                  ))}
                </select>
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onFile(f);
                  }}
                />
                <Button onClick={() => fileRef.current?.click()}>Загрузить файл</Button>
              </div>
            </GoldCard>
          ) : (
            <Hint>Чтобы загрузить файл, откройте архив из карточки сделки.</Hint>
          )}

          {(folder ? [folder] : FOLDERS).map((f) => (
            <GoldCard key={f}>
              <h2 className="font-serif text-lg text-gold-300">{FOLDER_LABELS[f]}</h2>
              <ul className="mt-3 divide-y divide-white/5">
                {(grouped[f] || []).map((it) => (
                  <li
                    key={`${it.source}-${it.id}`}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                  >
                    <div>
                      <p className="text-white">{it.filename}</p>
                      <p className="text-xs text-white/40">
                        {it.client_name || it.deal_id.slice(0, 8)} · {it.source} ·{" "}
                        {it.created_at
                          ? new Date(it.created_at).toLocaleString("ru-RU")
                          : ""}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      {it.source === "attachment" ? (
                        <select
                          className={`${inputClass()} w-40`}
                          value={it.folder}
                          onChange={(e) =>
                            move(it, e.target.value as DocumentFolder)
                          }
                        >
                          {FOLDERS.map((x) => (
                            <option key={x} value={x}>
                              {FOLDER_LABELS[x]}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      <Button variant="ghost" onClick={() => download(it)}>
                        Скачать
                      </Button>
                    </div>
                  </li>
                ))}
                {!(grouped[f] || []).length ? (
                  <li className="py-2 text-white/40">Папка пуста</li>
                ) : null}
              </ul>
            </GoldCard>
          ))}
        </div>
      </div>
    </div>
  );
}
