import WebSocket from "ws";
import { companyDisplayName, createLogger } from "@alo/shared";
import { pcm8ToRealtime, realtimeToPcm8, type G711Codec, pstnToRealtime } from "./audio";
import {
  REALTIME_TOOLS,
  buildSystemInstructions,
  handleToolCall,
  type ToolContext,
} from "./tools";

const log = createLogger("voice-realtime");

export interface RealtimeBridgeOpts extends ToolContext {
  /** Linear PCM 16-bit LE @ 8 kHz frames for SIP RTP. */
  onAudioOut: (pcm8: Buffer) => void;
  onTranscript?: (role: string, text: string) => void;
  onClose?: () => void;
  /** Override first spoken line (e.g. after-hours message). */
  greetingOverride?: string;
}

export class RealtimeBridge {
  private ws: WebSocket | null = null;
  private closed = false;
  private pendingToolArgs = new Map<string, string>();

  constructor(private opts: RealtimeBridgeOpts) {}

  async connect(): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY required");

    const model = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
    const voice = process.env.VOICE_PERSONA || "alloy";
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;

    await new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      this.ws.on("open", () => {
        log.info("realtime connected", { callSessionId: this.opts.callSessionId });
        this.send({
          type: "session.update",
          session: {
            modalities: ["text", "audio"],
            instructions: buildSystemInstructions(this.opts),
            voice,
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            input_audio_transcription: { model: "whisper-1" },
            turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 600 },
            tools: REALTIME_TOOLS.map((t) => ({ ...t, type: "function" })),
            tool_choice: "auto",
            temperature: 0.7,
          },
        });
        resolve();
      });

      this.ws.on("message", (data) => this.onMessage(data.toString()));
      this.ws.on("error", (err) => {
        log.error("realtime error", { err: String(err) });
        reject(err);
      });
      this.ws.on("close", () => {
        this.closed = true;
        this.opts.onClose?.();
      });
    });

    const company = companyDisplayName();
    const agent = process.env.VOICE_AGENT_NAME || "Анна";
    const greet =
      this.opts.greetingOverride ||
      process.env.VOICE_GREETING ||
      `Здравствуйте, ${company}, меня зовут ${agent}. Чем могу помочь с доставкой из Китая?`;
    this.send({
      type: "response.create",
      response: {
        modalities: ["text", "audio"],
        instructions: greet,
      },
    });
  }

  /** Feed linear PCM 16-bit LE @ 8 kHz (from SIP RTP dialog). */
  sendPcm8Audio(pcm8: Buffer) {
    if (!this.ws || this.closed) return;
    const b64 = pcm8ToRealtime(pcm8);
    this.send({ type: "input_audio_buffer.append", audio: b64 });
  }

  /** Feed G.711 PSTN frame (PCMU/PCMA). */
  sendPstnAudio(chunk: Buffer, codec: G711Codec = "pcmu") {
    if (!this.ws || this.closed) return;
    const b64 = pstnToRealtime(chunk, codec);
    this.send({ type: "input_audio_buffer.append", audio: b64 });
  }

  commitAudio() {
    this.send({ type: "input_audio_buffer.commit" });
    this.send({ type: "response.create", response: { modalities: ["text", "audio"] } });
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }

  requestTransfer(reason: string) {
    this.send({
      type: "response.create",
      response: {
        modalities: ["text", "audio"],
        instructions: `Скажи клиенту одной короткой фразой, что сейчас соединяешь с менеджером. Причина: ${reason}`,
      },
    });
  }

  private send(obj: Record<string, unknown>) {
    this.ws?.send(JSON.stringify(obj));
  }

  private async onMessage(raw: string) {
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(raw);
    } catch {
      return;
    }
    const type = String(evt.type || "");

    if (type === "response.audio.delta" && typeof evt.delta === "string") {
      try {
        const pcm8 = realtimeToPcm8(evt.delta);
        this.opts.onAudioOut(pcm8);
      } catch (err) {
        log.error("audio decode", { err: String(err) });
      }
    }

    if (type === "response.audio_transcript.done" && typeof evt.transcript === "string") {
      this.opts.onTranscript?.("assistant", evt.transcript);
    }

    if (type === "conversation.item.input_audio_transcription.completed") {
      const t = String(evt.transcript || "");
      if (t) this.opts.onTranscript?.("user", t);
    }

    if (type === "response.function_call_arguments.delta") {
      const id = String(evt.call_id || "");
      const prev = this.pendingToolArgs.get(id) || "";
      this.pendingToolArgs.set(id, prev + String(evt.delta || ""));
    }

    if (type === "response.function_call_arguments.done") {
      const callId = String(evt.call_id || "");
      const name = String(evt.name || "");
      const argsRaw = this.pendingToolArgs.get(callId) || String(evt.arguments || "{}");
      this.pendingToolArgs.delete(callId);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(argsRaw);
      } catch {
        args = {};
      }
      log.info("tool call", { name, callSessionId: this.opts.callSessionId });
      const output = await handleToolCall(name, args, this.opts);
      this.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output,
        },
      });
      this.send({ type: "response.create", response: { modalities: ["text", "audio"] } });
    }
  }
}
