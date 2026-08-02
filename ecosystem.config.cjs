module.exports = {
  apps: [
    {
      name: "xauusd-api",
      cwd: __dirname,
      script: "apps/api/dist/server.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        API_PORT: process.env.API_PORT || "7073",
        EMBEDDED_MARKET_DATA_WORKER: "false"
      },
      max_memory_restart: "700M",
      kill_timeout: 10000,
      listen_timeout: 10000,
      exp_backoff_restart_delay: 5000,
      out_file: "logs/api.out.log",
      error_file: "logs/api.err.log",
      merge_logs: true
    },
    {
      name: "xauusd-worker",
      cwd: __dirname,
      script: "apps/api/dist/market-data-worker.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        EMBEDDED_MARKET_DATA_WORKER: "false"
      },
      max_memory_restart: "700M",
      kill_timeout: 10000,
      listen_timeout: 10000,
      exp_backoff_restart_delay: 5000,
      out_file: "logs/worker.out.log",
      error_file: "logs/worker.err.log",
      merge_logs: true
    },
    {
      name: "xauusd-web",
      cwd: __dirname,
      script: "node_modules/vite/bin/vite.js",
      args: "preview --host 0.0.0.0 --port 3000",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production"
      },
      max_memory_restart: "350M",
      kill_timeout: 10000,
      exp_backoff_restart_delay: 5000,
      out_file: "logs/web.out.log",
      error_file: "logs/web.err.log",
      merge_logs: true
    }
  ]
};
