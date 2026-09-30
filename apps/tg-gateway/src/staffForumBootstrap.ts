/**
 * One-shot: enable forum, create fixed topics, ingest history, write topic ids to .env
 * Usage: pnpm --filter @alo/tg-gateway exec tsx src/staffForumBootstrap.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { Bot } from "grammy";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { loadRootEnv, grammyProxyFetch, gramJsProxy } from "@alo/shared";
import {
  applyTopicIdsToEnvText,
  ensureStaffTopics,
  getStaffTopicMap,
} from "./staffTopics";
import { runStaffHistoryIngest } from "./staffHistoryIngest";
import { escalationChatId } from "./staffListen";

async function main() {
  loadRootEnv();
  const chatId = escalationChatId();
  const apiId = Number(String(process.env.TG_API_ID || "0").split("#")[0].trim());
  const apiHash = (process.env.TG_API_HASH || "").split("#")[0].trim();
  const session = (process.env.TG_STRING_SESSION || "").trim();
  const token = (process.env.TG_BOT_TOKEN || "").trim();
  const apiBase = process.env.API_URL || "http://localhost:3000";

  if (!chatId) {
    console.error("TG_STAFF_CHAT_ID / TG_ESCALATION_CHAT_ID unset");
    process.exit(1);
  }
  if (!apiId || !apiHash || !session) {
    console.error("Need TG_API_ID, TG_API_HASH, TG_STRING_SESSION");
    process.exit(1);
  }

  const fetchFn = grammyProxyFetch();
  const bot = token
    ? new Bot(token, fetchFn ? { client: { fetch: fetchFn } } : {})
    : null;
  if (bot) {
    await bot.init();
    console.log("[bootstrap] bot", bot.botInfo?.username);
  }

  const proxy = gramJsProxy();
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
    ...(proxy ? { proxy } : {}),
  });
  await client.connect();
  const me = await client.getMe();
  console.log("[bootstrap] user", {
    id: Number(me.id),
    username: me.username,
    chatId,
  });

  const map = await ensureStaffTopics({ bot, client });
  console.log("[bootstrap] topics", Object.fromEntries(map.entries()));

  // Persist ids into root .env
  const envPath = join(process.cwd(), "../../.env");
  const altEnv = join(process.cwd(), ".env");
  const rootEnv = (() => {
    try {
      return readFileSync(envPath, "utf8");
    } catch {
      try {
        return readFileSync(altEnv, "utf8");
      } catch {
        return null;
      }
    }
  })();
  const writePath = (() => {
    try {
      readFileSync(envPath);
      return envPath;
    } catch {
      return altEnv;
    }
  })();
  if (rootEnv != null && map.size) {
    const next = applyTopicIdsToEnvText(rootEnv, map);
    if (next !== rootEnv) {
      writeFileSync(writePath, next, "utf8");
      console.log("[bootstrap] wrote topic ids to", writePath);
    } else {
      console.log("[bootstrap] .env topic ids already up to date");
    }
  }

  // Also set process env for ingest routing
  for (const [kind, id] of map) {
    const key =
      kind === "general"
        ? "TG_STAFF_TOPIC_GENERAL"
        : kind === "escalations"
          ? "TG_STAFF_TOPIC_ESCALATIONS"
          : kind === "rfq"
            ? "TG_STAFF_TOPIC_RFQ"
            : "TG_STAFF_TOPIC_COACHING";
    process.env[key] = String(id);
  }

  const stats = await runStaffHistoryIngest({
    client,
    apiBase,
    force: true,
    bot,
  });
  console.log("[bootstrap] history ingest", stats);
  console.log("[bootstrap] topic map", Object.fromEntries(getStaffTopicMap()));

  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("[bootstrap] failed", err);
  process.exit(1);
});
