/**
 * Run: pnpm --filter @alo/api test
 */
import {
  cabinetAuthRequired,
  hasFileTariffChannels,
  hasPartnerChannels,
  listActiveTariffFiles,
  resolveJwtSecret,
} from "./bootGuard";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const saved = { ...process.env };

function restoreEnv() {
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) delete process.env[k];
  }
  Object.assign(process.env, saved);
}

function testResolveJwtDev() {
  restoreEnv();
  process.env.ALO_ENV = "development";
  process.env.NODE_ENV = "development";
  delete process.env.JWT_SECRET;
  const s = resolveJwtSecret();
  assert(s.includes("dev-transinvest"), "dev fallback jwt");
}

function testResolveJwtProdFails() {
  restoreEnv();
  process.env.ALO_ENV = "production";
  delete process.env.JWT_SECRET;
  let threw = false;
  try {
    resolveJwtSecret();
  } catch {
    threw = true;
  }
  assert(threw, "prod must require JWT_SECRET");
}

function testCabinetAuthProdDefault() {
  restoreEnv();
  process.env.ALO_ENV = "production";
  delete process.env.CABINET_AUTH_REQUIRED;
  delete process.env.ALLOW_INSECURE_CABINET;
  assert(cabinetAuthRequired() === true, "prod default auth on");
}

function testCabinetAuthProdBlockOff() {
  restoreEnv();
  process.env.ALO_ENV = "production";
  process.env.CABINET_AUTH_REQUIRED = "false";
  delete process.env.ALLOW_INSECURE_CABINET;
  let threw = false;
  try {
    cabinetAuthRequired();
  } catch {
    threw = true;
  }
  assert(threw, "prod blocks auth off");
}

function testFileTariffsPresent() {
  restoreEnv();
  process.env.ALLOW_FILE_TARIFFS = "true";
  const files = listActiveTariffFiles();
  assert(files.length >= 3, `expected baseline tariffs, got ${files.join(",")}`);
  assert(hasFileTariffChannels(), "file tariffs channel");
  assert(hasPartnerChannels(), "partner channels via files");
}

testResolveJwtDev();
testResolveJwtProdFails();
testCabinetAuthProdDefault();
testCabinetAuthProdBlockOff();
testFileTariffsPresent();
restoreEnv();
console.log("bootGuard.test.ts: ok");
