import { existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
const trackedForbidden = tracked.filter((file) =>
  file === ".env" ||
  /^backups\/postgres\/.+\.dump$/.test(file) ||
  /(^|\/)(firebase-service-account|service-account).+\.json$/.test(file)
);
if (trackedForbidden.length > 0) {
  console.error("Forbidden sensitive files are tracked:");
  for (const file of trackedForbidden) console.error(`- ${file}`);
  process.exit(1);
}

const forbidden = [];
if (existsSync(".env")) forbidden.push(".env");
for (const file of [".env.production", "firebase-service-account.json", "service-account.json"]) {
  if (existsSync(file)) forbidden.push(file);
}
if (existsSync("backups/postgres")) {
  for (const file of readdirSync("backups/postgres")) {
    if (file.endsWith(".dump")) forbidden.push(join("backups/postgres", file));
  }
}

const oversized = [];
for (const file of forbidden) {
  if (existsSync(file) && statSync(file).size > 0) oversized.push(file);
}

if (forbidden.length > 0) {
  console.log(JSON.stringify({
    status: "CHECKED",
    note: "These files may exist locally but must remain ignored/untracked.",
    files: forbidden,
    nonEmptyLocalFiles: oversized
  }, null, 2));
}
