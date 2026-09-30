import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { companyDisplayName, createLogger, httpProxyUrl, openaiRealtimeModel, openaiTranscribeModel } from "@alo/shared";
import { RealtimeAudioIo, type G711Codec, pstnToRealtime } from "./audio";
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
  /** Model started a spoken response — mute the line immediately. */
  onResponseStart?: () => void;
  /** Model finished generating (RTP may still be playing). */
  onResponseDone?: () => void;
  /** First assistant response finished generating (greeting / after-hours). */
  onGreetingDone?: () => void;
  /** Override first spoken line (e.g. after-hours message). */
  greetingOverride?: string;
}

function uniqueModels(): string[] {
  const fromEnv = openaiRealtimeModel();
  const list = [fromEnv, "gpt-realtime-2.1", "gpt-realtime-2", "gpt-realtime"].filter(Boolean);
  return [...new Set(list)];
}

function uniqueVoices(): string[] {
  const fromEnv = (process.env.VOICE_PERSONA || "").trim().toLowerCase();
  const list = [fromEnv, "marin", "coral"].filter(Boolean);
  return [...new Set(list)];
}

export class RealtimeBridge {
  private ws: WebSocket | null = null;
  private closed = false;
  private live = false;
  private pendingToolArgs = new Map<string, string>();
  private handledToolCalls = new Set<string>();
  private audioChunks = 0;
  private sessionAcked = false;
  private sessionReady: (() => void) | null = null;
  private sessionFailed: ((err: Error) => void) | null = null;
  private greetingPending = true;
  /** Ignore caller RTP until playback + echo tail finish. */
  private inputMuted = true;
  private responseInFlight = false;
  private toolsThisTurn = 0;
  private toolJobs: Promise<void>[] = [];
  private turnQueued = false;
  private readonly audioIo = new RealtimeAudioIo();
  private voices: string[] = [];
  private voiceIndex = 0;

  constructor(private opts: RealtimeBridgeOpts) {}

  async connect(): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY required");

    const models = uniqueModels();
    let lastErr: unknown;
    for (const model of models) {
      try {
        await this.openSocket(apiKey, model);
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        log.warn("realtime connect failed, trying next model", {
          model,
          err: String(err),
          callSessionId: this.opts.callSessionId,
        });
        this.ws?.removeAllListeners();
        try {
          this.ws?.terminate();
        } catch {
          /* ignore */
        }
        this.ws = null;
      }
    }
    if (lastErr) throw lastErr;
    if (!this.ws) throw new Error("realtime websocket missing");
    this.live = true;

    this.voices = uniqueVoices();
    this.voiceIndex = 0;
    this.sendSessionUpdate();

    await this.waitForSession(8_000);

