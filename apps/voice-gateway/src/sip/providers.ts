/**
 * SIP trunk provider presets (inbound DID → voice-gateway).
 * Override any field via SIP_* env vars.
 */

export type SipProviderId = "zadarma" | "beeline";

export interface SipProviderPreset {
  id: SipProviderId;
  label: string;
  /** Default SIP domain / registrar */
  domain: string;
  /** Default G.711: pcma=alaw, pcmu=ulaw */
  codec: "pcma" | "pcmu";
  registerExpires: number;
  /** Digest auth username is often user@domain (Beeline) */
  authUserIncludesDomain: boolean;
  /** Optional default outbound proxy host (no sip: prefix) */
  outboundProxy?: string;
  docsUrl: string;
}

export const SIP_PROVIDERS: Record<SipProviderId, SipProviderPreset> = {
  zadarma: {
    id: "zadarma",
    label: "Zadarma",
    domain: "sip.zadarma.com",
    codec: "pcma",
    registerExpires: 600,
    authUserIncludesDomain: false,
    docsUrl: "https://zadarma.com/en/support/faq/voip/",
  },
  beeline: {
    id: "beeline",
    label: "Билайн бизнес",
    // Часто в ЛК: sip.beeline.ru | ip.beeline.ru | mpbx.sip.beeline.ru — переопределите SIP_DOMAIN
    domain: "sip.beeline.ru",
    codec: "pcma",
    registerExpires: 3600,
    authUserIncludesDomain: true,
    // Региональный proxy задайте в SIP_OUTBOUND_PROXY (напр. msk.sip.beeline.ru)
    docsUrl: "https://moskva.beeline.ru/business/telephony/cloud-ats/sip-telefoniya/",
  },
};

const ALIASES: Record<string, SipProviderId> = {
  zadarma: "zadarma",
  beeline: "beeline",
  beeline_business: "beeline",
  "beeline-business": "beeline",
  beelinebusiness: "beeline",
  bilayn: "beeline",
  билайн: "beeline",
};

export function resolveSipProvider(raw?: string): SipProviderPreset {
  const key = (raw || "zadarma").trim().toLowerCase();
  const id = ALIASES[key] || (key in SIP_PROVIDERS ? (key as SipProviderId) : null);
  if (!id) {
    const known = Object.keys(SIP_PROVIDERS).join(", ");
    throw new Error(`Unknown SIP_PROVIDER="${raw}". Use one of: ${known}, beeline_business`);
  }
  return SIP_PROVIDERS[id];
}

export function listSipProviders(): SipProviderPreset[] {
  return Object.values(SIP_PROVIDERS);
}
