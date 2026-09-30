/**
 * Organize Yandex/Gmail mailbox: create folders, sort messages, export analysis.
 * Usage: npx tsx scripts/mail-organize.ts [--dry-run] [--limit N]
 */
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync } from "fs";
import { ImapFlow } from "imapflow";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(ROOT, ".env") });

const DRY_RUN = process.argv.includes("--dry-run");
const MAILBOX = (() => {
  const i = process.argv.indexOf("--mailbox");
  return i >= 0 ? String(process.argv[i + 1] || "INBOX") : "INBOX";
})();
const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i >= 0 ? Number(process.argv[i + 1] || 0) : 0;
})();

const FOLDERS = [
  "ALO/01_Клиенты_запросы",
  "ALO/02_Поставщики_ставки",
  "ALO/03_Партнёры_перевозчики",
  "ALO/04_Таможня_документы",
  "ALO/05_Выкуп_Китай",
  "ALO/06_Внутреннее",
  "ALO/07_Системные",
  "ALO/08_Архив",
] as const;

type Folder = (typeof FOLDERS)[number];

interface MailRow {
  uid: number;
  from: string;
  fromDomain: string;
  subject: string;
  date: string;
  textPreview: string;
  folder: Folder;
  reason: string;
}

function domainFrom(from: string): string {
  const m = from.match(/@([\w.-]+)/i);
  return (m?.[1] || "").toLowerCase();
}

function classify(
  from: string,
  subject: string,
  text: string,
  mailbox: string
): { folder: Folder; reason: string } {
  const lowSub = (subject || "").toLowerCase();
  const lowText = (text || "").toLowerCase();
  const dom = domainFrom(from);
  const blob = `${lowSub} ${lowText} ${from.toLowerCase()}`;

  if (/^sent$/i.test(mailbox) || /отправ/i.test(mailbox)) {
    if (/запрос ставк|запрос выкуп|ref:\s*[0-9a-f-]{36}/i.test(blob)) {
      return { folder: "ALO/02_Поставщики_ставки", reason: "исходящий RFQ" };
    }
    if (/клиент|заявк|расч[её]т/i.test(blob)) {
      return { folder: "ALO/01_Клиенты_запросы", reason: "исходящее клиенту" };
    }
    return { folder: "ALO/06_Внутреннее", reason: "исходящее прочее" };
  }

  const systemDomains = [
    "yandex.ru",
    "google.com",
    "mail.ru",
    "noreply",
    "no-reply",
    "notify",
    "notification",
  ];
  if (
    systemDomains.some((d) => dom.includes(d) || from.toLowerCase().includes(d)) ||
    /подтвержден|verification|security|безопасност|уведомлен|newsletter|рассылк|unsubscribe|отпис/i.test(blob)
  ) {
    return { folder: "ALO/07_Системные", reason: "системное/уведомление" };
  }

  const partnerDomains = [
    "fesco",
    "pek.ru",
    "dhl.",
    "dpd.",
    "cdek",
    "trcont",
    "rail",
    "transcontainer",
    "maersk",
    "cosco",
    "evergreen",
  ];
  if (partnerDomains.some((p) => dom.includes(p) || blob.includes(p))) {
    return { folder: "ALO/03_Партнёры_перевозчики", reason: "партнёр/перевозчик" };
  }

  if (
    /ставк|quote|rfq|freight|тариф|rate|предложени.*цен|котиров/i.test(blob) &&
    /ответ|re:|fwd:|на ваш запрос|по запросу/i.test(blob)
  ) {
    return { folder: "ALO/02_Поставщики_ставки", reason: "ответ на RFQ / ставка" };
  }

  if (/запрос ставк|запрос выкуп|ref:\s*[0-9a-f-]{36}/i.test(blob)) {
    return { folder: "ALO/02_Поставщики_ставки", reason: "исходящий RFQ (копия/ответ)" };
  }

  if (/выкуп|подбор|sourcing|1688|alibaba|taobao|поставщик.*кит|закуп/i.test(blob)) {
    return { folder: "ALO/05_Выкуп_Китай", reason: "выкуп/закупка Китай" };
  }

  if (/таможн|customs|декларац|инвойс|invoice|packing|спецификац|гтд|втт|дт/i.test(blob)) {
    return { folder: "ALO/04_Таможня_документы", reason: "таможня/документы" };
  }

  if (
    /zhdtransinvest|transinvest|@alo|автолог|логист|перевоз|доставк|груз|маршрут|расч[её]т|заявк/i.test(blob) &&
    !/запрос ставк/i.test(lowSub)
  ) {
    return { folder: "ALO/01_Клиенты_запросы", reason: "клиентский запрос/логистика" };
  }

  if (/zhdtransinvest|transinvest/i.test(dom)) {
    return { folder: "ALO/06_Внутреннее", reason: "внутренняя переписка" };
  }

  if (/\bre:\b|\bответ:\b|\bfwd:\b/i.test(subject)) {
    return { folder: "ALO/08_Архив", reason: "цепочка переписки" };
  }

  return { folder: "ALO/08_Архив", reason: "прочее" };
}

