UPDATE strategy_versions
SET
  configuration_json = COALESCE(configuration_json, '{}'::jsonb)
    || '{
      "liquidityReusePolicy": "NEVER_REUSE",
      "liquidityMergeToleranceATR": 0.05,
      "maximumSwingLevelAgeDays": 5,
      "countertrendResolutionMode": "WARN",
      "positionManagementMode": "FIXED_STOP_FIXED_TARGET",
      "minimumTradesForInsight": 30
    }'::jsonb
WHERE strategy_id = '00000000-0000-0000-0000-000000000302';

UPDATE tenant_module_settings
SET
  value = COALESCE(value, '{}'::jsonb)
    || '{
      "liquidityReusePolicy": "NEVER_REUSE",
      "liquidityMergeToleranceATR": 0.05,
      "maximumSwingLevelAgeDays": 5,
      "countertrendResolutionMode": "WARN",
      "positionManagementMode": "FIXED_STOP_FIXED_TARGET",
      "minimumTradesForInsight": 30
    }'::jsonb,
  updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND key = 'liquiditySweep.strategy';

CREATE TABLE IF NOT EXISTS liquidity_levels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL DEFAULT 'high_probability_strategy_2',
  symbol TEXT NOT NULL DEFAULT 'XAUUSD',
  level_key TEXT NOT NULL,
  type TEXT NOT NULL,
  side TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  price NUMERIC(14,5) NOT NULL,
  lower_bound NUMERIC(14,5),
  upper_bound NUMERIC(14,5),
  formed_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL,
  last_touched_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  priority_score NUMERIC(10,2) NOT NULL DEFAULT 0,
  freshness_score NUMERIC(10,2) NOT NULL DEFAULT 100,
  reaction_score NUMERIC(10,2) NOT NULL DEFAULT 0,
  overlap_score NUMERIC(10,2) NOT NULL DEFAULT 0,
  quality_score NUMERIC(10,2) NOT NULL DEFAULT 0,
  touch_count INTEGER NOT NULL DEFAULT 0,
  sweep_count INTEGER NOT NULL DEFAULT 0,
  close_count_beyond INTEGER NOT NULL DEFAULT 0,
  cluster_size INTEGER NOT NULL DEFAULT 1,
  source_ids JSONB NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'ACTIVE',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, module_code, symbol, level_key)
);

CREATE INDEX IF NOT EXISTS liquidity_levels_active_idx
  ON liquidity_levels(tenant_id, module_code, symbol, state, priority_score DESC);

CREATE TABLE IF NOT EXISTS liquidity_level_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  liquidity_level_id UUID REFERENCES liquidity_levels(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL DEFAULT 'high_probability_strategy_2',
  event_type TEXT NOT NULL,
  previous_state TEXT,
  next_state TEXT,
  candle_timestamp TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS liquidity_level_events_level_idx
  ON liquidity_level_events(liquidity_level_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS structure_points (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL DEFAULT 'high_probability_strategy_2',
  symbol TEXT NOT NULL DEFAULT 'XAUUSD',
  point_key TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  hierarchy TEXT NOT NULL,
  type TEXT NOT NULL,
  classification TEXT,
  price NUMERIC(14,5) NOT NULL,
  lower_bound NUMERIC(14,5),
  upper_bound NUMERIC(14,5),
  formed_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL,
  prominence_atr NUMERIC(10,4) NOT NULL DEFAULT 0,
  confidence NUMERIC(10,2) NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'CONFIRMED',
  parent_id UUID REFERENCES structure_points(id) ON DELETE SET NULL,
  previous_same_type_id UUID REFERENCES structure_points(id) ON DELETE SET NULL,
  previous_opposite_type_id UUID REFERENCES structure_points(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, module_code, symbol, point_key)
);

CREATE INDEX IF NOT EXISTS structure_points_lookup_idx
  ON structure_points(tenant_id, module_code, symbol, timeframe, confirmed_at DESC);

CREATE TABLE IF NOT EXISTS structure_break_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL DEFAULT 'high_probability_strategy_2',
  symbol TEXT NOT NULL DEFAULT 'XAUUSD',
  direction TEXT NOT NULL,
  break_type TEXT NOT NULL,
  structure_point_id UUID REFERENCES structure_points(id) ON DELETE SET NULL,
  break_candle_timestamp TIMESTAMPTZ NOT NULL,
  wick_break BOOLEAN NOT NULL DEFAULT false,
  close_confirmed BOOLEAN NOT NULL DEFAULT true,
  break_distance_atr NUMERIC(10,4) NOT NULL DEFAULT 0,
  body_ratio NUMERIC(10,4),
  displacement_passed BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS structure_break_events_lookup_idx
  ON structure_break_events(tenant_id, module_code, symbol, occurred_at DESC);

CREATE TABLE IF NOT EXISTS market_regimes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL DEFAULT 'high_probability_strategy_2',
  symbol TEXT NOT NULL DEFAULT 'XAUUSD',
  timeframe TEXT NOT NULL DEFAULT '5min',
  primary_regime TEXT NOT NULL,
  secondary_regimes JSONB NOT NULL DEFAULT '[]',
  confidence NUMERIC(10,2) NOT NULL DEFAULT 0,
  actual_values JSONB NOT NULL DEFAULT '{}',
  explanation JSONB NOT NULL DEFAULT '[]',
  candle_timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, module_code, symbol, timeframe, candle_timestamp)
);

