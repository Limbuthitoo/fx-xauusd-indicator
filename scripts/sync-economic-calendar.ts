import { pool } from "../apps/api/src/infrastructure/db/client.js";
import { syncEconomicCalendar } from "../apps/api/src/modules/news/service.js";

try {
  const result = await syncEconomicCalendar();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "HEALTHY" && result.status !== "MANUAL") process.exitCode = 1;
} finally {
  await pool.end();
}