    const company = companyDisplayName();
    const agent = process.env.VOICE_AGENT_NAME || "Анна";
    const greet =
      this.opts.greetingOverride ||
      process.env.VOICE_GREETING ||
      `Здравствуйте, ${company}, меня зовут ${agent}. Чем могу помочь: перевозки по России или импорт из Китая?`;
    this.beginResponse({
      output_modalities: ["audio"],
      instructions:
        `Произнеси естественно, как живой менеджер по телефону: ясная дикция, тёплая живая интонация, без монотонности и без театра. ${greet}`,
    });
  }

  private sendSessionUpdate() {
    const voice = this.voices[this.voiceIndex] || "marin";
    log.info("session voice", { voice, callSessionId: this.opts.callSessionId });
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: buildSystemInstructions(this.opts),
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            noise_reduction: { type: "far_field" },
            transcription: { model: openaiTranscribeModel() },
            turn_detection: {
              type: "server_vad",
              threshold: 0.82,
              prefix_padding_ms: 400,
              silence_duration_ms: 1400,
              interrupt_response: false,
              create_response: false,
            },
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice,
            speed: 1.0,
          },
        },
        tools: REALTIME_TOOLS.map((t) => ({ ...t, type: "function" })),
        tool_choice: "auto",
      },
    });
  }

  /** Feed linear PCM 16-bit LE @ 8 kHz (from SIP RTP dialog). */
  sendPcm8Audio(pcm8: Buffer) {
    if (!this.ws || this.closed || this.inputMuted) return;
    const b64 = this.audioIo.toRealtime(pcm8);
    this.send({ type: "input_audio_buffer.append", audio: b64 });
  }

  muteInput() {
    if (this.inputMuted) return;
    this.inputMuted = true;
    this.clearInputBuffer();
  }

  unmuteInput() {
    if (!this.inputMuted) return;
    this.clearInputBuffer();
    this.inputMuted = false;
  }

  isGenerating(): boolean {
    return this.responseInFlight;
  }

  /** Feed G.711 PSTN frame (PCMU/PCMA). */
  sendPstnAudio(chunk: Buffer, codec: G711Codec = "pcmu") {
    if (!this.ws || this.closed || this.inputMuted) return;
    const b64 = pstnToRealtime(chunk, codec);
    this.send({ type: "input_audio_buffer.append", audio: b64 });
  }

  commitAudio() {
    if (this.inputMuted || this.responseInFlight) return;
    this.send({ type: "input_audio_buffer.commit" });
    this.beginResponse();
  }

  close() {
    this.closed = true;
    this.live = false;
    this.ws?.close();
  }

  requestTransfer(reason: string) {
    this.beginResponse({
      instructions: `Скажи клиенту одной короткой фразой, что сейчас соединяешь с старшим менеджером. Причина: ${reason}`,
    });
  }

  private clearInputBuffer() {
    this.send({ type: "input_audio_buffer.clear" });
  }

  private beginResponse(response?: Record<string, unknown>) {
    if (this.closed) return;
    if (this.responseInFlight) {
      this.turnQueued = true;
      return;
    }
    this.responseInFlight = true;
    this.inputMuted = true;
    this.clearInputBuffer();
    this.opts.onResponseStart?.();
    this.send({
      type: "response.create",
      ...(response ? { response } : {}),
    });
  }

  private openSocket(apiKey: string, model: string): Promise<void> {
    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(err);
      };
      const ok = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const proxyUrl = httpProxyUrl();
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        ...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {}),
      });

      this.ws.on("open", () => {
        log.info("realtime connected", {
          callSessionId: this.opts.callSessionId,
          model,
        });
        ok();
      });

      this.ws.on("message", (data) => {
        void this.onMessage(data.toString());
      });
      this.ws.on("unexpected-response", (_req, res) => {
        fail(new Error(`Unexpected server response: ${res.statusCode}`));
      });
      this.ws.on("error", (err) => {
        log.error("realtime error", { err: String(err), model });
        fail(err instanceof Error ? err : new Error(String(err)));
      });
      this.ws.on("close", () => {
        if (!this.live) return;
        this.closed = true;
        this.live = false;
        this.opts.onClose?.();
      });
    });
  }

  private waitForSession(ms: number): Promise<void> {
    if (this.sessionAcked) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sessionReady = null;
        this.sessionFailed = null;
        resolve();
      }, ms);
      this.sessionReady = () => {
        clearTimeout(timer);
        this.sessionReady = null;
        this.sessionFailed = null;
        resolve();
      };
      this.sessionFailed = (err) => {
        clearTimeout(timer);
        this.sessionReady = null;
        this.sessionFailed = null;
        reject(err);
      };
    });
  }

  private send(obj: Record<string, unknown>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(obj));
  }

  private emitAudio(delta: string) {
    try {
      const pcm8 = this.audioIo.toPstn(delta);
      if (!pcm8.length) return;
      this.audioChunks += 1;
      if (this.audioChunks === 1) {
        log.info("first audio delta", {
          callSessionId: this.opts.callSessionId,
          bytes: pcm8.length,
        });
      }
      this.opts.onAudioOut(pcm8);
    } catch (err) {
      log.error("audio decode", { err: String(err) });
    }
  }

  private async runTool(callId: string, name: string, argsRaw: string) {
    if (!callId || this.handledToolCalls.has(callId)) return;
    this.handledToolCalls.add(callId);
    this.toolsThisTurn += 1;
    const job = this.executeTool(callId, name, argsRaw);
    this.toolJobs.push(job);
    await job;
  }

  private async executeTool(callId: string, name: string, argsRaw: string) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsRaw || "{}");
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
  }

  private async onMessage(raw: string) {
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(raw);
    } catch {
      return;
    }
    const type = String(evt.type || "");

    if (type === "session.created" || type === "session.updated") {
      this.sessionAcked = true;
      this.sessionReady?.();
    }

    if (type === "error") {
      const errObj = (evt.error as Record<string, unknown> | undefined) || evt;
      const message = String(errObj.message || errObj.code || "realtime error");
      const param = String(errObj.param || "");
      const voiceErr =
        param.includes("voice") || /invalid value: '.*voice|supported values are:.*marin/i.test(message);
      if (voiceErr && this.voiceIndex + 1 < this.voices.length) {
        this.voiceIndex += 1;
        log.warn("voice rejected, trying next", {
          next: this.voices[this.voiceIndex],
          message,
          callSessionId: this.opts.callSessionId,
        });
        this.sendSessionUpdate();
        return;
      }
      log.error("realtime event error", {
        code: errObj.code,
        message,
        callSessionId: this.opts.callSessionId,
      });
      this.sessionFailed?.(new Error(message));
      return;
    }

    if (
      (type === "response.output_audio.delta" || type === "response.audio.delta") &&
      typeof evt.delta === "string"
    ) {
      this.emitAudio(evt.delta);
    }

    if (
      (type === "response.output_audio_transcript.done" ||
        type === "response.audio_transcript.done") &&
      typeof evt.transcript === "string"
    ) {
      this.opts.onTranscript?.("assistant", evt.transcript);
    }

    if (
      type === "conversation.item.input_audio_transcription.completed" ||
      type === "conversation.item.input_audio_transcription.done"
    ) {
      const t = String(evt.transcript || "");
      if (t) this.opts.onTranscript?.("user", t);
    }

    if (type === "input_audio_buffer.committed") {
      if (!this.inputMuted && !this.responseInFlight) {
        this.beginResponse();
      }
    }

    if (type === "response.created") {
      this.responseInFlight = true;
      this.inputMuted = true;
      this.opts.onResponseStart?.();
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
      await this.runTool(callId, name, argsRaw);
    }

    if (type === "response.done") {
      const response = evt.response as
        | { output?: Array<{ type?: string; call_id?: string; name?: string; arguments?: string }> }
        | undefined;
      for (const item of response?.output || []) {
        if (item?.type === "function_call") {
          await this.runTool(String(item.call_id || ""), String(item.name || ""), String(item.arguments || "{}"));
        }
      }
      if (this.toolJobs.length) {
        await Promise.all(this.toolJobs);
        this.toolJobs = [];
      }
      const needFollowup = this.toolsThisTurn > 0 || this.turnQueued;
      this.toolsThisTurn = 0;
      this.turnQueued = false;
      this.responseInFlight = false;
      if (this.greetingPending) {
        this.greetingPending = false;
        this.opts.onGreetingDone?.();
      }
      this.opts.onResponseDone?.();
      if (needFollowup) {
        this.beginResponse();
      }
    }
  }
}