async function connect(): Promise<ImapFlow> {
  const user = process.env.MAIL_USER || "";
  const pass = process.env.MAIL_APP_PASSWORD || "";
  const host = process.env.YANDEX_IMAP_HOST || "imap.yandex.ru";
  const port = Number(process.env.YANDEX_IMAP_PORT || 993);
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
  await client.connect();
  return client;
}

async function ensureFolders(client: ImapFlow): Promise<void> {
  for (const path of FOLDERS) {
    try {
      if (!DRY_RUN) await client.mailboxCreate(path);
      console.log(`[folder] ${DRY_RUN ? "would create" : "created"} ${path}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/exists|already|EXISTS/i.test(msg)) {
        console.log(`[folder] exists ${path}`);
      } else {
        console.warn(`[folder] ${path}: ${msg}`);
      }
    }
  }
}

function analyzeExperience(rows: MailRow[]): string {
  const byFolder = new Map<string, MailRow[]>();
  for (const r of rows) {
    const list = byFolder.get(r.folder) || [];
    list.push(r);
    byFolder.set(r.folder, list);
  }

  const domains = new Map<string, number>();
  for (const r of rows) {
    if (r.fromDomain) domains.set(r.fromDomain, (domains.get(r.fromDomain) || 0) + 1);
  }
  const topDomains = [...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

  const subjects = rows
    .filter((r) => r.folder !== "ALO/07_Системные")
    .slice(0, 30)
    .map((r) => `- [${r.folder.split("/")[1]}] ${r.date.slice(0, 10)} | ${r.from.slice(0, 40)} | ${r.subject.slice(0, 80)}`);

  const lines = [
    "# Анализ почты zhdtransinvest@yandex.ru",
    "",
    `Дата: ${new Date().toISOString().slice(0, 10)}`,
    `Обработано писем: ${rows.length}`,
    DRY_RUN ? "*(режим dry-run — перемещение не выполнялось)*" : "",
    "",
    "## Структура папок",
    "",
    ...FOLDERS.map((f) => {
      const n = byFolder.get(f)?.length || 0;
      return `- **${f}** — ${n} пис.`;
    }),
    "",
    "## Опыт работы (по переписке)",
    "",
    "### Клиенты и запросы",
    `Писем: ${byFolder.get("ALO/01_Клиенты_запросы")?.length || 0}. Типичные темы: запросы на перевозку, расчёт маршрута, уточнение условий доставки.`,
    "",
    "### Поставщики и ставки",
    `Писем: ${byFolder.get("ALO/02_Поставщики_ставки")?.length || 0}. RFQ перевозчикам, ответы со ставками, сроками, local charges.`,
    "",
    "### Партнёры-перевозчики",
    `Писем: ${byFolder.get("ALO/03_Партнёры_перевозчики")?.length || 0}. FESCO, контейнерные линии, ЖД-операторы, экспедиторы.`,
    "",
    "### Таможня и документы",
    `Писем: ${byFolder.get("ALO/04_Таможня_документы")?.length || 0}. Инвойсы, спецификации, таможенное оформление.`,
    "",
    "### Выкуп / Китай",
    `Писем: ${byFolder.get("ALO/05_Выкуп_Китай")?.length || 0}. Закупка, подбор поставщика, sourcing.`,
    "",
    "### Топ доменов отправителей",
    "",
    ...topDomains.map(([d, n]) => `- ${d}: ${n}`),
    "",
    "## Примеры писем (не системные)",
    "",
    ...subjects,
    "",
    "## Рекомендации",
    "",
    "- Входящие RFQ-ответы автоматически попадают в **02_Поставщики_ставки** — сверяйте с карточками сделок по Ref в теме.",
    "- Клиентские цепочки — в **01_Клиенты_запросы**; при новой заявке создавайте отдельную сделку в кабинете.",
    "- Системные письма Yandex/Google — в **07_Системные**, не смешивать с рабочими.",
    "",
  ];
  return lines.filter(Boolean).join("\n");
}

async function main() {
  const client = await connect();
  console.log("[imap] connected", process.env.MAIL_USER);

  await ensureFolders(client);

  const lock = await client.getMailboxLock(MAILBOX);
  const rows: MailRow[] = [];
  const moves: Array<{ uid: number; folder: Folder }> = [];

  try {
    const status = await client.status(MAILBOX, { messages: true });
    const total = status.messages || 0;
    console.log(`[${MAILBOX}] total messages: ${total}`);

    const uids = await client.search({ all: true }, { uid: true });
    let list = Array.isArray(uids) ? uids : [];
    if (LIMIT > 0) list = list.slice(-LIMIT);

    const fetchChunk = 50;
    for (let i = 0; i < list.length; i += fetchChunk) {
      const slice = list.slice(i, i + fetchChunk);
      for await (const msg of client.fetch(
        slice,
        { envelope: true, uid: true },
        { uid: true }
      )) {
        const env = msg.envelope;
        const fromAddr = env?.from?.[0];
        const from = fromAddr?.address
          ? fromAddr.name
            ? `${fromAddr.name} <${fromAddr.address}>`
            : fromAddr.address
          : "";
        const subject = env?.subject || "";
        const date = env?.date?.toISOString() || "";
        const { folder, reason } = classify(from, subject, "", MAILBOX);
        rows.push({
          uid: msg.uid,
          from,
          fromDomain: domainFrom(from),
          subject,
          date,
          textPreview: "",
          folder,
          reason,
        });
        moves.push({ uid: msg.uid, folder });
      }
      if (rows.length % 200 === 0 || i + fetchChunk >= list.length) {
        console.log(`[scan] ${rows.length}/${list.length}`);
      }
    }

    if (!DRY_RUN) {
      const byTarget = new Map<Folder, number[]>();
      for (const { uid, folder } of moves) {
        const arr = byTarget.get(folder) || [];
        arr.push(uid);
        byTarget.set(folder, arr);
      }
      for (const [folder, uidList] of byTarget) {
        const chunk = 40;
        for (let i = 0; i < uidList.length; i += chunk) {
          const slice = uidList.slice(i, i + chunk);
          try {
            await client.messageMove(slice, folder, { uid: true });
          } catch (e) {
            for (const uid of slice) {
              try {
                await client.messageMove(uid, folder, { uid: true });
              } catch (err) {
                console.warn(`[move] uid=${uid}:`, err instanceof Error ? err.message : err);
              }
            }
          }
        }
        console.log(`[move] ${folder}: ${uidList.length}`);
      }
      console.log(`[move] done: ${moves.length} messages`);
    } else {
      console.log(`[dry-run] would move ${moves.length} messages`);
    }
  } finally {
    lock.release();
  }

  await client.logout();

  const report = analyzeExperience(rows);
  const outDir = resolve(ROOT, "logs/mail");
  mkdirSync(outDir, { recursive: true });
  const reportPath = resolve(outDir, `organize-${new Date().toISOString().slice(0, 10)}.md`);
  writeFileSync(reportPath, report, "utf8");
  console.log(`[report] ${reportPath}`);
  console.log(report.slice(0, 2500));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
