CREATE TABLE IF NOT EXISTS ranges (
  id TEXT PRIMARY KEY,
  tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  source TEXT NOT NULL,
  formation_method TEXT NOT NULL,
  detector_version TEXT NOT NULL,
  strategy_version UUID REFERENCES strategy_versions(id) ON DELETE SET NULL,
  timeframe TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL,
  locked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  high NUMERIC(18, 5) NOT NULL,
  low NUMERIC(18, 5) NOT NULL,
  midpoint NUMERIC(18, 5) NOT NULL,
  width NUMERIC(18, 5) NOT NULL,
  width_atr NUMERIC(18, 6),
  upper_zone_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  lower_zone_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  quality_score NUMERIC(8, 2),
  confidence_score NUMERIC(8, 2),
  parent_range_id TEXT REFERENCES ranges(id) ON DELETE SET NULL,
  child_range_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  supporting_range_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  breakout_direction TEXT,
  state TEXT NOT NULL,
  source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS range_evidence (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  range_id TEXT NOT NULL REFERENCES ranges(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE,
  candle_ids_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  validation_rules_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  upper_touch_count INTEGER,
  lower_touch_count INTEGER,
  midpoint_cross_count INTEGER,
  containment_ratio NUMERIC(8, 4),
  efficiency_ratio NUMERIC(8, 4),
  upper_slope_atr_per_bar NUMERIC(8, 4),
  lower_slope_atr_per_bar NUMERIC(8, 4),
  session_name TEXT,
  fixed_start_time TIMESTAMPTZ,
  fixed_end_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(range_id)
);

CREATE TABLE IF NOT EXISTS range_relationships (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE,
  parent_range_id TEXT NOT NULL REFERENCES ranges(id) ON DELETE CASCADE,
  child_range_id TEXT NOT NULL REFERENCES ranges(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(parent_range_id, child_range_id, relationship_type)
);

CREATE TABLE IF NOT EXISTS range_breakout_setups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE,
  setup_candidate_id UUID REFERENCES setup_candidates(id) ON DELETE SET NULL,
  range_id TEXT NOT NULL REFERENCES ranges(id) ON DELETE CASCADE,
  direction TEXT,
  state TEXT NOT NULL,
  breakout_candle_id TEXT,
  breakout_price NUMERIC(18, 5),
  break_distance_atr NUMERIC(10, 4),
  body_ratio NUMERIC(10, 4),
  close_location_ratio NUMERIC(10, 4),
  extension_ratio NUMERIC(10, 4),
  retest_zone_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  retest_candle_id TEXT,
  entry_price NUMERIC(18, 5),
  stop_price NUMERIC(18, 5),
  target_price NUMERIC(18, 5),
  decision TEXT,
  decision_reason TEXT,
  false_breakout_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  retest_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  conflict_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(range_id, breakout_candle_id, direction)
);

CREATE INDEX IF NOT EXISTS idx_ranges_tenant_symbol_state ON ranges(tenant_id, symbol, state, locked_at DESC);
CREATE INDEX IF NOT EXISTS idx_ranges_source_detected ON ranges(source, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_range_breakout_setups_tenant_state ON range_breakout_setups(tenant_id, state, created_at DESC);
