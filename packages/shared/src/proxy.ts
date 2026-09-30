import { ProxyAgent, fetch as undiciFetch } from "undici";

export interface AppProxyConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  type: "socks5" | "http";
}

export type GramJsProxy =
  | {
      ip: string;
      port: number;
      secret: string;
      MTProxy: true;
      /** SNI domain from an `ee` Fake-TLS secret. GramJS ignores this; our transport uses it. */
      fakeTlsDomain?: string;
    }
  | {
      ip: string;
      port: number;
      socksType: 5;
      username?: string;
      password?: string;
      timeout?: number;
    };

export interface ParsedMtProtoSecret {
  /** 16-byte key as hex, or 17-byte `dd`+key hex for padded secrets. */
  keyHex: string;
  domain?: string;
  fakeTls: boolean;
}

function envBool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function envTrim(name: string): string {
  return (process.env[name] || "").trim();
}

/** PROXY6 / px6 HTTPS+SOCKS5 credentials from env. */
export function loadAppProxy(): AppProxyConfig | null {
  const host = envTrim("PROXY_HOST") || envTrim("PX6_HOST");
  const port = Number(envTrim("PROXY_PORT") || envTrim("PX6_PORT") || "0");
  const enabled = envBool("PROXY_ENABLED", Boolean(host && port));
  if (!enabled || !host || !Number.isFinite(port) || port <= 0) return null;
  const typeRaw = (envTrim("PROXY_TYPE") || "socks5").toLowerCase();
  return {
    host,
    port,
    username: envTrim("PROXY_USERNAME") || envTrim("PROXY_USER") || envTrim("PX6_USER"),
    password: envTrim("PROXY_PASSWORD") || envTrim("PROXY_PASS") || envTrim("PX6_PASS"),
    type: typeRaw === "http" || typeRaw === "https" ? "http" : "socks5",
  };
}

function authPrefix(cfg: AppProxyConfig): string {
  if (!cfg.username) return "";
  return `${encodeURIComponent(cfg.username)}:${encodeURIComponent(cfg.password)}@`;
}

/** HTTP CONNECT URL — px6 accepts HTTPS and SOCKS5 on the same host:port. */
export function httpProxyUrl(cfg = loadAppProxy()): string | undefined {
  if (!cfg) return undefined;
  return `http://${authPrefix(cfg)}${cfg.host}:${cfg.port}`;
}

export function socksProxyUrl(cfg = loadAppProxy()): string | undefined {
  if (!cfg) return undefined;
  return `socks5://${authPrefix(cfg)}${cfg.host}:${cfg.port}`;
}

function parseTgProxyUri(uri: string): { host: string; port: number; secret: string } | null {
  const raw = uri.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw.replace(/^tg:/i, "https:"));
    const host = u.searchParams.get("server") || u.hostname;
    const port = Number(u.searchParams.get("port") || u.port || "443");
    const secret = u.searchParams.get("secret") || "";
    if (!host || !secret) return null;
    return { host, port: Number.isFinite(port) && port > 0 ? port : 443, secret };
  } catch {
    return null;
  }
}

function decodeMtProtoSecretBytes(raw: string): Buffer {
  let secret = raw.trim();
  const fromUri = parseTgProxyUri(secret);
  if (fromUri) secret = fromUri.secret;

  if (/^[0-9a-f]+$/i.test(secret) && secret.length >= 32 && secret.length % 2 === 0) {
    return Buffer.from(secret, "hex");
  }

  let buf = Buffer.from(secret, "base64");
  if (buf.length < 16) {
    buf = Buffer.from(secret.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  }
  return buf;
}

/**
 * Decode MTProxy secrets: 16-byte hex, `dd` padded, or `ee` Fake-TLS + domain
 * (hex or base64, including `tg://proxy?secret=`).
 */
export function parseMtProtoSecret(raw: string): ParsedMtProtoSecret {
  const buf = decodeMtProtoSecretBytes(raw);
  if (buf.length >= 18 && buf[0] === 0xee) {
    return {
      keyHex: buf.subarray(1, 17).toString("hex"),
      domain: buf.subarray(17).toString("utf8").replace(/\0/g, "").trim(),
      fakeTls: true,
    };
  }
  if (buf.length >= 17 && buf[0] === 0xdd) {
    return { keyHex: buf.subarray(0, 17).toString("hex"), fakeTls: false };
  }
  if (buf.length >= 16) {
    return { keyHex: buf.subarray(0, 16).toString("hex"), fakeTls: false };
  }
  return { keyHex: raw.trim(), fakeTls: false };
}

/**
 * GramJS wants a 16-byte key (hex), or 17 bytes starting with 0xdd.
 * Fake-TLS domain is stored separately on `GramJsProxy.fakeTlsDomain`.
 */
export function normalizeMtProtoSecret(raw: string): string {
  return parseMtProtoSecret(raw).keyHex;
}

export function loadMtProtoProxy(): Extract<GramJsProxy, { MTProxy: true }> | null {
  // PROXY_ENABLED=false → VPN/direct mode; skip MTProto unless TG_MTPROTO_ENABLED=true.
  if (!envBool("PROXY_ENABLED", true) && !envBool("TG_MTPROTO_ENABLED", false)) {
    return null;
  }
  if (process.env.TG_MTPROTO_ENABLED !== undefined && !envBool("TG_MTPROTO_ENABLED", true)) {
    return null;
  }
  const uri = envTrim("TG_MTPROTO_URI") || envTrim("PROXY_MTPROTO_URI");
  const parsedUri = uri ? parseTgProxyUri(uri) : null;
  const host =
    envTrim("TG_MTPROTO_HOST") || envTrim("PROXY_MTPROTO_HOST") || parsedUri?.host || "";
  const port = Number(
    envTrim("TG_MTPROTO_PORT") || envTrim("PROXY_MTPROTO_PORT") || parsedUri?.port || "443"
  );
  const secretRaw =
    envTrim("TG_MTPROTO_SECRET") ||
    envTrim("PROXY_MTPROTO_SECRET") ||
    parsedUri?.secret ||
    "";
  if (!host || !secretRaw || !Number.isFinite(port) || port <= 0) return null;
  const parsed = parseMtProtoSecret(secretRaw);
  return {
    ip: host,
    port,
    secret: parsed.keyHex,
    MTProxy: true,
    ...(parsed.fakeTls && parsed.domain ? { fakeTlsDomain: parsed.domain } : {}),
  };
}

/** GramJS proxy: MTProto for the user account, otherwise SOCKS5. */
export function gramJsProxy(): GramJsProxy | undefined {
  const mt = loadMtProtoProxy();
  if (mt) return mt;
  const cfg = loadAppProxy();
  if (!cfg) return undefined;
  return {
    ip: cfg.host,
    port: cfg.port,
    socksType: 5,
    username: cfg.username || undefined,
    password: cfg.password || undefined,
    timeout: 8,
  };
}

let agent: ProxyAgent | undefined;
let agentKey: string | undefined;

export function proxyDispatcher(): ProxyAgent | undefined {
  const url = httpProxyUrl();
  if (!url) {
    agent = undefined;
    agentKey = undefined;
    return undefined;
  }
  if (agent && agentKey === url) return agent;
  agent = new ProxyAgent(url);
  agentKey = url;
  return agent;
}

/** fetch() via HTTP proxy. Use for OpenAI / Telegram Bot API. */
export function proxiedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const dispatcher = proxyDispatcher();
  if (!dispatcher) return fetch(input, init);
  return undiciFetch(input, { ...(init as object), dispatcher }) as unknown as Promise<Response>;
}

