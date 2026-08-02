import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool } from "./client.js";

async function main() {
  const seed = await readFile(resolve(process.cwd(), "../../db/seeds/001_research_defaults.sql"), "utf8");
  await pool.query(seed);
  await pool.end();
  console.log("Research defaults seeded.");
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
