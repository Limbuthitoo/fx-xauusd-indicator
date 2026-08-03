CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  display_name TEXT NOT NULL,
  pin_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  selected_symbol TEXT NOT NULL DEFAULT 'XAUUSD',
  selected_session_preset TEXT NOT NULL DEFAULT 'NY_0915',
  selected_strategy_version_id UUID,
  account_currency TEXT NOT NULL DEFAULT 'USD',
  timezone TEXT NOT NULL DEFAULT 'Asia/Kathmandu',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS instruments (
  symbol TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  base_asset TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  price_decimals INTEGER NOT NULL,
  tick_size NUMERIC(18, 8) NOT NULL,
  pip_definition TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS broker_specs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL REFERENCES instruments(symbol),
  contract_size NUMERIC(18, 4),
  minimum_lot NUMERIC(18, 4),
  lot_step NUMERIC(18, 4),
  maximum_lot NUMERIC(18, 4),
  tick_size NUMERIC(18, 8) NOT NULL,
  tick_value NUMERIC(18, 8),
  account_currency TEXT NOT NULL,
  commission_per_lot NUMERIC(18, 4) DEFAULT 0,
  typical_spread NUMERIC(18, 4) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strategy_sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  strategy_name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_creator TEXT NOT NULL,
  implementation_type TEXT NOT NULL,
  market_originally_observed TEXT NOT NULL,
  adapted_market TEXT NOT NULL,
  distribution TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strategies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id UUID REFERENCES strategy_sources(id),
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS strategy_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  strategy_id UUID NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  status TEXT NOT NULL,
  session_start TEXT NOT NULL,
  trade_window_end TEXT NOT NULL,
  opening_range_minutes INTEGER NOT NULL,
  signal_timeframe_minutes INTEGER NOT NULL,
  configuration_json JSONB NOT NULL,
  generated_signal_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  UNIQUE(strategy_id, version)
);

CREATE TABLE IF NOT EXISTS strategy_rule_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  strategy_version_id UUID NOT NULL REFERENCES strategy_versions(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS strategy_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id UUID REFERENCES strategy_rule_groups(id) ON DELETE CASCADE,
  strategy_version_id UUID NOT NULL REFERENCES strategy_versions(id) ON DELETE CASCADE,
  rule_code TEXT NOT NULL,
  name TEXT NOT NULL,
  blocking BOOLEAN NOT NULL DEFAULT true,
  source TEXT NOT NULL DEFAULT 'AUTOMATIC',
  configuration JSONB NOT NULL DEFAULT '{}',
  UNIQUE(strategy_version_id, rule_code)
);

CREATE TABLE IF NOT EXISTS strategy_parameters (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  strategy_version_id UUID NOT NULL REFERENCES strategy_versions(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  evidence_status TEXT NOT NULL DEFAULT 'EXPERIMENTAL',
  UNIQUE(strategy_version_id, key)
);

CREATE TABLE IF NOT EXISTS trading_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  symbol TEXT NOT NULL REFERENCES instruments(symbol),
  strategy_version_id UUID NOT NULL REFERENCES strategy_versions(id),
  session_date DATE NOT NULL,
  session_preset TEXT NOT NULL,
  state TEXT NOT NULL,
  session_start_at TIMESTAMPTZ NOT NULL,
  opening_range_end_at TIMESTAMPTZ NOT NULL,
  signal_window_end_at TIMESTAMPTZ NOT NULL,
  data_status TEXT NOT NULL DEFAULT 'WAITING_FOR_DATA',
  final_classification TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS opening_ranges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID UNIQUE NOT NULL REFERENCES trading_sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  high NUMERIC(18, 5),
  low NUMERIC(18, 5),
  midpoint NUMERIC(18, 5),
  width NUMERIC(18, 5),
  width_ticks NUMERIC(18, 4),
  width_atr_percent NUMERIC(18, 4),
  source_candle_count INTEGER NOT NULL DEFAULT 0,
  data_quality_status TEXT NOT NULL,
  invalid_reason TEXT,
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS candles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  symbol TEXT NOT NULL REFERENCES instruments(symbol),
  timeframe_minutes INTEGER NOT NULL,
  timestamp_utc TIMESTAMPTZ NOT NULL,
  open NUMERIC(18, 5) NOT NULL,
  high NUMERIC(18, 5) NOT NULL,
  low NUMERIC(18, 5) NOT NULL,
  close NUMERIC(18, 5) NOT NULL,
  volume NUMERIC(18, 4),
  spread NUMERIC(18, 5),
  source TEXT NOT NULL DEFAULT 'CSV_IMPORT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(symbol, timeframe_minutes, timestamp_utc),
  CHECK (high >= low),
  CHECK (high >= open AND high >= close),
  CHECK (low <= open AND low <= close),
  CHECK (open > 0 AND high > 0 AND low > 0 AND close > 0)
);

