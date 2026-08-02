import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../../infrastructure/config.js";

const execFileAsync = promisify(execFile);

export async function runOrbLearningPython() {
  const { stdout } = await execFileAsync("python3", ["-m", "apps.quant.app.learning.orb_learning", "--database-url", config.databaseUrl], {
    cwd: process.cwd().replace(/\/apps\/api$/, ""),
    timeout: 120_000
  });
  return JSON.parse(stdout);
}

export async function runModule2LearningPython(tenantId: string) {
  const { stdout } = await execFileAsync(
    "python3",
    ["-m", "apps.quant.app.learning.module2_learning", "--database-url", config.databaseUrl, "--tenant-id", tenantId],
    {
      cwd: process.cwd().replace(/\/apps\/api$/, ""),
      timeout: 120_000
    }
  );
  return JSON.parse(stdout);
}

export async function runModule3LearningPython(tenantId: string) {
  const { stdout } = await execFileAsync(
    "python3",
    ["-m", "apps.quant.app.learning.module3_learning", "--database-url", config.databaseUrl, "--tenant-id", tenantId],
    {
      cwd: process.cwd().replace(/\/apps\/api$/, ""),
      timeout: 120_000
    }
  );
  return JSON.parse(stdout);
}
