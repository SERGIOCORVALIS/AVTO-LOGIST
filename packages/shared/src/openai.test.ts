import { openaiChatExtras, openaiModel, openaiTimeoutMs, openaiTranscribeModel } from "./openai";

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};

process.env.OPENAI_MODEL = "gpt-5.6-sol";
process.env.OPENAI_FAST_MODEL = "gpt-5.6-luna";
process.env.OPENAI_CODING_MODEL = "gpt-5.6-sol";
process.env.OPENAI_DOCUMENT_MODEL = "gpt-5.6-sol";
process.env.OPENAI_TRANSCRIBE_MODEL = "gpt-transcribe";
process.env.OPENAI_REASONING_EFFORT = "high";
process.env.OPENAI_TIMEOUT_SEC = "120";
process.env.OPENAI_MAX_COMPLETION_TOKENS = "32768";

assert(openaiModel("main") === "gpt-5.6-sol", "main");
assert(openaiModel("fast") === "gpt-5.6-luna", "fast");
assert(openaiModel("coding") === "gpt-5.6-sol", "coding");
assert(openaiModel("document") === "gpt-5.6-sol", "document");
assert(openaiTranscribeModel() === "gpt-transcribe", "transcribe");
assert(openaiTimeoutMs() === 120_000, "timeout");

const extras = openaiChatExtras("gpt-5.6-sol");
assert(extras.reasoning_effort === "high", "effort");
assert(extras.max_completion_tokens === 32768, "max tokens");

console.log("openai.test ok");
