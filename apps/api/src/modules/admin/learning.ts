import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../../infrastructure/config.js";
import { redactSensitiveText } from "../../infrastructure/security/redaction.js";

const execFileAsync = promisify(execFile);
const pythonBin = process.env.PYTHON_BIN || "python3";
const pythonCwd = process.cwd().replace(/\/apps\/api$/, "");

export async function runOrbLearningPython(tenantId: string) {
  return runPythonJson(["-m", "apps.quant.app.learning.orb_learning", "--database-url", config.databaseUrl, "--tenant-id", tenantId], 120_000);
}

export async function runModule2LearningPython(tenantId: string) {
  return runPythonJson(
    ["-m", "apps.quant.app.learning.module2_learning", "--database-url", config.databaseUrl, "--tenant-id", tenantId],
    120_000
  );
}

export async function runGenericModuleLearningPython(tenantId: string, moduleCode: string) {
  return runPythonJson(
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
    120_000
  );
}

export async function runStrategyModuleLearningPython(tenantId: string, moduleCode: string) {
  if (moduleCode === "high_probability_strategy_2") {
    return runModule2LearningPython(tenantId);
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
  return runPythonJson(args, 120_000);
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
  return runPythonJson(args, 180_000);
}

export async function runMainBrainPython(tenantId: string, moduleCode?: string, options?: { proofMode?: boolean; setupId?: string }) {
  const args = [
    "-m",
    "apps.quant.app.brain.main_brain",
    "--database-url",
    config.databaseUrl,
    "--tenant-id",
    tenantId
  ];
  if (moduleCode) args.push("--module-code", moduleCode);
  if (options?.proofMode) args.push("--proof-mode");
  if (options?.setupId) args.push("--setup-id", options.setupId);
  return runPythonJson(args, 60_000);
}

async function runPythonJson(args: string[], timeout: number) {
  try {
    const { stdout } = await execFileAsync(pythonBin, args, { cwd: pythonCwd, timeout });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(redactSensitiveText(error, [config.databaseUrl, config.redisUrl]));
  }
}
