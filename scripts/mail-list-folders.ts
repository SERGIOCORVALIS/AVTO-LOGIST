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
  const user = process.env.MAIL_USER || "zhdtransinvest@yandex.ru";
  const pass =
    process.env.MAIL_APP_PASSWORD ||
    process.env.MAIL_PASSWORD ||
    "";
  const host = process.env.YANDEX_IMAP_HOST || "imap.yandex.ru";
  const client = new ImapFlow({
    host,
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
  await client.connect();
  console.log("connected", user);
  const folders = await client.list();
  for (const f of folders) {
    const name = f.path;
    if (/m5|m13|a1|m1|клиент|client|архив|inbox|sent|отправ/i.test(name)) {
      console.log("FOLDER", name, "flags=", [...(f.flags || [])].join(","));
    }
  }
  console.log("--- all folders (", folders.length, ") ---");
  for (const f of folders) {
    console.log(f.path);
  }
  await client.logout();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
