import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRootEnv } from "./loadRootEnv";

function withTempEnv(fn: (root: string) => void): void {
  const prev = { ...process.env };
  const tmp = mkdtempSync(join(tmpdir(), "alo-env-"));
  try {
    writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
    fn(tmp);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in prev)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

function testDoesNotOverrideByDefault(): void {
  withTempEnv((tmp) => {
    writeFileSync(
      join(tmp, ".env"),
      "DATABASE_URL=postgresql://from-file:5434/db\nOTHER=from-file\n"
    );
    process.env.ALO_ROOT = tmp;
    process.env.DATABASE_URL = "postgresql://from-ci:5432/db";
    delete process.env.OTHER;

    loadRootEnv();

    assert.equal(process.env.DATABASE_URL, "postgresql://from-ci:5432/db");
    assert.equal(process.env.OTHER, "from-file");
  });
}

function testOverrideTrue(): void {
  withTempEnv((tmp) => {
    writeFileSync(join(tmp, ".env"), "DATABASE_URL=postgresql://from-file:5434/db\n");
    process.env.ALO_ROOT = tmp;
    process.env.DATABASE_URL = "postgresql://from-ci:5432/db";

    loadRootEnv({ override: true });

    assert.equal(process.env.DATABASE_URL, "postgresql://from-file:5434/db");
  });
}

testDoesNotOverrideByDefault();
testOverrideTrue();
console.log("loadRootEnv.test.ts: ok");
