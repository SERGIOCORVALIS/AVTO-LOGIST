import { createHash, createHmac } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

export interface StoredObject {
  key: string;
  path: string;
  storage: "s3" | "local";
  bytes: number;
}

function s3Configured(): boolean {
  return Boolean(
    process.env.S3_ENDPOINT &&
      process.env.S3_ACCESS_KEY &&
      process.env.S3_SECRET_KEY &&
      process.env.S3_BUCKET
  );
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function amzDate(d = new Date()): { amz: string; date: string } {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amz: iso, date: iso.slice(0, 8) };
}

/** Minimal AWS SigV4 for MinIO / S3 PutObject & GetObject. */
async function s3Request(
  method: "PUT" | "GET",
  key: string,
  body?: Buffer,
  contentType?: string
): Promise<Buffer | void> {
  const endpoint = (process.env.S3_ENDPOINT || "").replace(/\/$/, "");
  const bucket = process.env.S3_BUCKET || "";
  const accessKey = process.env.S3_ACCESS_KEY || "";
  const secretKey = process.env.S3_SECRET_KEY || "";
  const region = process.env.S3_REGION || "us-east-1";
  const url = new URL(`${endpoint}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`);
  const host = url.host;
  const { amz, date } = amzDate();
  const payloadHash = sha256Hex(body || "");
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amz,
  };
  if (contentType) headers["content-type"] = contentType;
  if (body) headers["content-length"] = String(body.length);

  const signedHeaderNames = Object.keys(headers).sort();
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalHeaders = signedHeaderNames
    .map((h) => `${h}:${headers[h]}\n`)
    .join("");
  const canonicalRequest = [
    method,
    url.pathname,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amz,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const kDate = hmac(`AWS4${secretKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(url, { method, headers, body: body as BodyInit | undefined });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`s3_${method.toLowerCase()}_failed:${res.status}:${text.slice(0, 200)}`);
  }
  if (method === "GET") return Buffer.from(await res.arrayBuffer());
}

function localRoot(): string {
  return path.join(process.cwd(), "..", "..", "data", "uploads");
}

export async function storeAttachment(
  dealId: string,
  objectId: string,
  filename: string,
  buf: Buffer,
  contentType?: string
): Promise<StoredObject> {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const key = `${dealId}/${objectId}_${safeName}`;

  if (s3Configured()) {
    try {
      await s3Request("PUT", key, buf, contentType || "application/octet-stream");
      return {
        key,
        path: `s3://${process.env.S3_BUCKET}/${key}`,
        storage: "s3",
        bytes: buf.length,
      };
    } catch (err) {
      console.error("[storage] S3 put failed, falling back to local:", err);
    }
  }

  const dir = path.join(localRoot(), dealId);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${objectId}_${safeName}`);
  await writeFile(filePath, buf);
  return { key, path: filePath, storage: "local", bytes: buf.length };
}

export async function loadAttachmentBytes(meta: {
  path?: string;
  key?: string;
  storage?: string;
}): Promise<Buffer> {
  if (meta.storage === "s3" && meta.key && s3Configured()) {
    const buf = await s3Request("GET", meta.key);
    if (buf) return buf;
  }
  if (meta.path && !meta.path.startsWith("s3://")) {
    return readFile(meta.path);
  }
  if (meta.path?.startsWith("s3://") && meta.key && s3Configured()) {
    const buf = await s3Request("GET", meta.key);
    if (buf) return buf;
  }
  throw new Error("attachment_bytes_unavailable");
}
