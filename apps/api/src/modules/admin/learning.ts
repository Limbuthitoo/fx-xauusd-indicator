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

export async function runGenericModuleLearningPython(tenantId: string, moduleCode: string) {
  const { stdout } = await execFileAsync(
    "python3",
    [
      "-m",
      "apps.quant.app.learning.generic_module_learning",
      "--database-url",
      config.databaseUrl,
      "--tenant-id",
      tenantId,
      "--module-code",
      moduleCode
    ],
    {
      cwd: process.cwd().replace(/\/apps\/api$/, ""),
      timeout: 120_000
    }
  );
  return JSON.parse(stdout);
}

export async function runStrategyModuleLearningPython(tenantId: string, moduleCode: string) {
  if (moduleCode === "high_probability_strategy_2") {
    return runModule2LearningPython(tenantId);
  }
  if (moduleCode === "strategy_lab_3") {
    return runModule3LearningPython(tenantId);
  }
  return runGenericModuleLearningPython(tenantId, moduleCode);
}

export async function runStrategyIndicatorAuditPython(tenantId: string, moduleCode?: string) {
  const args = [
    "-m",
    "apps.quant.app.learning.strategy_indicator_audit",
    "--database-url",
    config.databaseUrl,
    "--tenant-id",
    tenantId
  ];
  if (moduleCode) args.push("--module-code", moduleCode);
  const { stdout } = await execFileAsync("python3", args, {
    cwd: process.cwd().replace(/\/apps\/api$/, ""),
    timeout: 120_000
  });
  return JSON.parse(stdout);
}

export async function runDeterministicStrategyCoachPython(tenantId: string, moduleCode?: string) {
  const args = [
    "-m",
    "apps.quant.app.learning.deterministic_strategy_coach",
    "--database-url",
    config.databaseUrl,
    "--tenant-id",
    tenantId
  ];
  if (moduleCode) args.push("--module-code", moduleCode);
  const { stdout } = await execFileAsync("python3", args, {
    cwd: process.cwd().replace(/\/apps\/api$/, ""),
    timeout: 180_000
  });
  return JSON.parse(stdout);
}

export async function runMainBrainPython(tenantId: string, moduleCode?: string) {
  const args = [
    "-m",
    "apps.quant.app.brain.main_brain",
    "--database-url",
    config.databaseUrl,
    "--tenant-id",
    tenantId
  ];
  if (moduleCode) args.push("--module-code", moduleCode);
  const { stdout } = await execFileAsync("python3", args, {
    cwd: process.cwd().replace(/\/apps\/api$/, ""),
    timeout: 60_000
  });
  return JSON.parse(stdout);
}
