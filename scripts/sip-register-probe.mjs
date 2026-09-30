/**
 * One-shot Beeline REGISTER probe (UDP 5060). Does not print the password.
 */
import dgram from "node:dgram";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  fs
    .readFileSync(path.join(root, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const user = env.SIP_USERNAME;
const authUser = env.SIP_AUTH_USERNAME || `${user}@${env.SIP_DOMAIN}`;
const pass = env.SIP_PASSWORD;
const domain = env.SIP_DOMAIN;
const proxy = env.SIP_OUTBOUND_PROXY || "79.104.208.38";
const publicHost = env.SIP_PUBLIC_HOST;
const localIp = env.SIP_LOCAL_IP || "192.168.1.33";

function md5(s) {
  return crypto.createHash("md5").update(s).digest("hex");
}

function parseChallenge(pkt) {
  const m = pkt.match(/WWW-Authenticate:\s*Digest\s+(.+)/i);
  if (!m) return null;
  const out = {};
  for (const p of m[1].split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const mm = p.trim().match(/^(\w+)=("?)(.*?)\2$/);
    if (mm) out[mm[1].toLowerCase()] = mm[3];
  }
  return out;
}

function statusLine(pkt) {
  const m = pkt.match(/^SIP\/2\.0\s+(\d+)\s*(.*)$/m);
  return m ? { code: Number(m[1]), reason: m[2].trim() } : { code: 0, reason: "no-status" };
}

function buildRegister({ cseq, callId, branch, contactHost, authorization }) {
  const aor = `sip:${user}@${domain}`;
  const lines = [
    `REGISTER sip:${domain}:5060 SIP/2.0`,
    `Via: SIP/2.0/UDP ${publicHost}:5060;branch=${branch};rport`,
    `Route: <sip:${proxy}:5060;lr>`,
    `Max-Forwards: 70`,
    `From: <${aor}>;tag=${callId.slice(-8)}`,
    `To: <${aor}>`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} REGISTER`,
    `Contact: <sip:${user}@${contactHost}:5060>`,
    `Expires: 3600`,
    `User-Agent: alo-sip-probe/1`,
  ];
  if (authorization) lines.push(`Authorization: ${authorization}`);
  lines.push("Content-Length: 0", "", "");
  return lines.join("\r\n");
}

function digestHeader(ch, username, uri) {
  const realm = ch.realm;
  const nonce = ch.nonce;
  const qop = (ch.qop || "auth").split(",")[0].trim();
  const nc = "00000001";
  const cnonce = md5(String(Date.now())).slice(0, 16);
  const ha1 = md5(`${username}:${realm}:${pass}`);
  const ha2 = md5(`REGISTER:${uri}`);
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  return (
    `Digest username="${username}",realm="${realm}",nonce="${nonce}",uri="${uri}",` +
    `response="${response}",algorithm=MD5,cnonce="${cnonce}",qop=${qop},nc=${nc}`
  );
}

function sendRecv(sock, msg, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    const onMsg = (buf) => {
      clearTimeout(t);
      sock.off("message", onMsg);
      resolve(buf.toString("utf8"));
    };
    sock.on("message", onMsg);
    sock.send(Buffer.from(msg, "ascii"), 5060, proxy);
  });
}

const usernames = [
  authUser,
  user,
  `${user}@ims.mnc099.mcc250.3gppnetwork.org`,
];
const uris = [`sip:${domain}:5060`, `sip:${domain}`];
const contacts = [publicHost, localIp];

const sock = dgram.createSocket("udp4");
await new Promise((r) => sock.bind(5060, r));

const results = [];
let n = 1;
for (const uname of usernames) {
  for (const uri of uris) {
    for (const contactHost of contacts) {
      const callId = `probe-${Date.now()}-${n}`;
      const unauth = buildRegister({
        cseq: n,
        callId,
        branch: `z9hG4bK${n}a`,
        contactHost,
      });
      const r1 = await sendRecv(sock, unauth);
      if (!r1) {
        results.push({ uname, uri, contactHost, step: "unauth", code: 408, reason: "timeout" });
        n += 1;
        continue;
      }
      const s1 = statusLine(r1);
      if (s1.code !== 401 && s1.code !== 407) {
        results.push({ uname, uri, contactHost, step: "unauth", ...s1 });
        n += 1;
        continue;
      }
      const ch = parseChallenge(r1);
      if (!ch?.nonce) {
        results.push({ uname, uri, contactHost, step: "challenge", code: s1.code, reason: "no-digest" });
        n += 1;
        continue;
      }
      n += 1;
      const authed = buildRegister({
        cseq: n,
        callId,
        branch: `z9hG4bK${n}b`,
        contactHost,
        authorization: digestHeader(ch, uname, uri),
      });
      const r2 = await sendRecv(sock, authed);
      const s2 = r2 ? statusLine(r2) : { code: 408, reason: "timeout" };
      results.push({ uname, uri, contactHost, step: "digest", ...s2, realm: ch.realm });
      if (s2.code >= 200 && s2.code < 300) {
        console.log("SUCCESS", JSON.stringify({ uname, uri, contactHost, ...s2 }));
        sock.close();
        process.exit(0);
      }
      n += 1;
    }
  }
}

console.log(JSON.stringify(results, null, 2));
sock.close();