CREATE TABLE IF NOT EXISTS economic_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  affected_currency TEXT NOT NULL,
  impact TEXT NOT NULL,
  event_time_utc TIMESTAMPTZ NOT NULL,
  block_before_minutes INTEGER NOT NULL DEFAULT 30,
  block_after_minutes INTEGER NOT NULL DEFAULT 30,
  notes TEXT,
  override_status TEXT,
  override_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS setup_candidates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES trading_sessions(id) ON DELETE CASCADE,
  strategy_version_id UUID NOT NULL REFERENCES strategy_versions(id),
  symbol TEXT NOT NULL,
  scenario TEXT NOT NULL,
  direction TEXT,
  status TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  entry_price NUMERIC(18, 5),
  stop_price NUMERIC(18, 5),
  target_price NUMERIC(18, 5),
  final_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS setup_rule_evaluations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  setup_candidate_id UUID NOT NULL REFERENCES setup_candidates(id) ON DELETE CASCADE,
  rule_code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  blocking BOOLEAN NOT NULL,
  source TEXT NOT NULL,
  actual_value TEXT,
  required_value TEXT,
  explanation TEXT NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS manual_checklists (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  setup_candidate_id UUID UNIQUE NOT NULL REFERENCES setup_candidates(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'INCOMPLETE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS manual_checklist_answers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  checklist_id UUID NOT NULL REFERENCES manual_checklists(id) ON DELETE CASCADE,
  item_code TEXT NOT NULL,
  prompt TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT 'UNCERTAIN',
  mandatory BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(checklist_id, item_code)
);

CREATE TABLE IF NOT EXISTS risk_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  account_balance NUMERIC(18, 2) NOT NULL DEFAULT 10000,
  account_equity NUMERIC(18, 2) NOT NULL DEFAULT 10000,
  account_currency TEXT NOT NULL DEFAULT 'USD',
  risk_per_trade_percent NUMERIC(8, 4) NOT NULL DEFAULT 0.25,
  maximum_daily_loss_percent NUMERIC(8, 4) NOT NULL DEFAULT 0.75,
  maximum_weekly_loss_percent NUMERIC(8, 4) NOT NULL DEFAULT 2.0,
  maximum_trades_per_session INTEGER NOT NULL DEFAULT 1,
  maximum_consecutive_losses INTEGER NOT NULL DEFAULT 3,
  mandatory_stop_loss BOOLEAN NOT NULL DEFAULT true,
  minimum_reward_to_risk NUMERIC(8, 4) NOT NULL DEFAULT 1.5,
  allow_martingale BOOLEAN NOT NULL DEFAULT false,
  allow_adding_to_loss BOOLEAN NOT NULL DEFAULT false,
  allow_moving_stop_farther BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trade_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  setup_candidate_id UUID UNIQUE NOT NULL REFERENCES setup_candidates(id) ON DELETE CASCADE,
  planned_entry NUMERIC(18, 5) NOT NULL,
  planned_stop NUMERIC(18, 5) NOT NULL,
  planned_target NUMERIC(18, 5) NOT NULL,
  planned_lot NUMERIC(18, 4),
  planned_risk_amount NUMERIC(18, 2),
  reward_to_risk NUMERIC(18, 4),
  status TEXT NOT NULL DEFAULT 'DRAFT',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trades (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trade_plan_id UUID NOT NULL REFERENCES trade_plans(id),
  actual_entry NUMERIC(18, 5),
  actual_stop NUMERIC(18, 5),
  actual_target NUMERIC(18, 5),
  actual_exit NUMERIC(18, 5),
  actual_lot NUMERIC(18, 4),
  commission NUMERIC(18, 4),
  spread NUMERIC(18, 5),
  slippage NUMERIC(18, 5),
  result_money NUMERIC(18, 2),
  result_r NUMERIC(18, 4),
  outcome TEXT,
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS trade_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trade_id UUID NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  setup_candidate_id UUID REFERENCES setup_candidates(id) ON DELETE SET NULL,
  trade_id UUID REFERENCES trades(id) ON DELETE SET NULL,
  session_id UUID REFERENCES trading_sessions(id) ON DELETE SET NULL,
  decision TEXT NOT NULL,
  emotion_before TEXT,
  confidence INTEGER,
  sleep_readiness TEXT,
  revenge_trading_risk TEXT,
  fear_of_missing_out TEXT,
  rule_violations TEXT,
  emotion_after TEXT,
  lesson TEXT,
  process_grade TEXT,
  outcome TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  journal_entry_id UUID REFERENCES journal_entries(id) ON DELETE CASCADE,
  setup_candidate_id UUID REFERENCES setup_candidates(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  file_type TEXT NOT NULL,
  caption TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  strategy_version_id UUID NOT NULL REFERENCES strategy_versions(id),
  symbol TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL,
  parameters JSONB NOT NULL DEFAULT '{}',
  summary JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS backtest_trades (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  backtest_run_id UUID NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  session_date DATE NOT NULL,
  scenario TEXT NOT NULL,
  direction TEXT,
  entry_price NUMERIC(18, 5),
  stop_price NUMERIC(18, 5),
  target_price NUMERIC(18, 5),
  result_r NUMERIC(18, 4),
  outcome TEXT,
  ambiguous BOOLEAN NOT NULL DEFAULT false,
  details JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS backtest_metrics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  backtest_run_id UUID NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
  metric_key TEXT NOT NULL,
  metric_value NUMERIC(18, 6),
  metric_json JSONB,
  UNIQUE(backtest_run_id, metric_key)
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'NORMAL',
  acknowledged_at TIMESTAMPTZ,
  muted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS risk_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  setup_candidate_id UUID REFERENCES setup_candidates(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  reasons JSONB NOT NULL DEFAULT '[]',
  calculation JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS daily_performance (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  trade_date DATE NOT NULL,
  result_money NUMERIC(18, 2) NOT NULL DEFAULT 0,
  result_r NUMERIC(18, 4) NOT NULL DEFAULT 0,
  trades_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, trade_date)
);

CREATE TABLE IF NOT EXISTS weekly_performance (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  result_money NUMERIC(18, 2) NOT NULL DEFAULT 0,
  result_r NUMERIC(18, 4) NOT NULL DEFAULT 0,
  trades_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, week_start)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS candles_symbol_time_idx ON candles(symbol, timeframe_minutes, timestamp_utc);
CREATE INDEX IF NOT EXISTS setup_session_idx ON setup_candidates(session_id);
CREATE INDEX IF NOT EXISTS sessions_date_idx ON trading_sessions(symbol, session_date);
