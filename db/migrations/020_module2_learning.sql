CREATE TABLE IF NOT EXISTS module_learning_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL REFERENCES platform_strategy_modules(code) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'PAPER_TRADES',
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  sample_size INTEGER NOT NULL DEFAULT 0,
  summary JSONB NOT NULL DEFAULT '{}',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS module_learning_recommendations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  learning_run_id UUID NOT NULL REFERENCES module_learning_runs(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL REFERENCES platform_strategy_modules(code) ON DELETE CASCADE,
  recommendation_type TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'LOW',
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}',
  suggested_action JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS module_learning_runs_tenant_module_idx
  ON module_learning_runs(tenant_id, module_code, started_at DESC);

CREATE INDEX IF NOT EXISTS module_learning_recommendations_run_idx
  ON module_learning_recommendations(learning_run_id, created_at DESC);
