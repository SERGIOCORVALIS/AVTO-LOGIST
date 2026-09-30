import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../..");
const SERVICES = join(REPO_ROOT, "services");

function pythonBin(): string {
  const win = process.platform === "win32";
  const py = join(SERVICES, ".venv", win ? "Scripts" : "bin", win ? "python.exe" : "python");
  if (!existsSync(py)) {
    throw new Error(`Python venv not found: ${py}`);
  }
  return py;
}

export async function runAssociationsUpdateJob(data: {
  run_id: string;
  staff_id?: string | null;
  triggered_by?: string;
}): Promise<void> {
  const py = pythonBin();
  const args = [
    "-m",
    "agents.run_association_update",
    "--run-id",
    data.run_id,
    "--triggered-by",
    data.triggered_by ?? "manual",
  ];
  if (data.staff_id) {
    args.push("--staff-id", data.staff_id);
  }

  await new Promise<void>((resolvePromise, reject) => {
    const proc = spawn(py, args, {
      cwd: SERVICES,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || `associations update exited ${code}`));
    });
  });
}
