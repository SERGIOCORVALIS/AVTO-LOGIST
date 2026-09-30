import fs from "fs";
import net from "net";
import { spawnSync } from "child_process";

function loadEnv(path = ".env") {
  const out = {};
  for (const line of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1);
  }
  return out;
}

function parseHostPort(url, fallbackHost, fallbackPort) {
  try {
    const u = new URL(url);
    return { host: u.hostname || fallbackHost, port: Number(u.port || fallbackPort) };
  } catch {
    return { host: fallbackHost, port: fallbackPort };
  }
}

function canConnect(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => {
      try {
        sock.destroy();
      } catch {}
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

const env = loadEnv();
const checks = [];

function add(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "OK" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

add("LEARNING_ENABLED is bool", /^(true|false)$/i.test(env.LEARNING_ENABLED || ""), env.LEARNING_ENABLED);
add("VOICE_GATEWAY_PORT is number", /^\d+$/.test(env.VOICE_GATEWAY_PORT || ""), env.VOICE_GATEWAY_PORT);
add("CANARY_PCT present", Boolean(env.CANARY_PCT), env.CANARY_PCT);
add("COMPANY_STATUS present", Boolean(env.COMPANY_STATUS), env.COMPANY_STATUS);
add("DATABASE_URL set", Boolean(env.DATABASE_URL));
add("REDIS_URL set", Boolean(env.REDIS_URL));
add("OPENAI_API_KEY set", Boolean(env.OPENAI_API_KEY));
add("TG_BOT_TOKEN set", Boolean(env.TG_BOT_TOKEN));

const db = parseHostPort(env.DATABASE_URL || "postgresql://localhost:5432", "localhost", 5432);
const redis = parseHostPort(env.REDIS_URL || "redis://localhost:6379", "localhost", 6379);
const api = parseHostPort(env.API_URL || "http://localhost:3000", "localhost", 3000);
const orch = parseHostPort(env.ORCHESTRATOR_URL || "http://localhost:8000", "localhost", 8000);

const tcp = await Promise.all([
  canConnect(db.host, db.port),
  canConnect(redis.host, redis.port),
  canConnect(api.host, api.port),
  canConnect(orch.host, orch.port),
]);
add(`Postgres ${db.host}:${db.port}`, tcp[0]);
add(`Redis ${redis.host}:${redis.port}`, tcp[1]);
add(`API ${api.host}:${api.port}`, tcp[2]);
add(`Orchestrator ${orch.host}:${orch.port}`, tcp[3]);

const py = spawnSync(
  ".venv\\Scripts\\python.exe",
  [
    "-m",
    "pytest",
    "tests/test_business_logic.py",
    "tests/test_agents.py",
    "tests/test_hours_py.py",
    "tests/test_voice.py",
    "-q",
    "--tb=line",
  ],
  { cwd: "services", encoding: "utf8", shell: true }
);
const pyOk = py.status === 0;
add("Python unit tests", pyOk, (py.stdout || py.stderr || "").trim().split(/\r?\n/).slice(-3).join(" | "));

const tg = spawnSync("pnpm", ["--filter", "@alo/tg-gateway", "test"], {
  encoding: "utf8",
  shell: true,
});
add("tg-gateway tests", tg.status === 0, (tg.stdout || "").trim().split(/\r?\n/).slice(-2).join(" | "));

const failed = checks.filter((c) => !c.ok).length;
console.log(`\nSummary: ${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
