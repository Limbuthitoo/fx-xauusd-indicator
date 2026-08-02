CREATE TABLE IF NOT EXISTS module_learning_reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL REFERENCES platform_strategy_modules(code) ON DELETE CASCADE,
  recommendation_id UUID REFERENCES module_learning_recommendations(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED_QA', 'REJECTED', 'APPLIED', 'ROLLED_BACK')),
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  proposed_change JSONB NOT NULL DEFAULT '{}',
  guardrails JSONB NOT NULL DEFAULT '[]',
  review_note TEXT,
  reviewed_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS module_learning_reviews_tenant_module_idx
  ON module_learning_reviews(tenant_id, module_code, status, created_at DESC);
