/**
 * Sync/clean .env and .env.example:
 * - strip inline comments from values (dotenv treats them as part of value)
 * - remove leading spaces before KEY=
 * - dedupe keys in .env (keep last non-empty, else last)
 * - add missing keys from example into .env (empty)
 * - add extra .env keys into .env.example (placeholders)
 *
 * Does NOT print secret values.
 */
import fs from "fs";

function stripInlineComment(val) {
  const t = val.trimStart();
  if (t.startsWith('"') || t.startsWith("'")) return val;
  // empty value that is only a comment
  if (/^\s*#/.test(val)) return "";
  // unquoted trailing comment: value # comment  OR  value #(note)
  const m = val.match(/^(.*?)\s+#.*$/);
  return m ? m[1].replace(/\s+$/, "") : val.replace(/\s+$/, "");
}

function transformContent(text, { dedupe = false } = {}) {
  const lines = text.split(/\r?\n/);
  const out = [];
  const seen = new Map(); // key -> out index
  const commentsBefore = [];

  const flushComments = () => {
    while (commentsBefore.length) out.push(commentsBefore.shift());
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushComments();
      out.push("");
      continue;
    }
    if (trimmed.startsWith("#")) {
      commentsBefore.push(trimmed.startsWith("#") ? (line.match(/^\s*/)?.[0] || "") + trimmed : line);
      // keep original indentation of comments as single #
      commentsBefore[commentsBefore.length - 1] = trimmed;
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq < 0) {
      flushComments();
      out.push(trimmed);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1);
    const hadInline = /\s+#/.test(val) && !/^["']/.test(val.trim());
    const cleanVal = stripInlineComment(val);
    if (hadInline) {
      const hash = val.indexOf("#");
      const comment = hash >= 0 ? val.slice(hash + 1).replace(/^\s*/, "").trim() : "";
      if (comment) commentsBefore.push(`# ${comment}`);
    }
    flushComments();
    const newLine = `${key}=${cleanVal}`;
    if (dedupe && seen.has(key)) {
      const idx = seen.get(key);
      const prev = out[idx];
      const prevVal = prev.slice(prev.indexOf("=") + 1);
      // Prefer non-empty over empty; otherwise keep last
      if (!prevVal.trim() && cleanVal.trim()) {
        out[idx] = newLine;
      } else if (cleanVal.trim()) {
        out[idx] = newLine; // last non-empty wins
      }
      // drop duplicate line (don't push)
      continue;
    }
    if (dedupe) seen.set(key, out.length);
    out.push(newLine);
  }
  flushComments();
  // trim excessive trailing blanks
  while (out.length && out[out.length - 1] === "") out.pop();
  out.push("");
  return out.join("\n");
}

function parseKeys(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    map.set(t.slice(0, eq).trim(), t.slice(eq + 1));
  }
  return map;
}

const envRaw = fs.readFileSync(".env", "utf8");
const exRaw = fs.readFileSync(".env.example", "utf8");

// backup
fs.mkdirSync("logs", { recursive: true });
fs.writeFileSync("logs/env.bak", envRaw);
fs.writeFileSync("logs/env.example.bak", exRaw);

let envClean = transformContent(envRaw, { dedupe: true });
let exClean = transformContent(exRaw, { dedupe: true });

const envKeys = parseKeys(envClean);
const exKeys = parseKeys(exClean);

const missingInEnv = [...exKeys.keys()].filter((k) => !envKeys.has(k));
const extraInEnv = [...envKeys.keys()].filter((k) => !exKeys.has(k));

// Append missing keys to .env with example defaults (safe for non-secrets) or empty
if (missingInEnv.length) {
  const block = [
    "",
    "# --- synced from .env.example (were missing) ---",
    ...missingInEnv.map((k) => {
      const v = exKeys.get(k) ?? "";
      // don't copy secret-looking example values blindly except empty/defaults
      if (/(TOKEN|SECRET|PASSWORD|PASS|API_HASH|SESSION|KEY|LICENSE)/i.test(k) && v) {
        return `${k}=`;
      }
      return `${k}=${v}`;
    }),
    "",
  ];
  envClean = envClean.replace(/\n*$/, "\n") + block.join("\n");
}

// Append extra keys to .env.example as documented placeholders
if (extraInEnv.length) {
  const block = [
    "",
    "# =============================================================================",
    "# Extra keys present in local .env (synced for documentation)",
    "# =============================================================================",
    ...extraInEnv.map((k) => {
      if (/(TOKEN|SECRET|PASSWORD|PASS|API_HASH|SESSION|KEY|LICENSE)/i.test(k)) {
        return `${k}=`;
      }
      const v = envKeys.get(k) ?? "";
      // for URLs/emails with real hosts, keep structure but blank secrets already handled
      if (/^[^=]*@(gmail|yandex|mail)\./i.test(`${k}=${v}`)) return `${k}=`;
      // keep non-secret defaults if they look like flags/ports/urls localhost
      if (/^(true|false|\d+|https?:\/\/localhost[:/].*)$/i.test(v.trim())) return `${k}=${v.trim()}`;
      if (!v.trim()) return `${k}=`;
      // partner urls etc — blank in example
      if (/PARTNER_|CABINET_|SIP_|TG_|MAIL_|SMTP_|IMAP_/i.test(k) && !/^(true|false|\d+)$/i.test(v)) {
        return `${k}=`;
      }
      return `${k}=`;
    }),
    "",
  ];
  exClean = exClean.replace(/\n*$/, "\n") + block.join("\n");
}

fs.writeFileSync(".env", envClean);
fs.writeFileSync(".env.example", exClean);

const afterEnv = parseKeys(fs.readFileSync(".env", "utf8"));
const afterEx = parseKeys(fs.readFileSync(".env.example", "utf8"));
const stillMissing = [...afterEx.keys()].filter((k) => !afterEnv.has(k));
const stillExtra = [...afterEnv.keys()].filter((k) => !afterEx.has(k));

console.log(
  JSON.stringify(
    {
      backedUpTo: ["logs/env.bak", "logs/env.example.bak"],
      addedToEnv: missingInEnv,
      addedToExample: extraInEnv,
      envKeys: afterEnv.size,
      exampleKeys: afterEx.size,
      stillMissing,
      stillExtra,
      learning: afterEnv.get("LEARNING_ENABLED"),
      voicePort: afterEnv.get("VOICE_GATEWAY_PORT"),
      canary: afterEnv.get("CANARY_PCT"),
      companyStatus: afterEnv.get("COMPANY_STATUS"),
      sipBind: afterEnv.get("SIP_BIND_HOST"),
      allowMock: afterEnv.get("ALLOW_MOCK_RATES"),
    },
    null,
    2
  )
);
