CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  updated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS tenant_module_settings (
  tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL REFERENCES platform_strategy_modules(code) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  updated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module_code, key)
);

INSERT INTO tenant_settings (tenant_id, key, value, category, description)
SELECT t.id, s.key, s.value, s.category, s.description
FROM platform_tenants t
CROSS JOIN app_settings s
WHERE t.slug = 'default-orb-tenant'
ON CONFLICT (tenant_id, key) DO NOTHING;

INSERT INTO tenant_module_settings (tenant_id, module_code, key, value, category, description)
SELECT
  t.id,
  'orb_max_options',
  'orb.strategy',
  sv.configuration_json,
  'ORB MAX',
  'Tenant-level ORB MAX Options strategy thresholds and automatic paper-trade rules.'
FROM platform_tenants t
CROSS JOIN LATERAL (
  SELECT configuration_json
  FROM strategy_versions
  WHERE status = 'ACTIVE'
  ORDER BY activated_at DESC NULLS LAST, created_at DESC
  LIMIT 1
) sv
WHERE t.slug = 'default-orb-tenant'
ON CONFLICT (tenant_id, module_code, key) DO NOTHING;

CREATE INDEX IF NOT EXISTS tenant_settings_key_idx ON tenant_settings(key);
CREATE INDEX IF NOT EXISTS tenant_module_settings_module_idx ON tenant_module_settings(module_code, key);
