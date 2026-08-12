CREATE TABLE IF NOT EXISTS strategy_validation_datasets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL UNIQUE,
  symbol TEXT NOT NULL REFERENCES instruments(symbol),
  source TEXT NOT NULL,
  timeframe_minutes INTEGER NOT NULL DEFAULT 5 CHECK (timeframe_minutes > 0),
  status TEXT NOT NULL DEFAULT 'IMPORTING' CHECK (status IN ('IMPORTING', 'READY', 'ARCHIVED', 'FAILED')),
  candle_count INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  start_at TIMESTAMPTZ,
  end_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strategy_validation_candles (
  dataset_id UUID NOT NULL REFERENCES strategy_validation_datasets(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL REFERENCES instruments(symbol),
  timeframe_minutes INTEGER NOT NULL CHECK (timeframe_minutes > 0),
  timestamp_utc TIMESTAMPTZ NOT NULL,
  open NUMERIC(18, 5) NOT NULL,
  high NUMERIC(18, 5) NOT NULL,
  low NUMERIC(18, 5) NOT NULL,
  close NUMERIC(18, 5) NOT NULL,
  volume NUMERIC(18, 4),
  spread NUMERIC(18, 5),
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (dataset_id, timeframe_minutes, timestamp_utc),
  CHECK (open > 0 AND high > 0 AND low > 0 AND close > 0),
  CHECK (high >= open AND high >= close AND high >= low),
  CHECK (low <= open AND low <= close)
);

CREATE INDEX IF NOT EXISTS strategy_validation_candles_lookup_idx
  ON strategy_validation_candles(dataset_id, timestamp_utc);

CREATE TABLE IF NOT EXISTS strategy_validation_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dataset_id UUID NOT NULL REFERENCES strategy_validation_datasets(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  train_ratio NUMERIC(5, 4) NOT NULL DEFAULT 0.7000 CHECK (train_ratio > 0 AND train_ratio < 1),
  train_start_date DATE,
  train_end_date DATE,
  validation_start_date DATE,
  validation_end_date DATE,
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS strategy_validation_runs_dataset_idx
  ON strategy_validation_runs(dataset_id, started_at DESC);

CREATE TABLE IF NOT EXISTS strategy_validation_signals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id UUID NOT NULL REFERENCES strategy_validation_runs(id) ON DELETE CASCADE,
  partition TEXT NOT NULL CHECK (partition IN ('TRAIN', 'VALIDATION')),
  module_code TEXT NOT NULL REFERENCES platform_strategy_modules(code),
  profile_code TEXT NOT NULL,
  thesis_key TEXT NOT NULL,
  session_date DATE NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  scenario TEXT NOT NULL,
  entry_price NUMERIC(18, 5) NOT NULL,
  stop_price NUMERIC(18, 5) NOT NULL,
  target_price NUMERIC(18, 5) NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('WIN', 'LOSS', 'OPEN', 'BREAKEVEN')),
  result_r NUMERIC(12, 4),
  ambiguous BOOLEAN NOT NULL DEFAULT false,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, module_code, thesis_key)
);

CREATE INDEX IF NOT EXISTS strategy_validation_signals_metrics_idx
  ON strategy_validation_signals(run_id, partition, module_code, profile_code, detected_at);

CREATE TABLE IF NOT EXISTS strategy_validation_metrics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id UUID NOT NULL REFERENCES strategy_validation_runs(id) ON DELETE CASCADE,
  partition TEXT NOT NULL CHECK (partition IN ('TRAIN', 'VALIDATION')),
  module_code TEXT NOT NULL REFERENCES platform_strategy_modules(code),
  profile_code TEXT NOT NULL,
  sessions INTEGER NOT NULL DEFAULT 0,
  signal_count INTEGER NOT NULL DEFAULT 0,
  resolved_count INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  breakeven INTEGER NOT NULL DEFAULT 0,
  signals_per_session NUMERIC(12, 4) NOT NULL DEFAULT 0,
  win_rate NUMERIC(12, 6) NOT NULL DEFAULT 0,
  gross_profit_r NUMERIC(12, 4) NOT NULL DEFAULT 0,
  gross_loss_r NUMERIC(12, 4) NOT NULL DEFAULT 0,
  profit_factor NUMERIC(12, 4),
  expectancy_r NUMERIC(12, 4) NOT NULL DEFAULT 0,
  total_r NUMERIC(12, 4) NOT NULL DEFAULT 0,
  max_drawdown_r NUMERIC(12, 4) NOT NULL DEFAULT 0,
  eligible BOOLEAN NOT NULL DEFAULT false,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, partition, module_code, profile_code)
);

CREATE TABLE IF NOT EXISTS strategy_release_gates (
  module_code TEXT NOT NULL REFERENCES platform_strategy_modules(code) ON DELETE CASCADE,
  profile_code TEXT NOT NULL,
  validation_run_id UUID NOT NULL REFERENCES strategy_validation_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('ELIGIBLE', 'BLOCKED', 'INSUFFICIENT_DATA')),
  enforced BOOLEAN NOT NULL DEFAULT false,
  resolved_count INTEGER NOT NULL DEFAULT 0,
  win_rate NUMERIC(12, 6) NOT NULL DEFAULT 0,
  profit_factor NUMERIC(12, 4),
  expectancy_r NUMERIC(12, 4) NOT NULL DEFAULT 0,
  total_r NUMERIC(12, 4) NOT NULL DEFAULT 0,
  max_drawdown_r NUMERIC(12, 4) NOT NULL DEFAULT 0,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (module_code, profile_code)
);

COMMENT ON TABLE strategy_validation_candles IS
  'Research-only historical candles. These rows are isolated from the live candles table and its seven-day retention policy.';

COMMENT ON COLUMN strategy_release_gates.enforced IS
  'False until the untouched validation partition meets the configured minimum resolved sample. Small samples cannot disable live profiles.';
