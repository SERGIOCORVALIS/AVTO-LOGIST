/**
 * Dump all folders from ARCHIVE_MAILBOXES_JSON into local EML archive.
 * Usage:
 *   pnpm --filter @alo/workers-ts exec tsx ../../scripts/mail-archive-dump.ts [--limit N] [--mailbox m5]
 */
import { config } from "dotenv";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(ROOT, ".env") });

const workersRequire = createRequire(
  resolve(ROOT, "apps/workers-ts/package.json")
);
const { ImapFlow } = workersRequire("imapflow") as typeof import("imapflow");

type MailboxCfg = {
  id: string;
  user: string;
  password: string;
  host?: string;
  port?: number;
};

const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i >= 0 ? Number(process.argv[i + 1] || 0) : 0;
})();
const ONLY_BOX = (() => {
  const i = process.argv.indexOf("--mailbox");
  return i >= 0 ? String(process.argv[i + 1] || "").trim() : "";
})();

const ARCHIVE_DIR = resolve(
  ROOT,
  process.env.ARCHIVE_MAIL_DIR || "data/mail-archive"
);

function parseMailboxes(): MailboxCfg[] {
  const raw = (process.env.ARCHIVE_MAILBOXES_JSON || "").trim();
  if (!raw) {
    throw new Error(
      "ARCHIVE_MAILBOXES_JSON is empty — add mailboxes in .env (see .env.example)"
    );
  }
  const parsed = JSON.parse(raw) as MailboxCfg[];
  if (!Array.isArray(parsed) || !parsed.length) {
    throw new Error("ARCHIVE_MAILBOXES_JSON must be a non-empty JSON array");
  }
  const ready = parsed.filter((m) => m.user && m.password && m.id);
  const skipped = parsed.filter((m) => m.id && (!m.password || !m.user));
  for (const s of skipped) {
    console.log(
      `[dump] skip mailbox ${s.id} — empty password (add app-password later)`
    );
  }
  return ready;
}

function safeFolder(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 120) || "INBOX";
}

function messageIdHash(messageId: string | null | undefined, fallback: string): string {
  const key = (messageId || fallback).trim().toLowerCase();
  return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

function formatAddr(
  list: Array<{ name?: string; address?: string }> | undefined
): string {
  if (!list?.length) return "";
  const a = list[0];
  if (!a?.address) return "";
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

function addrList(
  list: Array<{ address?: string }> | undefined
): string[] {
  if (!list?.length) return [];
  return list
    .map((a) => (a.address || "").trim().toLowerCase())
    .filter(Boolean);
}

async function createClient(cfg: MailboxCfg, host: string, port: number) {
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user: cfg.user, pass: cfg.password },
    logger: false,
    socketTimeout: 120_000,
    greetingTimeout: 60_000,
    emitLogs: false,
  });
  // Prevent unhandled 'error' crash on ECONNRESET
  client.on("error", (err) => {
    console.warn(`[imap] socket error ${cfg.id}:`, err.message || err);
  });
  await client.connect();
  return client;
}

