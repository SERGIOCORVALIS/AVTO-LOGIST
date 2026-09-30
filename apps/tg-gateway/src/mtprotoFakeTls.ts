import { createHmac, randomBytes } from "crypto";
import { Socket } from "net";
import type { TelegramClient } from "telegram";
import { gramJsProxy } from "@alo/shared";

const DIGEST_LEN = 32;
const DIGEST_POS = 11;
const MAX_TLS_PACKET = 2878;
const TLS_CCS = Buffer.from([0x14, 0x03, 0x03, 0x00, 0x01, 0x01]);
const closeError = new Error("NetSocket was closed");

type MtProxy = {
  ip: string;
  port: number;
  secret: string;
  MTProxy: true;
  fakeTlsDomain?: string;
};

function isMtProxy(proxy: unknown): proxy is MtProxy {
  return Boolean(proxy && typeof proxy === "object" && "MTProxy" in (proxy as object));
}

function hmacSha256(secret: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

function buildSniExtension(domain: string): Buffer {
  const sni = Buffer.from(domain, "ascii");
  const inner = Buffer.concat([Buffer.from([0x00]), Buffer.from([(sni.length >> 8) & 0xff, sni.length & 0xff]), sni]);
  const innerList = Buffer.concat([Buffer.from([(inner.length >> 8) & 0xff, inner.length & 0xff]), inner]);
  return Buffer.concat([Buffer.from([0x00, 0x00]), Buffer.from([(innerList.length >> 8) & 0xff, innerList.length & 0xff]), innerList]);
}

function ext(type: number, body: Buffer): Buffer {
  const hdr = Buffer.alloc(4);
  hdr.writeUInt16BE(type, 0);
  hdr.writeUInt16BE(body.length, 2);
  return Buffer.concat([hdr, body]);
}

/** TLS 1.3 ClientHello that mtprotoproxy / mtg accept as Fake-TLS. */
export function buildFakeTlsClientHello(domain: string, secret: Buffer): Buffer {
  const sessionId = randomBytes(32);
  const cipherSuites = Buffer.from(
    "130113021303c02bc02fc02cc030cca9cca8c013c014009c009d002f0035",
    "hex"
  );
  const x25519Pub = randomBytes(32);
  const keyShareEntry = Buffer.concat([Buffer.from([0x00, 0x1d, 0x00, 0x20]), x25519Pub]);
  const keyShareList = Buffer.concat([Buffer.from([(keyShareEntry.length >> 8) & 0xff, keyShareEntry.length & 0xff]), keyShareEntry]);
  const alpn = Buffer.from("\x02h2\x08http/1.1", "binary");
  const sigAlgs = Buffer.from("040308040401050308050501080606010201", "hex");

  let extensions = Buffer.concat([
    buildSniExtension(domain),
    ext(0x0017, Buffer.alloc(0)),
    Buffer.from("ff01000100", "hex"),
    ext(0x000a, Buffer.from("0006001d00170018", "hex")),
    ext(0x000b, Buffer.from([0x01, 0x00])),
    ext(0x0023, Buffer.alloc(0)),
    ext(0x0010, Buffer.concat([Buffer.from([(alpn.length >> 8) & 0xff, alpn.length & 0xff]), alpn])),
    ext(0x0005, Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00])),
    ext(0x000d, Buffer.concat([Buffer.from([(sigAlgs.length >> 8) & 0xff, sigAlgs.length & 0xff]), sigAlgs])),
    ext(0x0012, Buffer.alloc(0)),
    ext(0x0033, keyShareList),
    ext(0x002d, Buffer.from([0x01, 0x01])),
    ext(0x002b, Buffer.from([0x04, 0x03, 0x04, 0x03, 0x03])),
    ext(0x001b, Buffer.from([0x02, 0x00, 0x02])),
  ]);

  const currentTotal = 5 + 4 + 2 + 32 + 1 + 32 + 2 + cipherSuites.length + 2 + 2 + extensions.length;
  const padNeeded = Math.max(0, 517 - currentTotal - 4);
  extensions = Buffer.concat([extensions, ext(0x0015, Buffer.alloc(padNeeded))]);

  const zeroRandom = Buffer.alloc(DIGEST_LEN);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    zeroRandom,
    Buffer.from([sessionId.length]),
    sessionId,
    Buffer.from([(cipherSuites.length >> 8) & 0xff, cipherSuites.length & 0xff]),
    cipherSuites,
    Buffer.from([0x01, 0x00]),
    Buffer.from([(extensions.length >> 8) & 0xff, extensions.length & 0xff]),
    extensions,
  ]);
  const handshakeLen = Buffer.alloc(4);
  handshakeLen.writeUInt32BE(body.length, 0);
  const handshake = Buffer.concat([Buffer.from([0x01]), handshakeLen.subarray(1), body]);
  const recordLen = Buffer.alloc(2);
  recordLen.writeUInt16BE(handshake.length, 0);
  const hello = Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), recordLen, handshake]);

  const digest = hmacSha256(secret, hello);
  const ts = Buffer.alloc(4);
  ts.writeUInt32LE(Math.floor(Date.now() / 1000) >>> 0, 0);
  const randomField = Buffer.from(digest);
  randomField[28] ^= ts[0];
  randomField[29] ^= ts[1];
  randomField[30] ^= ts[2];
  randomField[31] ^= ts[3];
  randomField.copy(hello, DIGEST_POS);
  return hello;
}

