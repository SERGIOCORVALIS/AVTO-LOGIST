/**
 * Mine outgoing manager style from archive / mail_messages → clean few-shot prompts.
 * Usage:
 *   pnpm --filter @alo/workers-ts exec tsx ../../scripts/mail-archive-style.ts [--limit N]
 *
 * Writes at most 8 short outbound examples (no quoted threads, signatures, newsletters).
 */
import { config } from "dotenv";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(ROOT, ".env") });

const workersRequire = createRequire(
  resolve(ROOT, "apps/workers-ts/package.json")
);
const apiRequire = createRequire(resolve(ROOT, "apps/api/package.json"));
const { simpleParser } = workersRequire("mailparser") as typeof import("mailparser");
const { Pool } = apiRequire("pg") as typeof import("pg");

const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i >= 0 ? Number(process.argv[i + 1] || 8) : 8;
})();

const ARCHIVE_DIR = resolve(
  ROOT,
  process.env.ARCHIVE_MAIL_DIR || "data/mail-archive"
);
const OWN_DOMAINS = new Set(
  (process.env.ARCHIVE_OWN_DOMAINS || "zhdtransinvest.ru,transinvest.ru")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

function isOwn(email: string): boolean {
  const d = (email.split("@")[1] || "").toLowerCase();
  return OWN_DOMAINS.has(d) || [...OWN_DOMAINS].some((o) => d.endsWith(`.${o}`));
}

function walkEml(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (name.endsWith(".eml")) out.push(p);
    }
  }
  return out;
}

function isSentPath(p: string): boolean {
  return /sent|отправ|исходящ/i.test(p);
}

