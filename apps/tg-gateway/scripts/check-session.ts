import { config } from "dotenv";
import { resolve } from "path";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { gramJsProxy, loadMtProtoProxy, loadAppProxy } from "@alo/shared";

config({ path: resolve(__dirname, "../../../.env") });

const apiId = Number(process.env.TG_API_ID);
const apiHash = String(process.env.TG_API_HASH || "");
const sessionStr = String(process.env.TG_STRING_SESSION || "").trim();

console.log("PROXY_ENABLED=", process.env.PROXY_ENABLED);
console.log("appProxy=", loadAppProxy());
console.log("mtproto=", loadMtProtoProxy());
console.log("gramJs=", gramJsProxy());
console.log("sessionLen=", sessionStr.length);

if (!sessionStr) {
  console.error("No TG_STRING_SESSION");
  process.exit(2);
}

const proxy = gramJsProxy();
const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
  connectionRetries: 3,
  reconnectRetries: 0,
  autoReconnect: false,
  timeout: 20,
  useWSS: false,
  ...(proxy ? { proxy } : {}),
});

void (async () => {
  try {
    await client.connect();
    const ok = await client.checkAuthorization();
    if (!ok) {
      console.log("SESSION_INVALID: not authorized");
      process.exit(1);
    }
    const me = await client.getMe();
    console.log(
      "SESSION_OK",
      "id=",
      me && "id" in me ? String(me.id) : "?",
      "username=",
      me && "username" in me ? me.username : "?"
    );
    await client.disconnect();
    process.exit(0);
  } catch (e) {
    console.error("CONNECT_FAIL", e instanceof Error ? e.message : e);
    try {
      await client.disconnect();
    } catch {
      /* */
    }
    process.exit(1);
  }
})();

