const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

const MULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let u = ~i & 0xff;
  const sign = u & 0x80 ? -1 : 1;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  MULAW_DECODE[i] = sign * sample;
}

const ALAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let a = i ^ 0x55;
  const sign = a & 0x80;
  let exponent = (a & 0x70) >> 4;
  let data = a & 0x0f;
  data <<= 4;
  data += 8;
  if (exponent !== 0) data += 0x100;
  if (exponent > 1) data <<= exponent - 1;
  ALAW_DECODE[i] = sign ? -data : data;
}

export type G711Codec = "pcmu" | "pcma";

function linearToMulaw(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
    /* noop */
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function linearToAlaw(sample: number): number {
  const ALAW_MAX = 0x7fff;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > ALAW_MAX) sample = ALAW_MAX;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
    /* noop */
  }
  const mantissa = (sample >> (exponent === 0 ? 4 : exponent + 3)) & 0x0f;
  const alaw = sign | (exponent << 4) | mantissa;
  return alaw ^ 0x55;
}

export function decodeMulaw(buf: Buffer): Int16Array {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = MULAW_DECODE[buf[i]!]!;
  return out;
}

export function encodeMulaw(pcm: Int16Array): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = linearToMulaw(pcm[i]!);
  return out;
}

export function decodeAlaw(buf: Buffer): Int16Array {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = ALAW_DECODE[buf[i]!]!;
  return out;
}

export function encodeAlaw(pcm: Int16Array): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = linearToAlaw(pcm[i]!);
  return out;
}

function clamp16(v: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(v)));
}

function cubicSample(input: Int16Array, idx: number, frac: number): number {
  const y0 = input[idx - 1] ?? input[idx] ?? 0;
  const y1 = input[idx] ?? 0;
  const y2 = input[idx + 1] ?? y1;
  const y3 = input[idx + 2] ?? y2;
  const c0 = y1;
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return clamp16(((c3 * frac + c2) * frac + c1) * frac + c0);
}

/** Hamming-windowed sinc, cutoff 3.4 kHz @ 24 kHz — telephone band, no aliasing. */
const LOWPASS_24K = (() => {
  const nTaps = 63;
  const fc = 3400 / 24000;
  const h = new Float64Array(nTaps);
  const mid = (nTaps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < nTaps; i++) {
    const k = i - mid;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (nTaps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < nTaps; i++) h[i]! /= sum;
  return h;
})();

function downsample24to8(input: Int16Array): Int16Array {
  const outLen = Math.max(1, Math.round(input.length / 3));
  const out = new Int16Array(outLen);
  const h = LOWPASS_24K;
  const mid = (h.length - 1) / 2;
  for (let i = 0; i < outLen; i++) {
    const center = i * 3;
    let acc = 0;
    for (let t = 0; t < h.length; t++) {
      const src = center + t - mid;
      const s = src < 0 || src >= input.length ? 0 : input[src]!;
      acc += s * h[t]!;
    }
    out[i] = clamp16(acc);
  }
  return out;
}

function upsample8to24(input: Int16Array): Int16Array {
  const out = new Int16Array(Math.max(1, input.length * 3));
  for (let i = 0; i < out.length; i++) {
    const src = i / 3;
    const idx = Math.floor(src);
    out[i] = cubicSample(input, idx, src - idx);
  }
  return out;
}

/** Quality resample. 24k↔8k uses anti-alias FIR; other ratios stay cubic. */
export function resampleLinear(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return input;
  if (fromRate === 24000 && toRate === 8000) return downsample24to8(input);
  if (fromRate === 8000 && toRate === 24000) return upsample8to24(input);
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const idx = Math.floor(src);
    out[i] = cubicSample(input, idx, src - idx);
  }
  return out;
}

function softClip(x: number): number {
  const lim = 28000;
  const a = Math.abs(x);
  if (a <= lim) return clamp16(x);
  const s = x < 0 ? -1 : 1;
  const over = (a - lim) / (32767 - lim);
  return clamp16(s * (lim + (32767 - lim) * Math.tanh(over)));
}

export interface PstnEnhanceState {
  prev: number;
  hp: number;
}

/** Drop rumble and avoid G.711 hard-clip (harsh/unclear on PSTN). */
export function enhancePstn(pcm: Int16Array, st: PstnEnhanceState): Int16Array {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const x = pcm[i]!;
    st.hp = 0.96 * (st.hp + x - st.prev);
    st.prev = x;
    out[i] = softClip(st.hp);
  }
  return out;
}

/** Streaming 24 kHz → 8 kHz with FIR memory across GPT audio deltas. */
export class FirDecimator24to8 {
  private readonly delay = new Float64Array(LOWPASS_24K.length);
  private write = 0;
  private phase = 0;

