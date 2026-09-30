import { config } from "dotenv";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(ROOT, ".env") });
const { ImapFlow } = createRequire(
  resolve(ROOT, "apps/workers-ts/package.json")
)("imapflow");

async function main() {
  const pass = "ncpyfvlujfzztslr";
  const client = new ImapFlow({
    host: "imap.yandex.ru",
    port: 993,
    secure: true,
    auth: { user: "a1@zhdtransinvest.ru", pass },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const st = await client.status("INBOX", { messages: true });
    const folders = await client.list();
    console.log("OK a1 INBOX=", st.messages, "folders=", folders.length);
  } finally {
    lock.release();
  }
  await client.logout();
}

main().catch((e) => {
  console.error("FAIL", e instanceof Error ? e.message : e);
  process.exit(1);
});
