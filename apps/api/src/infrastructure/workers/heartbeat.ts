import { query } from "../db/client.js";

export type WorkerHeartbeatStatus = "STARTING" | "RUNNING" | "STOPPING" | "STOPPED" | "ERROR";

type WorkerHeartbeatInput = {
  workerName: string;
  status: WorkerHeartbeatStatus;
  startedAt?: string | null;
  metadata?: Record<string, unknown>;
  lastError?: string | null;
};

export async function writeWorkerHeartbeat(input: WorkerHeartbeatInput) {
  await query(
    `INSERT INTO worker_heartbeats (
       worker_name,
       status,
       started_at,
       heartbeat_at,
       pid,
       metadata,
       last_error
     )
     VALUES ($1, $2, $3, now(), $4, $5::jsonb, $6)
     ON CONFLICT (worker_name) DO UPDATE SET
       status = EXCLUDED.status,
       started_at = COALESCE(EXCLUDED.started_at, worker_heartbeats.started_at),
       heartbeat_at = now(),
       pid = EXCLUDED.pid,
       metadata = EXCLUDED.metadata,
       last_error = EXCLUDED.last_error`,
    [
      input.workerName,
      input.status,
      input.startedAt ?? null,
      process.pid,
      JSON.stringify(input.metadata ?? {}),
      input.lastError ?? null
    ]
  );
}

export function startWorkerHeartbeat(input: WorkerHeartbeatInput, intervalMs = 15_000) {
  void writeWorkerHeartbeat(input).catch((error) => {
    console.error(JSON.stringify({
      level: "error",
      service: input.workerName,
      message: "Worker heartbeat write failed.",
      error: (error as Error).message
    }));
  });

  const timer = setInterval(() => {
    void writeWorkerHeartbeat({ ...input, status: "RUNNING" }).catch((error) => {
      console.error(JSON.stringify({
        level: "error",
        service: input.workerName,
        message: "Worker heartbeat write failed.",
        error: (error as Error).message
      }));
    });
  }, intervalMs);

  return timer;
}
