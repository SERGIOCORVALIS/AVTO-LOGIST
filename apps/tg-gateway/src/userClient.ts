import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import { Api } from "telegram";
import { gramJsProxy, loadAppProxy, type GramJsProxy } from "@alo/shared";
import { gramJsFakeTlsParams, patchGramJsFakeTlsConnection } from "./mtprotoFakeTls";
import { downloadInboundMedia, type InboundMedia } from "./media";
import { processTelegramMessage } from "./unreadCatchUp";
import { attachStaffGroupUserListen } from "./staffListen";
import { getManagementBot, setStaffUserClient } from "./managementBot";
import { ensureStaffTopics } from "./staffTopics";
import { runStaffHistoryIngest } from "./staffHistoryIngest";

export interface InboundMsg {
  chatId: number;
  userId?: number;
  messageId?: number;
  text: string;
  clientName?: string;
  media?: InboundMedia;
}

export interface IncomingTgCall {
  userId: number;
  video: boolean;
}

export interface UserClientHandle {
  client: TelegramClient;
  send: (chatId: number, text: string) => Promise<void>;
}

function socksFallbackProxy(): GramJsProxy | undefined {
  const proxyFlag = (process.env.PROXY_ENABLED || "").trim().toLowerCase();
  if (proxyFlag && !["1", "true", "yes", "on"].includes(proxyFlag)) {
    return undefined;
  }
  const cfg = loadAppProxy();
  if (cfg) {
    return {
      ip: cfg.host,
      port: cfg.port,
      socksType: 5,
      username: cfg.username || undefined,
      password: cfg.password || undefined,
      timeout: 8,
    };
  }
  const host = (process.env.PROXY_HOST || process.env.PX6_HOST || "").trim();
  const port = Number(process.env.PROXY_PORT || process.env.PX6_PORT || "0");
  if (!host || !Number.isFinite(port) || port <= 0) return undefined;
  return {
    ip: host,
    port,
    socksType: 5,
    username:
      (process.env.PROXY_USERNAME || process.env.PROXY_USER || process.env.PX6_USER || "").trim() ||
      undefined,
    password:
      (process.env.PROXY_PASSWORD || process.env.PROXY_PASS || process.env.PX6_PASS || "").trim() ||
      undefined,
    timeout: 8,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}_${ms}ms`)), ms);
    }),
  ]);
}

async function destroyClient(client: TelegramClient | undefined): Promise<void> {
  if (!client) return;
  try {
    client.disconnect();
  } catch {
    /* ignore */
  }
  try {
    await client.destroy();
  } catch {
    /* ignore */
  }
}

async function connectWithProxy(
  session: StringSession,
  apiId: number,
  apiHash: string,
  proxy: GramJsProxy | undefined
): Promise<TelegramClient> {
  const isMtProto = Boolean(proxy && "MTProxy" in proxy);
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: isMtProto ? 2 : 5,
    reconnectRetries: 50,
    autoReconnect: true,
    retryDelay: 1500,
    timeout: isMtProto ? 10 : 15,
    useWSS: false,
    ...(proxy ? { proxy } : {}),
    ...(isMtProto ? (gramJsFakeTlsParams() as object) : {}),
  });
  if (isMtProto) patchGramJsFakeTlsConnection(client);
  const connectMs = isMtProto ? 15_000 : 25_000;
  const authMs = isMtProto ? 12_000 : 18_000;
  try {
    await withTimeout(client.connect(), connectMs, "tg_connect_timeout");
    const authed = await withTimeout(client.checkAuthorization(), authMs, "tg_auth_timeout");
    if (!authed) {
      throw new Error("TG session not authorized. Run: pnpm --filter @alo/tg-gateway login");
    }
    await withTimeout(client.getMe(), authMs, "tg_getme_timeout");
  } catch (err) {
    await destroyClient(client);
    throw err;
  }
  return client;
}

export async function startUserClient(opts: {
  onInbound: (msg: InboundMsg) => Promise<void>;
  onIncomingCall?: (call: IncomingTgCall) => Promise<void>;
  onDisconnected?: () => void;
}): Promise<UserClientHandle> {
  const apiId = Number(String(process.env.TG_API_ID || "0").split("#")[0].trim());
  const apiHash = (process.env.TG_API_HASH || "").split("#")[0].trim();
  const session = new StringSession((process.env.TG_STRING_SESSION || "").trim());

  const preferred = gramJsProxy();
  const socks = socksFallbackProxy();
  const attempts: Array<GramJsProxy | undefined> = [];
  const pushUnique = (p: GramJsProxy | undefined) => {
    const key =
      !p ? "direct" : "MTProxy" in p ? `mt:${p.ip}:${p.port}` : `socks:${p.ip}:${p.port}`;
    if (
      attempts.some((a) => {
        const k =
          !a ? "direct" : "MTProxy" in a ? `mt:${a.ip}:${a.port}` : `socks:${a.ip}:${a.port}`;
        return k === key;
      })
    ) {
      return;
    }
    attempts.push(p);
  };
  if (preferred && "MTProxy" in preferred) pushUnique(preferred);
  if (socks) pushUnique(socks);
  else if (preferred && !("MTProxy" in preferred)) pushUnique(preferred);
  pushUnique(undefined);

  let client: TelegramClient | undefined;
  let lastErr: unknown;
  for (const proxy of attempts) {
    try {
      const kind =
        proxy && "MTProxy" in proxy ? "mtproto" : proxy ? "socks5" : "direct";
      console.log(`[tg-user] connecting via ${kind}`);
      client = await connectWithProxy(session, apiId, apiHash, proxy);
      console.log(`[tg-user] connected via ${kind}`);
      break;
    } catch (err) {
      lastErr = err;
      console.warn(
        "[tg-user] connect failed",
        proxy && "MTProxy" in proxy ? "mtproto" : proxy ? "socks5" : "direct",
        err instanceof Error ? err.message : err
      );
    }
  }
  if (!client) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));

  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message) return;
      await processTelegramMessage(client!, message, opts.onInbound);
    } catch (err) {
      console.error("[tg-user] inbound handler failed", err);
    }
  }, new NewMessage({}));

  try {
    attachStaffGroupUserListen(client);
    setStaffUserClient(client);
    void (async () => {
      try {
        await ensureStaffTopics({ bot: getManagementBot(), client });
        const apiBase = process.env.API_URL || "http://localhost:3000";
        await runStaffHistoryIngest({
          client,
          apiBase,
          force: false,
          bot: getManagementBot(),
        });
      } catch (err) {
        console.warn("[tg-user] staff forum bootstrap failed", err);
      }
    })();
  } catch (err) {
    console.warn("[tg-user] staff listen attach failed", err);
  }

  client.addEventHandler(async (update) => {
    try {
      if (!(update instanceof Api.UpdatePhoneCall)) return;
      const phoneCall = update.phoneCall;
      if (!(phoneCall instanceof Api.PhoneCallRequested)) return;
      const userId = Number(phoneCall.adminId);
      try {
        const peer = new Api.InputPhoneCall({
          id: phoneCall.id,
          accessHash: phoneCall.accessHash,
        });
        await client!.invoke(new Api.phone.ReceivedCall({ peer }));
        await client!.invoke(
          new Api.phone.DiscardCall({
            peer,
            duration: 0,
            reason: new Api.PhoneCallDiscardReasonHangup(),
            connectionId: 0 as never,
          })
        );
      } catch (err) {
        console.error("[tg-user] discard telegram call failed", err);
      }
      if (opts.onIncomingCall && Number.isFinite(userId) && userId > 0) {
        await opts.onIncomingCall({ userId, video: Boolean(phoneCall.video) });
      }
    } catch (err) {
      console.error("[tg-user] phone-call handler failed", err);
    }
  });

  return {
    client,
    send: async (chatId: number, text: string) => {
      await client!.sendMessage(chatId, { message: text });
    },
  };
}

// Re-export for tests
export { downloadInboundMedia };
