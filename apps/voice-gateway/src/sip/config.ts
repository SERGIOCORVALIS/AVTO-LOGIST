import { createLogger } from "@alo/shared";
import {
  resolveSipProvider,
  type SipProviderId,
  type SipProviderPreset,
} from "./providers";

const log = createLogger("sip-config");

export type SipUriMode = boolean;

export interface SipConfig {
  enabled: boolean;
  provider: SipProviderId;
  providerLabel: string;
  domain: string;
  username: string;
  /** Digest auth user (Beeline often user@domain) */
  authUsername: string;
  password: string;
  /** Outbound proxy host without sip: (Beeline regional proxy) */
  outboundProxy: string;
  uriMode: SipUriMode;
  bindHost: string;
  port: number;
  localIp: string;
  publicHost: string;
  rtpPortMin: number;
  rtpPortMax: number;
  /** 8 = PCMA, 0 = PCMU */
  payloadType: number;
  didNumber: string;
  managerTransferNumber: string;
  maxCallMinutes: number;
  maxConcurrentCalls: number;
  allowedIps: string[];
  registerExpires: number;
  keepaliveUri: string;
  preset: SipProviderPreset;
}

function envBool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function stripSipPrefix(host: string): string {
  return host.replace(/^sip:/i, "").replace(/;.*$/, "").trim();
}

export function loadSipConfig(): SipConfig {
  let preset: SipProviderPreset;
  try {
    preset = resolveSipProvider(process.env.SIP_PROVIDER);
  } catch (err) {
    log.error(String(err));
    preset = resolveSipProvider("zadarma");
  }

  const username = process.env.SIP_USERNAME || "";
  const password = process.env.SIP_PASSWORD || "";
  const uriMode = envBool("SIP_URI_MODE", false);
  const publicHost =
    process.env.SIP_PUBLIC_HOST ||
    process.env.SIP_LOCAL_IP ||
    process.env.VOICE_GATEWAY_PUBLIC_HOST ||
    "";
  const localIp = process.env.SIP_LOCAL_IP || publicHost || "127.0.0.1";
  const domain = process.env.SIP_DOMAIN || preset.domain;
  const outboundProxy = stripSipPrefix(
    process.env.SIP_OUTBOUND_PROXY || preset.outboundProxy || ""
  );

  const authUsernameExplicit = process.env.SIP_AUTH_USERNAME || "";
  const authUsername =
    authUsernameExplicit ||
    (preset.authUserIncludesDomain && username && !username.includes("@")
      ? `${username}@${domain}`
      : username);

  const allowedRaw = process.env.SIP_ALLOWED_IPS || "";
  const allowedIps = allowedRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const hasCreds = Boolean(username && password);
  const canStart = (uriMode || hasCreds) && Boolean(publicHost);
  const enabled = envBool("SIP_ENABLED", canStart) && canStart;

  if (!enabled) {
    log.warn(
      "SIP disabled — set SIP_PUBLIC_HOST and (SIP_USERNAME/SIP_PASSWORD or SIP_URI_MODE=1)"
    );
  } else {
    log.info("SIP provider selected", {
      provider: preset.id,
      label: preset.label,
      domain,
      outboundProxy: outboundProxy || undefined,
      authUsername: authUsername ? "(set)" : undefined,
    });
  }

  const codecEnv = process.env.SIP_CODEC;
  const codec = (codecEnv || preset.codec).toLowerCase();
  const payloadType = codec === "pcmu" || codec === "0" ? 0 : 8;

  const registerExpires = process.env.SIP_REGISTER_EXPIRES
    ? envInt("SIP_REGISTER_EXPIRES", preset.registerExpires)
    : preset.registerExpires;

  const keepaliveUri =
    process.env.SIP_KEEPALIVE_URI ||
    (outboundProxy ? `sip:${outboundProxy}` : `sip:${domain}`);

  return {
    enabled,
    provider: preset.id,
    providerLabel: preset.label,
    domain,
    username,
    authUsername,
    password,
    outboundProxy,
    uriMode,
    bindHost: process.env.SIP_BIND_HOST || "0.0.0.0",
    port: envInt("SIP_PORT", 5060),
    localIp,
    publicHost: publicHost || localIp,
    rtpPortMin: envInt("SIP_RTP_PORT_MIN", 10000),
    rtpPortMax: envInt("SIP_RTP_PORT_MAX", 20000),
    payloadType,
    didNumber: process.env.VOICE_DID_NUMBER || "",
    managerTransferNumber: process.env.VOICE_MANAGER_TRANSFER_NUMBER || "",
    maxCallMinutes: envInt("VOICE_MAX_CALL_MINUTES", 30),
    maxConcurrentCalls: envInt("SIP_MAX_CONCURRENT_CALLS", 20),
    allowedIps,
    registerExpires,
    keepaliveUri,
    preset,
  };
}

/** Build sip: URI for E.164 / national number via trunk domain. */
export function managerSipUri(number: string, domain: string): string {
  const digits = number.replace(/[^\d+]/g, "");
  const user = digits.startsWith("+") ? digits.slice(1) : digits.replace(/\D/g, "");
  return `sip:${user}@${domain}`;
}