function wrapTlsAppData(data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  for (let off = 0; off < data.length; off += MAX_TLS_PACKET) {
    const piece = data.subarray(off, off + MAX_TLS_PACKET);
    const hdr = Buffer.from([0x17, 0x03, 0x03, 0x00, 0x00]);
    hdr.writeUInt16BE(piece.length, 3);
    chunks.push(hdr, piece);
  }
  return Buffer.concat(chunks);
}

/**
 * GramJS socket with Fake-TLS handshake + TLS application-data framing.
 * Constructor signature matches PromisedNetSockets.
 */
export class FakeTlsNetSockets {
  private client: Socket | undefined;
  private closed = true;
  private stream = Buffer.alloc(0);
  private canRead: Promise<boolean> | undefined;
  private resolveRead: ((ok: boolean) => void) | undefined;
  private appMode = false;
  private readonly fakeTlsDomain: string;
  private readonly secret: Buffer;

  constructor(proxy?: unknown) {
    if (!isMtProxy(proxy) || !proxy.fakeTlsDomain || !proxy.secret) {
      throw new Error("FakeTlsNetSockets requires an MTProxy with fakeTlsDomain");
    }
    this.fakeTlsDomain = proxy.fakeTlsDomain;
    this.secret = Buffer.from(proxy.secret, "hex");
  }

  async readExactly(n: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let left = n;
    while (left > 0) {
      const part = await this.read(left);
      chunks.push(part);
      left -= part.length;
    }
    return Buffer.concat(chunks);
  }

  async read(n: number): Promise<Buffer> {
    if (this.closed) throw closeError;
    await this.canRead;
    if (this.closed) throw closeError;
    const toReturn = this.stream.subarray(0, n);
    this.stream = this.stream.subarray(n);
    if (this.stream.length === 0) {
      this.canRead = new Promise((resolve) => {
        this.resolveRead = resolve;
      });
    }
    return toReturn;
  }

  async readAll(): Promise<Buffer> {
    if (this.closed) throw closeError;
    await this.canRead;
    const toReturn = this.stream;
    this.stream = Buffer.alloc(0);
    this.canRead = new Promise((resolve) => {
      this.resolveRead = resolve;
    });
    return toReturn;
  }

  async receive(): Promise<void> {
    /* data handler is attached in connect() */
  }

  toString(): string {
    return "FakeTlsNetSocket";
  }

  async connect(port: number, ip: string): Promise<this> {
    this.stream = Buffer.alloc(0);
    this.appMode = false;
    this.closed = false;
    this.canRead = new Promise((resolve) => {
      this.resolveRead = resolve;
    });
    this.client = new Socket();
    await new Promise<void>((resolve, reject) => {
      const sock = this.client!;
      sock.once("error", reject);
      sock.connect(port, ip, () => {
        sock.removeListener("error", reject);
        resolve();
      });
    });
    this.client.on("error", () => {
      this.closed = true;
      this.resolveRead?.(false);
    });
    this.client.on("close", () => {
      this.closed = true;
      this.resolveRead?.(false);
    });
    this.client.on("data", (message: Buffer) => {
      if (this.appMode) {
        this.ingestAppRecords(message);
      } else {
        this.stream = Buffer.concat([this.stream, message]);
      }
      this.resolveRead?.(true);
    });
    await this.handshake();
    this.appMode = true;
    if (this.stream.length) {
      const leftover = this.stream;
      this.stream = Buffer.alloc(0);
      this.ingestAppRecords(leftover);
    }
    return this;
  }

  write(data: Buffer): void {
    if (this.closed || !this.client) throw closeError;
    this.client.write(this.appMode ? wrapTlsAppData(data) : data);
  }

