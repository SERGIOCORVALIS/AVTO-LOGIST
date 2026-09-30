/**
 * OpenAI routing from monorepo .env.
 * Roles:
 *   main      OPENAI_MODEL            — concierge / negotiator
 *   fast      OPENAI_FAST_MODEL       — cheap/quick extracts
 *   coding    OPENAI_CODING_MODEL
 *   document  OPENAI_DOCUMENT_MODEL   — legal / OCR / vision / invoices
 */

export type OpenAiRole = "main" | "fast" | "coding" | "document";

const ROLE_ENV: Record<OpenAiRole, string> = {
  main: "OPENAI_MODEL",
  fast: "OPENAI_FAST_MODEL",
  coding: "OPENAI_CODING_MODEL",
  document: "OPENAI_DOCUMENT_MODEL",
};

const ROLE_DEFAULT: Record<OpenAiRole, string> = {
  main: "gpt-5.6-sol",
  fast: "gpt-5.6-luna",
  coding: "gpt-5.6-sol",
  document: "gpt-5.6-sol",
};

function envTrim(name: string): string {
  return (process.env[name] || "").trim();
}

/** First CSV/semicolon segment; trailing dash from old env typos is stripped. */
export function firstModelId(raw?: string, fallback = "gpt-5.6-sol"): string {
  const s = (raw || fallback).split(/[,;]/)[0]?.trim() || fallback;
  return s.replace(/-$/, "") || fallback;
}

export function openaiModel(role: OpenAiRole = "main"): string {
  const fromRole = envTrim(ROLE_ENV[role]);
  const fromMain = envTrim("OPENAI_MODEL");
  return firstModelId(fromRole || fromMain || ROLE_DEFAULT[role], ROLE_DEFAULT[role]);
}

export function openaiBaseUrl(): string {
  return (envTrim("OPENAI_BASE_URL") || "https://api.openai.com/v1").replace(/\/$/, "");
}

export function openaiApiKey(): string {
  return envTrim("OPENAI_API_KEY");
}

export function openaiReasoningEffort(): string {
  return envTrim("OPENAI_REASONING_EFFORT") || "high";
}

export function openaiTimeoutMs(): number {
  const sec = Number(envTrim("OPENAI_TIMEOUT_SEC") || "120");
  if (!Number.isFinite(sec) || sec <= 0) return 120_000;
  return Math.round(sec * 1000);
}

export function openaiMaxCompletionTokens(): number | undefined {
  const raw = envTrim("OPENAI_MAX_COMPLETION_TOKENS") || "32768";
  if (["", "0", "none", "off"].includes(raw.toLowerCase())) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 32768;
  return Math.floor(n);
}

export function openaiTranscribeModel(): string {
  // Prefer gpt-transcribe; callers also fall back to whisper-1 on failure.
  return firstModelId(envTrim("OPENAI_TRANSCRIBE_MODEL") || "gpt-transcribe", "gpt-transcribe");
}

export function openaiRealtimeModel(): string {
  return firstModelId(envTrim("OPENAI_REALTIME_MODEL") || "gpt-realtime-2.1", "gpt-realtime-2.1");
}

export function openaiEmbeddingModel(): string {
  return firstModelId(
    envTrim("OPENAI_EMBEDDING_MODEL") || "text-embedding-3-large",
    "text-embedding-3-large"
  );
}

export function isReasoningModel(model: string): boolean {
  const m = (model || "").toLowerCase();
  return m.startsWith("gpt-5") || /^o[1-4]/.test(m);
}

/** Extra Chat Completions fields that depend on the model and .env. */
export function openaiChatExtras(
  model: string,
  opts?: { temperature?: number }
): Record<string, unknown> {
  if (isReasoningModel(model)) {
    const extra: Record<string, unknown> = {};
    const effort = openaiReasoningEffort();
    if (effort) extra.reasoning_effort = effort;
    const maxTok = openaiMaxCompletionTokens();
    if (maxTok) extra.max_completion_tokens = maxTok;
    return extra;
  }
  return { temperature: opts?.temperature ?? 0 };
}

export function openaiFetchInit(init?: RequestInit): RequestInit {
  const timeout = openaiTimeoutMs();
  return {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(timeout),
  };
}
