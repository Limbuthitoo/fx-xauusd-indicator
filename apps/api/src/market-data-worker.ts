import { execFileSync } from "node:child_process";
import { config } from "./infrastructure/config.js";
import { startWorkerHeartbeat, writeWorkerHeartbeat } from "./infrastructure/workers/heartbeat.js";
import { reconcileActivePaperTradeLifecycles, startMarketDataWorker } from "./modules/market-data/routes.js";
import { startEconomicCalendarWorker } from "./modules/news/service.js";
import { refreshProductionSignalObservations } from "./modules/observations/service.js";

const startedAt = new Date().toISOString();

verifyPythonBrainRuntime();

startMarketDataWorker();
const economicCalendarTimers = startEconomicCalendarWorker();
const observationTimer = startProductionObservationWorker();
const paperLifecycleTimer = startPaperLifecycleWatchdog();
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
  clearInterval(observationTimer);
  clearInterval(paperLifecycleTimer);
  if (economicCalendarTimers) {
    clearTimeout(economicCalendarTimers.startupTimer);
    clearInterval(economicCalendarTimers.intervalTimer);
  }
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

function verifyPythonBrainRuntime() {
  const pythonBin = process.env.PYTHON_BIN || "python3";
  try {
    execFileSync(pythonBin, ["-c", "import psycopg"], { stdio: "ignore", timeout: 10_000 });
  } catch (error) {
    throw new Error(
      `Python brain runtime is unavailable (${pythonBin} cannot import psycopg): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function startProductionObservationWorker() {
  const run = () => refreshProductionSignalObservations({ days: 7 }).catch((error) => {
    console.error(JSON.stringify({
      level: "error",
      service: "production-signal-observer",
      message: "Production signal observation failed.",
      error: error instanceof Error ? error.message : String(error)
    }));
  });
  setTimeout(run, 30_000);
  return setInterval(run, 5 * 60_000);
}

function startPaperLifecycleWatchdog() {
  const run = () => reconcileActivePaperTradeLifecycles().catch((error) => {
    console.error(JSON.stringify({
      level: "error",
      service: "paper-lifecycle-watchdog",
      message: "Paper lifecycle reconciliation failed.",
      error: error instanceof Error ? error.message : String(error)
    }));
  });
  setTimeout(run, 5_000);
  return setInterval(run, 60_000);
}