export function grammyProxyFetch(): typeof fetch | undefined {
  const dispatcher = proxyDispatcher();
  if (!dispatcher) return undefined;
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as string, {
      ...(init as object),
      dispatcher,
    })) as unknown as typeof fetch;
}

type Px6Item = {
  host?: string;
  port?: string | number;
  user?: string;
  pass?: string;
  secret?: string;
  type?: string;
  descr?: string;
};

async function fetchPx6List(): Promise<Px6Item[]> {
  const apiKey = envTrim("PX6_API_KEY") || envTrim("PROXY6_API_KEY");
  if (!apiKey) return [];
  const res = await fetch(
    `https://px6.link/api/${encodeURIComponent(apiKey)}/getproxy?state=active`
  );
  if (!res.ok) return [];
  const text = (await res.text()).replace(/^\uFEFF/, "");
  const data = JSON.parse(text) as { list?: Record<string, Px6Item> };
  return Object.values(data.list || {});
}

/**
 * Optional: fill PROXY_HOST/PORT/USER/PASS from PROXY6 getproxy if host is empty.
 * https://px6.net/ru/developers
 */
export async function refreshPx6ProxyFromApi(): Promise<AppProxyConfig | null> {
  const existing = loadAppProxy();
  if (existing) return existing;
  const list = await fetchPx6List();
  const httpHost = envTrim("PROXY_HOST");
  const first =
    list.find((p) => p.host && Number(p.port) !== 443 && String(p.host) !== "38.154.88.76") ||
    list.find((p) => p.host && String(p.host) === httpHost) ||
    list[0];
  if (!first?.host || !first.port) return null;
  process.env.PROXY_ENABLED = "true";
  process.env.PROXY_HOST = String(first.host);
  process.env.PROXY_PORT = String(first.port);
  if (first.user) process.env.PROXY_USERNAME = String(first.user);
  if (first.pass) process.env.PROXY_PASSWORD = String(first.pass);
  agent = undefined;
  agentKey = undefined;
  return loadAppProxy();
}

/** Fill TG_MTPROTO_* from px6 getproxy. Keeps .env fallback if API has no MTProto row. */
export async function refreshPx6MtProtoFromApi(): Promise<Extract<GramJsProxy, { MTProxy: true }> | null> {
  const existing = loadMtProtoProxy();
  const apiList = await fetchPx6List().catch(() => [] as Px6Item[]);
  const httpHost = envTrim("PROXY_HOST");
  const mt = apiList.find((p) => {
    const secret = String(p.secret || p.pass || "");
    const port = Number(p.port);
    if (p.secret) return true;
    if (/mtproto/i.test(String(p.type || p.descr || ""))) return true;
    if (port === 443 && secret.length >= 16 && String(p.host) !== httpHost) return true;
    return false;
  });
  if (mt?.host && (mt.secret || mt.pass)) {
    process.env.TG_MTPROTO_HOST = String(mt.host);
    process.env.TG_MTPROTO_PORT = String(mt.port || 443);
    process.env.TG_MTPROTO_SECRET = String(mt.secret || mt.pass);
    return loadMtProtoProxy();
  }
  return existing;
}
