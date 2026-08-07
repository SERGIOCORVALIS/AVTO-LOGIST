/**
 * Preload secrets before Node apps start.
 * Supports Doppler CLI when DOPPLER_TOKEN is set or doppler.yaml exists.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function applyEnvText(text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
}

function loadDoppler() {
  const hasToken = !!process.env.DOPPLER_TOKEN;
  const hasYaml = fs.existsSync(path.join(root, "doppler.yaml"));
  if (!hasToken && !hasYaml) return false;
  const r = spawnSync(
    "doppler",
    ["secrets", "download", "--no-file", "--format", "env"],
    { cwd: root, encoding: "utf8" }
  );
  if (r.status === 0 && r.stdout) {
    applyEnvText(r.stdout);
    return true;
  }
  return false;
}

try {
  require("dotenv").config({ path: path.join(root, ".env") });
} catch {
  /* optional */
}

const usedDoppler = loadDoppler();
if (usedDoppler) {
  console.log("[secrets] loaded from Doppler");
}

module.exports = { loadDoppler };
