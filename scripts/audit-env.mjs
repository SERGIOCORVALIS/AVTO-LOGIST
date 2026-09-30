import fs from "fs";

function parse(path) {
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
  const keys = new Map();
  const dups = [];
  const bad = [];
  let section = "(top)";
  lines.forEach((line, i) => {
    const n = i + 1;
    const t = line.trim();
    if (!t) return;
    if (t.startsWith("#")) {
      const m = t.match(/^#+\s*(.+)$/);
      if (m) section = m[1].slice(0, 80);
      return;
    }
    const eq = t.indexOf("=");
    if (eq < 0) {
      bad.push({ n, line: t.slice(0, 80), why: "no_equals" });
      return;
    }
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1);
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (keys.has(key)) dups.push({ key, first: keys.get(key).n, second: n });
    keys.set(key, { n, val, section });
  });
  return { keys, dups, bad, lines: lines.length };
}

function isPlaceholder(v) {
  if (v == null) return true;
  const s = String(v).trim();
  if (!s) return true;
  return /CHANGE_ME|YOUR_|xxx+|TODO|REPLACE|<.*>|example\.com|password_here|insert_|paste_|ЗАПОЛНИ|скинь/i.test(
    s
  );
}

const ex = parse(".env.example");
const en = parse(".env");
const exKeys = [...ex.keys.keys()];
const enKeys = [...en.keys.keys()];
const missingInEnv = exKeys.filter((k) => !en.keys.has(k));
const extraInEnv = enKeys.filter((k) => !ex.keys.has(k));

const emptyOrPlaceholder = [];
for (const [k, info] of en.keys) {
  if (isPlaceholder(info.val)) {
    emptyOrPlaceholder.push({
      key: k,
      section: info.section,
      empty: !String(info.val || "").trim(),
    });
  }
}

const formatIssues = [];
function checkUrl(k) {
  const info = en.keys.get(k);
  if (!info) return;
  const v = info.val.trim();
  if (!v || isPlaceholder(v)) return;
  try {
    // eslint-disable-next-line no-new
    new URL(v);
  } catch {
    formatIssues.push({ key: k, why: "invalid_url" });
  }
}
["API_URL", "ORCHESTRATOR_URL", "VOICE_GATEWAY_URL", "DATABASE_URL", "REDIS_URL"].forEach(
  checkUrl
);

for (const k of [
  "MAIL_SYNC_ENABLED",
  "GOOGLE_CALENDAR_ENABLED",
  "TG_STRICT_HOURS",
  "LEARNING_ENABLED",
]) {
  const info = en.keys.get(k);
  if (!info || !info.val.trim()) continue;
  if (!/^(true|false|0|1)$/i.test(info.val.trim())) {
    formatIssues.push({ key: k, why: "not_bool" });
  }
}

for (const k of [
  "API_PORT",
  "VOICE_GATEWAY_PORT",
  "SIP_PORT",
  "TG_API_ID",
  "MAIL_SYNC_INTERVAL_MS",
  "SIP_RTP_PORT_MIN",
  "SIP_RTP_PORT_MAX",
]) {
  const info = en.keys.get(k);
  if (!info || !info.val.trim() || isPlaceholder(info.val)) continue;
  if (!/^-?\d+(\.\d+)?$/.test(info.val.trim())) {
    formatIssues.push({ key: k, why: "not_number" });
  }
}

// chat ids often like -100...
for (const k of ["TG_EXEC_CHANNEL_ID", "TG_ESCALATION_CHAT_ID"]) {
  const info = en.keys.get(k);
  if (!info || !info.val.trim() || isPlaceholder(info.val)) continue;
  if (!/^-?\d+$/.test(info.val.trim())) {
    formatIssues.push({ key: k, why: "chat_id_should_be_numeric" });
  }
}

const critical = [
  "DATABASE_URL",
  "REDIS_URL",
  "TG_BOT_TOKEN",
  "TG_EXEC_CHANNEL_ID",
  "LICENSE_KEY",
  "OPENAI_API_KEY",
  "API_URL",
  "ORCHESTRATOR_URL",
];
const criticalStatus = critical.map((k) => {
  const info = en.keys.get(k);
  if (!info) return { key: k, status: "missing" };
  if (isPlaceholder(info.val)) return { key: k, status: "empty_or_placeholder" };
  return { key: k, status: "set", len: String(info.val).length };
});

// value drift for non-secret shared defaults (ports/urls)
const sharedCompare = [];
for (const k of [
  "API_PORT",
  "VOICE_GATEWAY_PORT",
  "SIP_PORT",
  "API_URL",
  "ORCHESTRATOR_URL",
  "VOICE_GATEWAY_URL",
  "REDIS_URL",
  "DATABASE_URL",
  "QUEUES",
]) {
  const a = ex.keys.get(k);
  const b = en.keys.get(k);
  if (!a || !b) continue;
  if (a.val !== b.val) {
    sharedCompare.push({
      key: k,
      example: a.val,
      env: looksSecret(k) ? `[set len=${b.val.length}]` : b.val,
    });
  }
}

function looksSecret(k) {
  return /(TOKEN|SECRET|PASSWORD|PASS|API_HASH|SESSION|KEY|PRIVATE|DATABASE_URL|REDIS_URL)/i.test(
    k
  );
}

const out = {
  exampleKeys: exKeys.length,
  envKeys: enKeys.length,
  missingInEnv,
  extraInEnv,
  duplicatesEnv: en.dups,
  duplicatesExample: ex.dups,
  badLinesEnv: en.bad,
  badLinesExample: ex.bad,
  formatIssues,
  emptyOrPlaceholderCount: emptyOrPlaceholder.length,
  emptyOrPlaceholder,
  criticalStatus,
  sharedCompare,
};

fs.mkdirSync("logs", { recursive: true });
fs.writeFileSync("logs/env-audit.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
