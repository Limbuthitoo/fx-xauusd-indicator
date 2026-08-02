import { config } from "./infrastructure/config.js";
import { startWorkerHeartbeat, writeWorkerHeartbeat } from "./infrastructure/workers/heartbeat.js";
import { startMarketDataWorker } from "./modules/market-data/routes.js";

const startedAt = new Date().toISOString();

startMarketDataWorker();
const heartbeatTimer = startWorkerHeartbeat({
  workerName: "market-data-worker",
  status: "RUNNING",
  startedAt,
  metadata: {
    supervisorSeconds: config.autoRunSupervisorSeconds,
    embeddedApiWorker: config.embeddedMarketDataWorker,
    provider: "TWELVE_DATA",
    symbol: config.twelveDataSymbol,
    interval: config.twelveDataInterval
  }
});

console.log(JSON.stringify({
  level: "info",
  service: "market-data-worker",
  message: "Market-data worker started.",
  supervisorSeconds: config.autoRunSupervisorSeconds,
  embeddedApiWorker: config.embeddedMarketDataWorker
}));

async function shutdown(signal: string) {
  clearInterval(heartbeatTimer);
  await writeWorkerHeartbeat({
    workerName: "market-data-worker",
    status: "STOPPING",
    startedAt,
    metadata: {
      signal,
      supervisorSeconds: config.autoRunSupervisorSeconds,
      embeddedApiWorker: config.embeddedMarketDataWorker,
      provider: "TWELVE_DATA",
      symbol: config.twelveDataSymbol,
      interval: config.twelveDataInterval
    }
  }).catch((error) => {
    console.error(JSON.stringify({
      level: "error",
      service: "market-data-worker",
      message: "Worker shutdown heartbeat failed.",
      error: (error as Error).message
    }));
  });
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
