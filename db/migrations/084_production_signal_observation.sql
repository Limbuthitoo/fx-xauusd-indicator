CREATE TABLE IF NOT EXISTS production_signal_observations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL REFERENCES platform_strategy_modules(code) ON DELETE CASCADE,
  session_id UUID REFERENCES trading_sessions(id) ON DELETE SET NULL,
  setup_candidate_id UUID NOT NULL REFERENCES setup_candidates(id) ON DELETE CASCADE,
  setup_detected_at TIMESTAMPTZ NOT NULL,
  observation_status TEXT NOT NULL DEFAULT 'OBSERVING'
    CHECK (observation_status IN ('OBSERVING', 'PASS', 'WARN', 'FAIL')),
  signal_expected BOOLEAN NOT NULL DEFAULT false,
  prediction_observed BOOLEAN NOT NULL DEFAULT false,
  signal_observed BOOLEAN NOT NULL DEFAULT false,
  paper_tracking_expected BOOLEAN NOT NULL DEFAULT false,
  trade_plan_observed BOOLEAN NOT NULL DEFAULT false,
  paper_trade_observed BOOLEAN NOT NULL DEFAULT false,
  target_ladder_observed BOOLEAN NOT NULL DEFAULT false,
  journal_observed BOOLEAN NOT NULL DEFAULT false,
  terminal_lifecycle_observed BOOLEAN NOT NULL DEFAULT false,
  missing_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  blocker_evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (setup_candidate_id)
);

CREATE INDEX IF NOT EXISTS production_signal_observations_tenant_module_idx
  ON production_signal_observations (tenant_id, module_code, setup_detected_at DESC);

CREATE INDEX IF NOT EXISTS production_signal_observations_status_idx
  ON production_signal_observations (observation_status, last_observed_at DESC);

CREATE INDEX IF NOT EXISTS production_signal_observations_session_idx
  ON production_signal_observations (session_id, module_code, setup_detected_at DESC);

COMMENT ON TABLE production_signal_observations IS
  'Persistent proof of the signal-first MVP chain. Prediction and BUY/SELL are primary artifacts; paper trade, targets, journal, and terminal lifecycle are secondary audit evidence.';
