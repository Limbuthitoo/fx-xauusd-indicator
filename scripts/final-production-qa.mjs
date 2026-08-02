import { execFileSync } from "node:child_process";

const checks = [
  ["TypeScript API", "npm", ["run", "typecheck", "--workspace", "apps/api"]],
  ["TypeScript Web", "npm", ["run", "typecheck", "--workspace", "apps/web"]],
  ["TypeScript Mobile", "npm", ["run", "typecheck", "--workspace", "apps/mobile"]],
  ["ORB scenario suite", "npm", ["run", "verify:orb"]],
  ["Production env template", "npm", ["run", "release:validate-env"]],
  ["Sensitive files", "npm", ["run", "release:check-sensitive"]]
];

const results = [];
for (const [name, command, args] of checks) {
  try {
    execFileSync(command, args, { stdio: "pipe" });
    results.push({ name, status: "PASS" });
  } catch (error) {
    results.push({ name, status: "FAIL", error: String(error.stderr || error.message).slice(0, 1200) });
  }
}

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
if (results.some((result) => result.status === "FAIL")) process.exit(1);
