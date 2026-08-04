ALTER TABLE orb_learning_runs
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES platform_tenants(id) ON DELETE CASCADE;

UPDATE orb_learning_runs
SET tenant_id = (SELECT id FROM platform_tenants WHERE slug = 'default-orb-tenant')
WHERE tenant_id IS NULL;

ALTER TABLE orb_learning_runs
  ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS orb_learning_runs_tenant_started_idx
ON orb_learning_runs(tenant_id, started_at DESC);
