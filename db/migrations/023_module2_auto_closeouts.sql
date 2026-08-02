CREATE TABLE IF NOT EXISTS module_session_closeouts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL REFERENCES platform_strategy_modules(code) ON DELETE CASCADE,
  session_id UUID REFERENCES trading_sessions(id) ON DELETE SET NULL,
  session_date DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
  report_id UUID REFERENCES module_session_reports(id) ON DELETE SET NULL,
  learning_run_id UUID REFERENCES module_learning_runs(id) ON DELETE SET NULL,
  review_items_created INTEGER NOT NULL DEFAULT 0,
  summary JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, module_code, session_date)
);

CREATE INDEX IF NOT EXISTS module_session_closeouts_tenant_module_idx
  ON module_session_closeouts(tenant_id, module_code, session_date DESC);