async function dumpMailbox(cfg: MailboxCfg): Promise<{
  id: string;
  folders: number;
  saved: number;
  skipped: number;
  errors: number;
}> {
  const host =
    cfg.host ||
    process.env.YANDEX_IMAP_HOST ||
    process.env.IMAP_HOST ||
    "imap.yandex.ru";
  const port = Number(
    cfg.port || process.env.YANDEX_IMAP_PORT || process.env.IMAP_PORT || 993
  );

  let client = await createClient(cfg, host, port);
  console.log(`[imap] connected ${cfg.id} <${cfg.user}> @ ${host}:${port}`);

  const boxRoot = join(ARCHIVE_DIR, cfg.id);
  mkdirSync(boxRoot, { recursive: true });

  let saved = 0;
  let skipped = 0;
  let errors = 0;

  async function reconnect(): Promise<void> {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 2000));
    client = await createClient(cfg, host, port);
    console.log(`[imap] reconnected ${cfg.id}`);
  }

  const folders = await client.list();
  const selectable = folders.filter((f) => !f.flags?.has("\\Noselect"));

  for (const folder of selectable) {
    const folderPath = folder.path;
    const folderSafe = safeFolder(folderPath);
    const outDir = join(boxRoot, folderSafe);
    mkdirSync(outDir, { recursive: true });

    let folderRetries = 0;
    while (folderRetries < 4) {
      let lock;
      try {
        if (!client.usable) await reconnect();
        lock = await client.getMailboxLock(folderPath);
      } catch (e) {
        folderRetries += 1;
        console.warn(
          `[skip/retry folder] ${cfg.id}/${folderPath} try=${folderRetries}:`,
          e instanceof Error ? e.message : e
        );
        await reconnect();
        continue;
      }

      try {
        const status = await client.status(folderPath, { messages: true });
        const total = status.messages || 0;
        console.log(`[${cfg.id}] ${folderPath}: ${total} messages`);
        if (!total) break;

        let uids = (await client.search({ all: true }, { uid: true })) as number[];
        if (!Array.isArray(uids)) uids = [];
        if (LIMIT > 0) uids = uids.slice(-LIMIT);

        // Small chunks — Yandex often resets on large INBOX fetches
        const chunk = 5;
        for (let i = 0; i < uids.length; i += chunk) {
          const slice = uids.slice(i, i + chunk);
          let chunkOk = false;
          for (let attempt = 0; attempt < 3 && !chunkOk; attempt++) {
            try {
              if (!client.usable) await reconnect();
              // re-acquire lock after reconnect
              if (!lock || !client.usable) {
                try {
                  lock?.release();
                } catch {
                  /* ignore */
                }
                lock = await client.getMailboxLock(folderPath);
              }
              for await (const msg of client.fetch(
                slice,
                { uid: true, envelope: true, source: true },
                { uid: true }
              )) {
                try {
                  const env = msg.envelope;
                  const messageId = env?.messageId || null;
                  const fallbackKey = `${cfg.id}|${folderPath}|${msg.uid}`;
                  const hash = messageIdHash(messageId, fallbackKey);
                  const emlPath = join(outDir, `${hash}.eml`);
                  const metaPath = join(outDir, `${hash}.json`);

                  if (existsSync(emlPath) && existsSync(metaPath)) {
                    skipped += 1;
                    continue;
                  }

                  const source = msg.source;
                  if (!source || !source.length) {
                    errors += 1;
                    continue;
                  }
                  writeFileSync(emlPath, source);

                  const meta = {
                    mailbox_id: cfg.id,
                    mailbox_user: cfg.user,
                    folder: folderPath,
                    uid: msg.uid,
                    message_id: messageId,
                    in_reply_to: env?.inReplyTo || null,
                    subject: env?.subject || "",
                    date: env?.date ? env.date.toISOString() : null,
                    from: formatAddr(env?.from),
                    from_email: env?.from?.[0]?.address?.toLowerCase() || null,
                    to: addrList(env?.to),
                    cc: addrList(env?.cc),
                    raw_path: emlPath
                      .replace(ROOT + "\\", "")
                      .replace(ROOT + "/", ""),
                    dumped_at: new Date().toISOString(),
                  };
                  writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
                  saved += 1;
                } catch (err) {
                  errors += 1;
                  console.warn(
                    `[save] ${cfg.id} uid=${msg.uid}:`,
                    err instanceof Error ? err.message : err
                  );
                }
              }
              chunkOk = true;
            } catch (e) {
              console.warn(
                `[chunk retry] ${cfg.id}/${folderSafe} @${i} attempt=${attempt + 1}:`,
                e instanceof Error ? e.message : e
              );
              await reconnect();
              try {
                lock?.release();
              } catch {
                /* ignore */
              }
              lock = await client.getMailboxLock(folderPath);
            }
          }
          if (!chunkOk) errors += slice.length;

          if ((i + chunk) % 50 === 0 || i + chunk >= uids.length) {
            console.log(
              `[${cfg.id}/${folderSafe}] progress ${Math.min(i + chunk, uids.length)}/${uids.length} saved=${saved} skip=${skipped}`
            );
          }
        }
        break; // folder done
      } finally {
        try {
          lock?.release();
        } catch {
          /* ignore */
        }
      }
    }
  }

  try {
    await client.logout();
  } catch {
    /* ignore */
  }
  return {
    id: cfg.id,
    folders: selectable.length,
    saved,
    skipped,
    errors,
  };
}

async function main() {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  let boxes = parseMailboxes();
  if (ONLY_BOX) {
    boxes = boxes.filter((b) => b.id === ONLY_BOX || b.user === ONLY_BOX);
    if (!boxes.length) throw new Error(`mailbox not found: ${ONLY_BOX}`);
  }

  const results = [];
  for (const box of boxes) {
    try {
      results.push(await dumpMailbox(box));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[imap] FAILED ${box.id} <${box.user}>:`, msg);
      results.push({
        id: box.id,
        folders: 0,
        saved: 0,
        skipped: 0,
        errors: 1,
        failed: msg,
      });
    }
  }

  const day = new Date().toISOString().slice(0, 10);
  const reportDir = resolve(ROOT, "logs/mail");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `archive-dump-${day}.md`);
  const lines = [
    "# Mail archive dump",
    "",
    `Date: ${day}`,
    `ARCHIVE_MAIL_DIR: ${ARCHIVE_DIR}`,
    "",
    ...results.map(
      (r) =>
        `- **${r.id}**: folders=${r.folders}, saved=${r.saved}, skipped=${r.skipped}, errors=${r.errors}`
    ),
    "",
    "Close paid mailboxes only after verifying counts match IMAP totals.",
    "",
  ];
  writeFileSync(reportPath, lines.join("\n"), "utf8");
  console.log(`[report] ${reportPath}`);
  console.log(JSON.stringify(results, null, 2));

  const manifestPath = join(ARCHIVE_DIR, "manifest.json");
  const prev = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : {};
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        ...prev,
        updated_at: new Date().toISOString(),
        last_dump: results,
      },
      null,
      2
    ),
    "utf8"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
