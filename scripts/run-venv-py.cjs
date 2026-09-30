#!/usr/bin/env node
/** Cross-platform: run services/.venv python with args. */
const { spawnSync } = require("child_process");
const { existsSync } = require("fs");
const { join } = require("path");

const root = join(__dirname, "..");
const win = process.platform === "win32";
const py = join(root, "services", ".venv", win ? "Scripts" : "bin", win ? "python.exe" : "python");
if (!existsSync(py)) {
  console.error("[run-venv-py] missing venv python:", py);
  process.exit(1);
}
const r = spawnSync(py, process.argv.slice(2), { stdio: "inherit", cwd: join(root, "services") });
process.exit(r.status ?? 1);
