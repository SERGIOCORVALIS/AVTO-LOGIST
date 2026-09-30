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
  const client = new ImapFlow({
    host: "imap.yandex.ru",
    port: 993,
    secure: true,
    auth: {
      user: "info@zhdtransinvest.ru",
      pass: "iiftutlqfmbnimyv",
    },
    logger: false,
  });
  await client.connect();
  const folders = await client.list();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const st = await client.status("INBOX", { messages: true });
    console.log("OK info INBOX=", st.messages, "folders=", folders.length);
    for (const f of folders) {
      if (/счет|счёт|договор|invoice|contract|клиент|заявк/i.test(f.path)) {
        console.log("FOLDER", f.path);
      }
    }
  } finally {
    lock.release();
  }
  await client.logout();
}

main().catch((e) => {
  console.error("FAIL", e instanceof Error ? e.message : e);
  process.exit(1);
});
