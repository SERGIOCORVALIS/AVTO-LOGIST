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

export function resampleLinear(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return input;
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const idx = Math.floor(src);
    const frac = src - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
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
