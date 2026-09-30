import { config } from "dotenv";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(ROOT, ".env") });

const workersRequire = createRequire(
  resolve(ROOT, "apps/workers-ts/package.json")
);
const { ImapFlow } = workersRequire("imapflow");

async function main() {
  const boxes = JSON.parse(process.env.ARCHIVE_MAILBOXES_JSON || "[]");
  for (const box of boxes) {
    const client = new ImapFlow({
      host: box.host || "imap.yandex.ru",
      port: Number(box.port || 993),
      secure: true,
      auth: { user: box.user, pass: box.password },
      logger: false,
    });
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        const st = await client.status("INBOX", { messages: true });
        const folders = await client.list();
        console.log(
          "OK",
          box.id,
          box.user,
          "INBOX=",
          st.messages,
          "folders=",
          folders.length
        );
      } finally {
        lock.release();
      }
      await client.logout();
    } catch (e) {
      console.log(
        "FAIL",
        box.id,
        box.user,
        e instanceof Error ? e.message : String(e)
      );
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
