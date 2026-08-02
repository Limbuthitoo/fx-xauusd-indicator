import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool } from "./client.js";

async function main() {
  const migrationsDir = resolve(process.cwd(), "../../db/migrations");
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const migration = await readFile(resolve(migrationsDir, file), "utf8");
    await pool.query(migration);
    console.log(`Applied ${file}.`);
  }
  await pool.end();
  console.log("PostgreSQL migration complete.");
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
