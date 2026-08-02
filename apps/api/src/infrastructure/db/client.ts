import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.databasePoolMax,
  connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
  idleTimeoutMillis: config.databaseIdleTimeoutMs,
  statement_timeout: config.databaseStatementTimeoutMs,
  query_timeout: config.databaseQueryTimeoutMs
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) {
  const result = await pool.query<T>(text, params);
  return result;
}

export function poolStats() {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: config.databasePoolMax
  };
}
