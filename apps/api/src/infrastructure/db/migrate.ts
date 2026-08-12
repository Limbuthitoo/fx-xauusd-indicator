import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool } from "./client.js";

async function main() {
  const migrationsDir = resolve(process.cwd(), "../../db/migrations");
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock(hashtext('orb-guide-schema-migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        checksum_sha256 TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        execution_ms INTEGER NOT NULL DEFAULT 0
      )
    `);

    const applied = await client.query<{ filename: string; checksum_sha256: string }>(
      "SELECT filename, checksum_sha256 FROM schema_migrations"
    );
    const appliedByFilename = new Map(applied.rows.map((row) => [row.filename, row.checksum_sha256]));

    if (appliedByFilename.size === 0) {
      const existingSchema = await client.query<{ exists: boolean }>(
        "SELECT to_regclass('public.instruments') IS NOT NULL AS exists"
      );
      if (existingSchema.rows[0]?.exists) {
        const baseline = process.env.DATABASE_MIGRATION_BASELINE?.trim();
        if (!baseline || !files.includes(baseline)) {
          throw new Error(
            "Existing schema has no migration ledger. Set DATABASE_MIGRATION_BASELINE to the last migration already applied (for example 079_historical_strategy_validation.sql)."
          );
        }

        const baselineIndex = files.indexOf(baseline);
        await client.query("BEGIN");
        try {
          for (const file of files.slice(0, baselineIndex + 1)) {
            const migration = await readFile(resolve(migrationsDir, file), "utf8");
            const checksum = createHash("sha256").update(migration).digest("hex");
            await client.query(
              `INSERT INTO schema_migrations (filename, checksum_sha256, execution_ms)
               VALUES ($1, $2, 0)`,
              [file, checksum]
            );
            appliedByFilename.set(file, checksum);
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
        console.log(`Baselined existing schema through ${baseline}.`);
      }
    }

    for (const file of files) {
      const migration = await readFile(resolve(migrationsDir, file), "utf8");
      const checksum = createHash("sha256").update(migration).digest("hex");
      const recordedChecksum = appliedByFilename.get(file);

      if (recordedChecksum) {
        if (recordedChecksum !== checksum) {
          throw new Error(`Migration checksum mismatch for ${file}. Create a new migration instead of editing applied history.`);
        }
        console.log(`Skipped ${file}; already applied.`);
        continue;
      }

      const startedAt = Date.now();
      await client.query("BEGIN");
      try {
        await client.query(migration);
        await client.query(
          `INSERT INTO schema_migrations (filename, checksum_sha256, execution_ms)
           VALUES ($1, $2, $3)`,
          [file, checksum, Date.now() - startedAt]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      console.log(`Applied ${file}.`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('orb-guide-schema-migrations'))").catch(() => undefined);
    client.release();
  }

  await pool.end();
  console.log("PostgreSQL migration complete.");
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
