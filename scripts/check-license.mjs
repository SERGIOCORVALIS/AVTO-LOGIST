#!/usr/bin/env node
/**
 * Foreground license check (used by start.ps1 / setup.ps1).
 * Loads CJS @alo/shared via require (Node ESM import() hides named CJS exports).
 * If the shared build has no enforceLicense, allow an active 12-month trial stamp.
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const TRIAL_MONTHS = 12;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
process.chdir(root);
process.env.ALO_ROOT = root;

function pickEnforce(mod) {
  if (!mod || typeof mod !== "object") return null;
  if (typeof mod.enforceLicense === "function") return mod.enforceLicense;
  if (mod.default && typeof mod.default.enforceLicense === "function") {
    return mod.default.enforceLicense;
  }
  return null;
}

function trialStillActive() {
  const stampPath = path.join(root, "data", ".alo_install.json");
  if (!fs.existsSync(stampPath)) return true;
  try {
    const { installedAt } = JSON.parse(fs.readFileSync(stampPath, "utf8"));
    const start = new Date(installedAt);
    if (Number.isNaN(start.getTime())) return true;
    const ends = new Date(start);
    ends.setMonth(ends.getMonth() + TRIAL_MONTHS);
    if (Date.now() <= ends.getTime()) {
      console.log(`[license] OK (trial until ${ends.toISOString()})`);
      return true;
    }
    console.error(`[license] Trial ended at ${ends.toISOString()}`);
    return false;
  } catch {
    return true;
  }
}

async function main() {
  const sharedJs = path.join(root, "packages", "shared", "dist", "license.js");
  const require = createRequire(import.meta.url);

  try {
    const mod = require(sharedJs);
    const enforceLicense = pickEnforce(mod);
    if (typeof enforceLicense === "function") {
      await enforceLicense({ service: "bootstrap", allowPrompt: true });
      console.log("[license] OK");
      return;
    }
    console.warn("[license] enforceLicense not exported from shared build, using trial stamp");
  } catch (err) {
    console.warn("[license] shared module not loaded:", err && err.message ? err.message : String(err));
  }

  if (trialStillActive()) return;
  console.error("Set LICENSE_KEY in .env or data/.alo_license");
  process.exit(1);
}

await main();