  async close(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client.unref();
    }
    this.closed = true;
  }

  private pushBytes(buf: Buffer): void {
    this.stream = Buffer.concat([this.stream, buf]);
  }

  private ingestAppRecords(chunk: Buffer): void {
    this.rawHold = Buffer.concat([this.rawHold, chunk]);
    while (this.rawHold.length >= 5) {
      const typ = this.rawHold[0];
      const len = this.rawHold.readUInt16BE(3);
      if (this.rawHold.length < 5 + len) break;
      const payload = this.rawHold.subarray(5, 5 + len);
      this.rawHold = this.rawHold.subarray(5 + len);
      if (typ === 0x17) this.pushBytes(payload);
    }
  }

  private rawHold = Buffer.alloc(0);

  private async handshake(): Promise<void> {
    const hello = buildFakeTlsClientHello(this.fakeTlsDomain, this.secret);
    const helloRand = hello.subarray(DIGEST_POS, DIGEST_POS + DIGEST_LEN);
    this.write(hello);

    const rec1 = await this.readTlsRecord(0x16);
    const rec2 = await this.readTlsRecord(0x14);
    const rec3 = await this.readTlsRecord(0x17);
    const resp = Buffer.concat([rec1, rec2, rec3]);
    const respRand = resp.subarray(DIGEST_POS, DIGEST_POS + DIGEST_LEN);
    const zeroed = Buffer.from(resp);
    zeroed.fill(0, DIGEST_POS, DIGEST_POS + DIGEST_LEN);
    const expected = hmacSha256(this.secret, Buffer.concat([helloRand, zeroed]));
    if (!expected.equals(respRand)) {
      throw new Error("MTProxy Fake-TLS response hash is invalid");
    }
    this.write(TLS_CCS);
  }

  private async readTlsRecord(expectedType: number): Promise<Buffer> {
    const hdr = await this.readExactly(5);
    if (hdr[0] !== expectedType) {
      throw new Error(`MTProxy Fake-TLS unexpected record type ${hdr[0]}`);
    }
    const skip = hdr.readUInt16BE(3);
    const body = await this.readExactly(skip);
    return Buffer.concat([hdr, body]);
  }
}

/** Padded intermediate (`dddddddd`) — required for Fake-TLS ee secrets. */
export class PaddedIntermediatePacketCodec {
  static tag = Buffer.alloc(0);
  static obfuscateTag = Buffer.from("dddddddd", "hex");
  obfuscateTag = PaddedIntermediatePacketCodec.obfuscateTag;
  tag: Buffer | undefined = PaddedIntermediatePacketCodec.tag;

  constructor(_connection: unknown) {}

  encodePacket(data: Buffer): Buffer {
    const pad = randomBytes(Math.floor(Math.random() * 4));
    const payload = Buffer.concat([data, pad]);
    const len = Buffer.alloc(4);
    len.writeInt32LE(payload.length, 0);
    return Buffer.concat([len, payload]);
  }

  async readPacket(reader: { read(n: number): Promise<Buffer>; readExactly?(n: number): Promise<Buffer> }): Promise<Buffer> {
    const exact = (n: number) => (reader.readExactly ? reader.readExactly(n) : reader.read(n));
    const lenBuf = await exact(4);
    const length = lenBuf.readInt32LE(0);
    if (length < 0 || length > 16 * 1024 * 1024) {
      throw new Error(`Invalid padded-intermediate length ${length}`);
    }
    const packet = await exact(length);
    const pad = packet.length % 4;
    return pad ? packet.subarray(0, packet.length - pad) : packet;
  }
}

export function gramJsUsesFakeTls(): boolean {
  const proxy = gramJsProxy();
  return Boolean(proxy && "MTProxy" in proxy && proxy.fakeTlsDomain);
}

export function gramJsFakeTlsParams(): { networkSocket?: unknown } {
  return gramJsUsesFakeTls() ? { networkSocket: FakeTlsNetSockets } : {};
}

/** GramJS always overwrites `_connection` with Abridged when `MTProxy` is set. */
export function patchGramJsFakeTlsConnection(client: TelegramClient): void {
  if (!gramJsUsesFakeTls()) return;
  // Lazy require: gramjs connection modules circular-break if imported at top level.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TCPMTProxy } = require("telegram/network/connection/TCPMTProxy") as {
    TCPMTProxy: new (...args: unknown[]) => { PacketCodecClass: unknown };
  };
  class ConnectionTCPMTProxyFakeTls extends TCPMTProxy {
    constructor(...args: unknown[]) {
      super(...args);
      this.PacketCodecClass = PaddedIntermediatePacketCodec;
    }
  }
  (client as unknown as { _connection: typeof ConnectionTCPMTProxyFakeTls })._connection =
    ConnectionTCPMTProxyFakeTls;
}
