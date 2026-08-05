CREATE TABLE IF NOT EXISTS module2_state_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE,
  setup_candidate_id UUID NOT NULL REFERENCES setup_candidates(id) ON DELETE CASCADE,
  session_id UUID REFERENCES trading_sessions(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL DEFAULT 'high_probability_strategy_2',
  variant_code TEXT,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (setup_candidate_id, to_state, occurred_at)
);

CREATE INDEX IF NOT EXISTS module2_state_transitions_tenant_idx
  ON module2_state_transitions(tenant_id, module_code, occurred_at DESC);

CREATE INDEX IF NOT EXISTS module2_state_transitions_setup_idx
  ON module2_state_transitions(setup_candidate_id, occurred_at ASC);

CREATE TABLE IF NOT EXISTS module2_variant_metric_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE,
  variant_code TEXT NOT NULL,
  variant_name TEXT,
  trades INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0,
  win_rate NUMERIC(8,5) NOT NULL DEFAULT 0,
  average_r NUMERIC(12,5) NOT NULL DEFAULT 0,
  total_r NUMERIC(12,5) NOT NULL DEFAULT 0,
  best_session TEXT,
  top_blocker TEXT,
  recommendation TEXT,
  source TEXT NOT NULL DEFAULT 'LIVE_PAPER',
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, variant_code, source)
);

CREATE INDEX IF NOT EXISTS module2_variant_metric_snapshots_tenant_idx
  ON module2_variant_metric_snapshots(tenant_id, source, calculated_at DESC);