  push(pcm24: Int16Array): Int16Array {
    const h = LOWPASS_24K;
    const n = h.length;
    const out: number[] = [];
    for (let i = 0; i < pcm24.length; i++) {
      this.delay[this.write] = pcm24[i]!;
      this.write = (this.write + 1) % n;
      if (this.phase === 0) {
        let acc = 0;
        let j = this.write;
        for (let t = 0; t < n; t++) {
          j = j === 0 ? n - 1 : j - 1;
          acc += this.delay[j]! * h[t]!;
        }
        out.push(clamp16(acc));
      }
      this.phase = (this.phase + 1) % 3;
    }
    return Int16Array.from(out);
  }
}

/** Streaming 8 kHz → 24 kHz with 4-sample cubic history. */
export class CubicUpsampler8to24 {
  private readonly hist = new Int16Array([0, 0, 0, 0]);

  push(pcm8: Int16Array): Int16Array {
    const out = new Int16Array(pcm8.length * 3);
    let o = 0;
    for (let i = 0; i < pcm8.length; i++) {
      this.hist[0] = this.hist[1]!;
      this.hist[1] = this.hist[2]!;
      this.hist[2] = this.hist[3]!;
      this.hist[3] = pcm8[i]!;
      out[o++] = cubicSample(this.hist, 2, 0);
      out[o++] = cubicSample(this.hist, 2, 1 / 3);
      out[o++] = cubicSample(this.hist, 2, 2 / 3);
    }
    return out;
  }
}

/** Per-call audio path: GPT 24 kHz ↔ PSTN 8 kHz without chunk-edge clicks. */
export class RealtimeAudioIo {
  private readonly down = new FirDecimator24to8();
  private readonly up = new CubicUpsampler8to24();
  private readonly pstn: PstnEnhanceState = { prev: 0, hp: 0 };

  toPstn(pcm24B64: string): Buffer {
    const pcm24 = base64ToPcm16(pcm24B64);
    const pcm8 = this.down.push(pcm24);
    if (!pcm8.length) return Buffer.alloc(0);
    return samplesToPcm8Buffer(enhancePstn(pcm8, this.pstn));
  }

  toRealtime(pcm8: Buffer): string {
    const pcm24 = this.up.push(pcm8BufferToSamples(pcm8));
    return pcm16ToBase64(pcm24);
  }
}

export function pcm16ToBase64(pcm: Int16Array): string {
  const buf = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i]!, i * 2);
  return buf.toString("base64");
}

export function base64ToPcm16(b64: string): Int16Array {
  const buf = Buffer.from(b64, "base64");
  const out = new Int16Array(buf.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

export function pcm8BufferToSamples(pcm8: Buffer): Int16Array {
  const out = new Int16Array(pcm8.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = pcm8.readInt16LE(i * 2);
  return out;
}

export function samplesToPcm8Buffer(pcm: Int16Array): Buffer {
  const buf = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i]!, i * 2);
  return buf;
}

/** G.711 PSTN frame → OpenAI Realtime pcm16 @ 24 kHz (base64). */
export function pstnToRealtime(chunk: Buffer, codec: G711Codec = "pcmu"): string {
  const pcm8 = codec === "pcma" ? decodeAlaw(chunk) : decodeMulaw(chunk);
  const pcm24 = resampleLinear(pcm8, 8000, 24000);
  return pcm16ToBase64(pcm24);
}

/** OpenAI Realtime pcm16 @ 24 kHz → G.711 PSTN frame. */
export function realtimeToPstn(pcm24B64: string, codec: G711Codec = "pcmu"): Buffer {
  const pcm24 = base64ToPcm16(pcm24B64);
  const pcm8 = resampleLinear(pcm24, 24000, 8000);
  return codec === "pcma" ? encodeAlaw(pcm8) : encodeMulaw(pcm8);
}

/** Linear PCM 16-bit LE @ 8 kHz → Realtime pcm16 @ 24 kHz (base64). */
export function pcm8ToRealtime(pcm8: Buffer): string {
  const samples = pcm8BufferToSamples(pcm8);
  const pcm24 = resampleLinear(samples, 8000, 24000);
  return pcm16ToBase64(pcm24);
}

/** Realtime pcm16 @ 24 kHz → linear PCM 16-bit LE @ 8 kHz. */
export function realtimeToPcm8(pcm24B64: string): Buffer {
  const pcm24 = base64ToPcm16(pcm24B64);
  const pcm8 = resampleLinear(pcm24, 24000, 8000);
  return samplesToPcm8Buffer(pcm8);
}