CREATE TABLE IF NOT EXISTS domain_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  correlation_id UUID NOT NULL DEFAULT uuid_generate_v4(),
  causation_id UUID,
  payload JSONB NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT UNIQUE
);

CREATE TABLE IF NOT EXISTS event_processing_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  idempotency_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS strategy_plugins (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  plugin_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  module_code TEXT NOT NULL,
  supports_symbols JSONB NOT NULL DEFAULT '["XAUUSD"]',
  supports_timeframes JSONB NOT NULL DEFAULT '[5,15]',
  required_data JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO strategy_plugins (plugin_code, name, version, module_code, required_data)
VALUES (
  'liquidity-sweep-mss-retest',
  'Liquidity Sweep MSS Retest Plugin',
  'ULTIMATE_LIQUIDITY_SWEEP_V1.0',
  'high_probability_strategy_2',
  '["5M_CANDLES","15M_CONTEXT","ATR14","SESSION_LEVELS","SWINGS","LIQUIDITY_LEVELS","NEWS_STATUS","SPREAD"]'::jsonb
)
ON CONFLICT (plugin_code) DO UPDATE
SET
  name = EXCLUDED.name,
  version = EXCLUDED.version,
  module_code = EXCLUDED.module_code,
  required_data = EXCLUDED.required_data,
  status = 'ACTIVE',
  updated_at = now();

CREATE TABLE IF NOT EXISTS parameter_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  module_code TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  version_label TEXT NOT NULL,
  parameters JSONB NOT NULL DEFAULT '{}',
  diff JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  source TEXT NOT NULL DEFAULT 'DEFAULT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (module_code, strategy_version, version_label)
);

CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE,
  trade_plan_id UUID REFERENCES trade_plans(id) ON DELETE SET NULL,
  trade_id UUID REFERENCES trades(id) ON DELETE SET NULL,
  symbol TEXT NOT NULL DEFAULT 'XAUUSD',
  direction TEXT NOT NULL,
  planned_entry NUMERIC(14,5) NOT NULL,
  actual_entry NUMERIC(14,5),
  initial_stop NUMERIC(14,5) NOT NULL,
  current_stop NUMERIC(14,5) NOT NULL,
  initial_target NUMERIC(14,5) NOT NULL,
  actual_exit NUMERIC(14,5),
  planned_risk_amount NUMERIC(14,5) NOT NULL DEFAULT 0,
  current_open_risk NUMERIC(14,5) NOT NULL DEFAULT 0,
  quantity NUMERIC(14,5) NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'PLANNED',
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS position_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  position_id UUID REFERENCES positions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  before JSONB,
  after JSONB,
  reason TEXT,
  actor TEXT NOT NULL DEFAULT 'SYSTEM',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS manual_execution_reconciliations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE,
  trade_id UUID REFERENCES trades(id) ON DELETE SET NULL,
  position_id UUID REFERENCES positions(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'MANUAL_REVIEW',
  actual_entry NUMERIC(14,5),
  actual_stop NUMERIC(14,5),
  actual_target NUMERIC(14,5),
  actual_lot NUMERIC(14,5),
  entry_timestamp TIMESTAMPTZ,
  exit_timestamp TIMESTAMPTZ,
  realized_profit NUMERIC(14,5),
  fees NUMERIC(14,5),
  spread NUMERIC(14,5),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS journal_insights (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL DEFAULT 'high_probability_strategy_2',
  insight_type TEXT NOT NULL,
  sample_size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'INSUFFICIENT_SAMPLE',
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  dimensions JSONB NOT NULL DEFAULT '{}',
  metrics JSONB NOT NULL DEFAULT '{}',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL,
  snapshot_type TEXT NOT NULL,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  metrics JSONB NOT NULL DEFAULT '{}',
  segmentation JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS replay_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  controls JSONB NOT NULL DEFAULT '{}',
  state JSONB NOT NULL DEFAULT '{}',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS replay_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  replay_run_id UUID REFERENCES replay_runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  candle_timestamp TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS backtest_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  backtest_run_id UUID REFERENCES backtest_runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  candle_timestamp TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS parameter_experiments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL,
  base_strategy_version_id UUID REFERENCES strategy_versions(id) ON DELETE SET NULL,
  parameter_changes JSONB NOT NULL DEFAULT '{}',
  dataset_id TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  summary JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strategy_approvals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  workflow_state TEXT NOT NULL DEFAULT 'DRAFT',
  requirements JSONB NOT NULL DEFAULT '{}',
  approved_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS system_checkpoints (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL,
  symbol TEXT NOT NULL DEFAULT 'XAUUSD',
  checkpoint_type TEXT NOT NULL,
  candle_timestamp TIMESTAMPTZ,
  state_hash TEXT,
  state JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'CONSISTENT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS system_checkpoints_lookup_idx
  ON system_checkpoints(tenant_id, module_code, symbol, created_at DESC);
