import fs from "fs";
import path from "path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function rootDir() {
  if (process.env.LOG_DIR) return process.env.LOG_DIR;
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, "logs"),
    path.resolve(cwd, "../../logs"),
    path.resolve(cwd, "../logs"),
  ];
  for (const c of candidates) {
    const parent = path.dirname(c);
    if (
      fs.existsSync(path.join(parent, "pnpm-workspace.yaml")) ||
      fs.existsSync(path.join(parent, "package.json"))
    ) {
      return c;
    }
  }
  return path.resolve(cwd, "logs");
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function dayStamp(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function minLevel(): LogLevel {
  const v = (process.env.LOG_LEVEL || "info").toLowerCase();
  if (v === "debug" || v === "warn" || v === "error") return v;
  return "info";
}

export function createLogger(service: string) {
  const base = path.join(rootDir(), service);
  ensureDir(base);
  const dayFile = path.join(base, `${dayStamp()}.log`);
  const current = path.join(base, "current.log");

  const write = (level: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel()]) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      service,
      level,
      msg,
      ...(meta || {}),
    });
    try {
      fs.appendFileSync(dayFile, line + "\n");
      fs.appendFileSync(current, line + "\n");
    } catch {
      // ignore disk errors in logger
    }
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(`[${service}] ${level}: ${msg}`, meta || "");
  };

  return {
    debug: (msg: string, meta?: Record<string, unknown>) => write("debug", msg, meta),
    info: (msg: string, meta?: Record<string, unknown>) => write("info", msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => write("warn", msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) => write("error", msg, meta),
    audit: (msg: string, meta?: Record<string, unknown>) => {
      const auditDir = path.join(rootDir(), "audit");
      ensureDir(auditDir);
      const aDay = path.join(auditDir, `${dayStamp()}.log`);
      const aCur = path.join(auditDir, "current.log");
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        service,
        level: "audit",
        msg,
        ...(meta || {}),
      });
      try {
        fs.appendFileSync(aDay, line + "\n");
        fs.appendFileSync(aCur, line + "\n");
      } catch {
        /* ignore */
      }
      write("info", msg, { audit: true, ...meta });
    },
  };
}

export function ensureLogTree() {
  for (const s of ["api", "gateway", "workers", "orchestrator", "bootstrap", "audit"]) {
    ensureDir(path.join(rootDir(), s));
  }
}
