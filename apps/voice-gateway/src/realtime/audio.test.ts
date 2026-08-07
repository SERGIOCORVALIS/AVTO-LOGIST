import {
  pstnToRealtime,
  realtimeToPstn,
  pcm8ToRealtime,
  realtimeToPcm8,
  encodeAlaw,
  decodeAlaw,
  encodeMulaw,
  decodeMulaw,
} from "./audio";

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

const mulaw = Buffer.from([0xff, 0x7f, 0x00, 0x80]);
const pcm8 = new Int16Array([0, 1000, -1000, 500]);
const b64 = (() => {
  const buf = Buffer.alloc(pcm8.length * 2);
  for (let i = 0; i < pcm8.length; i++) buf.writeInt16LE(pcm8[i]!, i * 2);
  return buf.toString("base64");
})();

const roundPcmu = pstnToRealtime(mulaw, "pcmu");
assert(typeof roundPcmu === "string" && roundPcmu.length > 0, "pstnToRealtime pcmu");

const backPcmu = realtimeToPstn(b64, "pcmu");
assert(backPcmu.length > 0, "realtimeToPstn pcmu");

const alawRound = encodeAlaw(decodeAlaw(Buffer.from([0xd5, 0x55, 0x00, 0xaa])));
assert(alawRound.length === 4, "alaw encode/decode length");

const alawFrame = encodeAlaw(pcm8);
const roundPcma = pstnToRealtime(alawFrame, "pcma");
assert(typeof roundPcma === "string" && roundPcma.length > 0, "pstnToRealtime pcma");

const backPcma = realtimeToPstn(b64, "pcma");
assert(backPcma.length > 0, "realtimeToPstn pcma");

const pcm8Buf = Buffer.alloc(pcm8.length * 2);
for (let i = 0; i < pcm8.length; i++) pcm8Buf.writeInt16LE(pcm8[i]!, i * 2);
const fromPcm8 = pcm8ToRealtime(pcm8Buf);
assert(fromPcm8.length > 0, "pcm8ToRealtime");
const toPcm8 = realtimeToPcm8(b64);
assert(toPcm8.length > 0 && toPcm8.length % 2 === 0, "realtimeToPcm8");

const mulawRound = encodeMulaw(decodeMulaw(mulaw));
assert(mulawRound.length === mulaw.length, "mulaw roundtrip length");

console.log("audio.test ok");