/** Strip quotes, signatures, HTML noise — keep short outbound voice. */
export function cleanOutboundBody(raw: string): string {
  let t = String(raw || "")
    .replace(/\r/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\[[^\]]*\]/g, " ");

  // Drop quoted history / reply chains
  const cutMarkers =
    /\n\s*(-{2,}|_{2,})\s*\n|\nFrom:\s|\nОт:|\nКому:|\nТема:|\nOn .+ wrote:|\n\d{1,2}[./]\d{1,2}[./]\d{2,4}.+wrote:|\n>/i;
  const cut = t.search(cutMarkers);
  if (cut > 40) t = t.slice(0, cut);

  // Drop signature blocks
  t = t.replace(
    /\n--\s*\n[\s\S]*$/i,
    ""
  );
  t = t.replace(
    /\n(С уважением|Best regards|С уважени|Руководитель|менеджер по|Logistics Department)[\s\S]*$/i,
    ""
  );
  t = t.replace(/\+7[\d\s()-]{8,}/g, "");
  t = t.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function looksLikeNoise(subject: string, body: string): boolean {
  const blob = `${subject} ${body}`.toLowerCase();
  if (body.length < 40 || body.length > 900) return true;
  if (/отписаться|unsubscribe|newsletter|рассылк|динамично развивающ/i.test(blob)) {
    return true;
  }
  if (/^re:\s*$/i.test(subject.trim())) return true;
  // Mostly punctuation / leftover quote
  if ((body.match(/[а-яёa-z]/gi) || []).length < 25) return true;
  return false;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function scoreClient(body: string): number {
  let s = 0;
  if (/добрый|здравствуй|доброе/i.test(body)) s += 1;
  if (/расч[её]т|маршрут|груз|достав|ставк|срок/i.test(body)) s += 2;
  if (/\?/.test(body)) s += 1;
  if (/вес|объ[её]м|готов|инвойс|когда/i.test(body)) s += 1;
  return s;
}

function scoreSupplier(body: string): number {
  let s = 0;
  if (/ставк|запрос|прошу рассчитать|ref:/i.test(body)) s += 2;
  if (/маршрут|город|вес|контейнер|вагон|готов/i.test(body)) s += 2;
  if (/без\s*ндс|с\s*ндс|руб/i.test(body)) s += 1;
  return s;
}

async function main() {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      "postgresql://alo:alo@localhost:5432/autologistics",
  });

  type Sample = { role: "client" | "supplier"; subject: string; body: string; score: number };
  const samples: Sample[] = [];

  try {
    const r = await pool.query(
      `
      SELECT subject, body_text, role, direction
      FROM mail_messages
      WHERE direction = 'outbound'
        AND body_text IS NOT NULL
        AND length(body_text) > 60
      ORDER BY sent_at DESC NULLS LAST
      LIMIT $1
      `,
      [Math.max(LIMIT * 8, 80)]
    );
    for (const row of r.rows) {
      const subject = String(row.subject || "");
      const body = cleanOutboundBody(String(row.body_text || ""));
      if (looksLikeNoise(subject, body)) continue;
      const blob = `${subject} ${body}`.toLowerCase();
      const role: "client" | "supplier" =
        row.role === "supplier" || /запрос ставк|ref:\s*[0-9a-f-]{8,}/i.test(blob)
          ? "supplier"
          : "client";
      samples.push({
        role,
        subject: clip(subject, 80),
        body: clip(body, 420),
        score: role === "supplier" ? scoreSupplier(body) : scoreClient(body),
      });
    }
  } catch (e) {
    console.warn(
      "[style] DB mail_messages unavailable, falling back to EML:",
      e instanceof Error ? e.message : e
    );
  }

  if (samples.length < 5) {
    const files = walkEml(ARCHIVE_DIR).filter(isSentPath);
    for (const emlPath of files.slice(0, LIMIT * 12)) {
      try {
        const parsed = await simpleParser(readFileSync(emlPath));
        const from = (parsed.from?.value?.[0]?.address || "").toLowerCase();
        if (from && !isOwn(from)) continue;
        const subject = parsed.subject || "";
        const body = cleanOutboundBody(String(parsed.text || ""));
        if (looksLikeNoise(subject, body)) continue;
        const blob = `${subject} ${body}`.toLowerCase();
        const role: "client" | "supplier" = /запрос ставк|ref:\s*[0-9a-f-]{8,}|rfq/i.test(
          blob
        )
          ? "supplier"
          : "client";
        samples.push({
          role,
          subject: clip(subject, 80),
          body: clip(body, 420),
          score: role === "supplier" ? scoreSupplier(body) : scoreClient(body),
        });
      } catch {
        /* skip */
      }
    }
  }

  const pick = (role: "client" | "supplier") =>
    samples
      .filter((s) => s.role === role && s.score >= 2)
      .sort((a, b) => b.score - a.score)
      .filter((s, i, arr) => {
        const key = s.body.slice(0, 80);
        return arr.findIndex((x) => x.body.slice(0, 80) === key) === i;
      })
      .slice(0, Math.min(LIMIT, 8));

  const clientSamples = pick("client");
  const supplierSamples = pick("supplier");

  const clientPrompt = [
    "# Стиль общения с клиентом (из архива переписки)",
    "",
    "Пиши как живой экспедитор ЖД Трансинвест: коротко, по делу, без канцелярита.",
    "Структура: приветствие/подтверждение → суть (маршрут/груз/срок) → один уточняющий вопрос или следующий шаг.",
    "Не раскрывай внутренние ставки поставщиков, маржу и себестоимость; клиенту — итоговая логика и КП.",
    "",
    "## Примеры тона (few-shot, не копируй дословно)",
    "",
    ...clientSamples.map(
      (s, i) => `### Пример ${i + 1}\nТема: ${s.subject}\n${s.body}\n`
    ),
    clientSamples.length
      ? ""
      : "_Мало чистых исходящих — дополните вручную или после ingest перезапустите скрипт._\n",
  ].join("\n");

  const supplierPrompt = [
    "# Стиль RFQ к поставщикам (из архива переписки)",
    "",
    "Запрос ставки: маршрут, груз, вес/объём/места, готовность, нужные услуги.",
    "Без данных клиента (ИНН, телефон, точный завод без необходимости). Одна тема — один запрос. Указывай Ref сделки, если есть.",
    "",
    "## Примеры тона",
    "",
    ...supplierSamples.map(
      (s, i) => `### Пример ${i + 1}\nТема: ${s.subject}\n${s.body}\n`
    ),
    supplierSamples.length
      ? ""
      : "_Мало чистых исходящих RFQ — дополните вручную или после ingest перезапустите скрипт._\n",
  ].join("\n");

  const promptsDir = resolve(ROOT, "packages/prompts/gpt");
  mkdirSync(promptsDir, { recursive: true });
  writeFileSync(join(promptsDir, "style_client.md"), clientPrompt, "utf8");
  writeFileSync(join(promptsDir, "style_supplier.md"), supplierPrompt, "utf8");
  console.log(
    `[style] wrote style_client.md (${clientSamples.length}) style_supplier.md (${supplierSamples.length})`
  );

  const version = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  try {
    await pool.query(
      `
      INSERT INTO playbook_versions (name, version, body, status, canary_pct, metrics)
      VALUES (
        'comm_style_from_mail',
        $1,
        $2::jsonb,
        'draft',
        10,
        $3::jsonb
      )
      ON CONFLICT (name, version) DO UPDATE SET
        body = EXCLUDED.body,
        metrics = EXCLUDED.metrics
      `,
      [
        version,
        JSON.stringify({
          tone: "commercial",
          client_examples: clientSamples,
          supplier_examples: supplierSamples,
          prompts: {
            client: "packages/prompts/gpt/style_client.md",
            supplier: "packages/prompts/gpt/style_supplier.md",
          },
        }),
        JSON.stringify({
          client_n: clientSamples.length,
          supplier_n: supplierSamples.length,
        }),
      ]
    );
    console.log(`[style] playbook_versions comm_style_from_mail@${version}`);
  } catch (e) {
    console.warn(
      "[style] playbook_versions insert skipped:",
      e instanceof Error ? e.message : e
    );
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
