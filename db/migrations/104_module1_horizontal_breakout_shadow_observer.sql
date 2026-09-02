CREATE TABLE IF NOT EXISTS module1_horizontal_candidate_audits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES trading_sessions(id) ON DELETE CASCADE,
  strategy_version_id UUID NOT NULL REFERENCES strategy_versions(id) ON DELETE CASCADE,
  setup_candidate_id UUID REFERENCES setup_candidates(id) ON DELETE SET NULL,
  symbol TEXT NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL,
  detector_status TEXT NOT NULL,
  structure_classification TEXT,
  range_id TEXT REFERENCES ranges(id) ON DELETE SET NULL,
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  failures_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, session_id, evaluated_at)
);

CREATE INDEX IF NOT EXISTS module1_horizontal_candidate_audits_session_idx
  ON module1_horizontal_candidate_audits (tenant_id, session_id, evaluated_at DESC);

CREATE TABLE IF NOT EXISTS module1_horizontal_breakout_shadows (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES trading_sessions(id) ON DELETE CASCADE,
  strategy_version_id UUID NOT NULL REFERENCES strategy_versions(id) ON DELETE CASCADE,
  setup_candidate_id UUID REFERENCES setup_candidates(id) ON DELETE SET NULL,
  range_id TEXT REFERENCES ranges(id) ON DELETE SET NULL,
  candidate_range_key TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  entry_model TEXT NOT NULL DEFAULT 'DIRECT_BREAKOUT_CLOSE',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  breakout_at TIMESTAMPTZ NOT NULL,
  observation_until TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  entry_price NUMERIC(18,5) NOT NULL,
  initial_stop_price NUMERIC(18,5) NOT NULL,
  initial_risk_distance NUMERIC(18,5) NOT NULL CHECK (initial_risk_distance > 0),
  tp1_price NUMERIC(18,5) NOT NULL,
  tp2_price NUMERIC(18,5) NOT NULL,
  tp3_price NUMERIC(18,5) NOT NULL,
  max_favorable_price NUMERIC(18,5),
  max_adverse_price NUMERIC(18,5),
  max_favorable_excursion_r NUMERIC(12,6) NOT NULL DEFAULT 0,
  max_adverse_excursion_r NUMERIC(12,6) NOT NULL DEFAULT 0,
  tp1_hit_at TIMESTAMPTZ,
  tp2_hit_at TIMESTAMPTZ,
  tp3_hit_at TIMESTAMPTZ,
  stop_hit_at TIMESTAMPTZ,
  terminal_reason TEXT,
  production_setup_ready BOOLEAN NOT NULL DEFAULT false,
  production_decision TEXT,
  production_reason TEXT,
  rejection_stage TEXT,
  rejection_reason TEXT,
  range_quality_score NUMERIC(8,2),
  breakout_metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  range_evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, candidate_range_key, breakout_at, direction, entry_model)
);

CREATE INDEX IF NOT EXISTS module1_horizontal_breakout_shadows_active_idx
  ON module1_horizontal_breakout_shadows (tenant_id, symbol, observation_until, breakout_at)
  WHERE completed_at IS NULL;

CREATE INDEX IF NOT EXISTS module1_horizontal_breakout_shadows_analysis_idx
  ON module1_horizontal_breakout_shadows (tenant_id, direction, rejection_stage, completed_at DESC);

CREATE OR REPLACE VIEW module1_horizontal_breakout_shadow_calibration AS
SELECT
  tenant_id,
  direction,
  COALESCE(rejection_stage, 'PRODUCTION_READY') AS cohort,
  count(*)::int AS observed_breakouts,
  count(*) FILTER (WHERE completed_at IS NOT NULL)::int AS completed_breakouts,
  count(*) FILTER (WHERE tp1_hit_at IS NOT NULL)::int AS tp1_hits,
  count(*) FILTER (WHERE tp2_hit_at IS NOT NULL)::int AS tp2_hits,
  count(*) FILTER (WHERE tp3_hit_at IS NOT NULL)::int AS tp3_hits,
  count(*) FILTER (WHERE stop_hit_at IS NOT NULL)::int AS stop_hits,
  round(avg(max_favorable_excursion_r)::numeric, 4) AS average_mfe_r,
  round(avg(max_adverse_excursion_r)::numeric, 4) AS average_mae_r,
  count(*) FILTER (WHERE completed_at IS NOT NULL) >= 30 AS calibration_eligible
FROM module1_horizontal_breakout_shadows
GROUP BY tenant_id, direction, COALESCE(rejection_stage, 'PRODUCTION_READY');

COMMENT ON TABLE module1_horizontal_breakout_shadows IS
  'Observation-only direct horizontal-breakout counterfactuals. Rows never create signals, notifications, plans, positions, or paper trades.';

COMMENT ON VIEW module1_horizontal_breakout_shadow_calibration IS
  'Horizontal breakout shadow cohorts remain ineligible for production tuning until 30 completed observations exist.';
