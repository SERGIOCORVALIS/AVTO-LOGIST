/**
 * Load monorepo-root .env into process.env (ALL keys).
 * Prefer ALO_ROOT when set (start.ps1); else walk up to pnpm-workspace / .env.
 * No external dotenv dependency — parses KEY=VALUE itself.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (
      existsSync(resolve(dir, "pnpm-workspace.yaml")) ||
      existsSync(resolve(dir, ".env"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1);
    if (!/^["']/.test(val.trim()) && /\s+#/.test(val)) {
      val = val.replace(/\s+#.*$/, "");
    }
    val = val.trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function loadRootEnv(opts?: { override?: boolean }): string {
  const fromEnv = (process.env.ALO_ROOT || "").trim();
  const start =
    fromEnv ||
    (typeof __dirname !== "undefined" ? resolve(__dirname, "../../..") : process.cwd());
  const root = fromEnv ? resolve(fromEnv) : findRepoRoot(start);
  const envPath = resolve(root, ".env");
  const override = opts?.override ?? true;
  if (existsSync(envPath)) {
    const parsed = parseEnvFile(readFileSync(envPath, "utf8"));
    for (const [k, v] of Object.entries(parsed)) {
      if (!override && process.env[k] !== undefined) continue;
      process.env[k] = v;
    }
  }
  process.env.ALO_ROOT = root;
  return envPath;
}
