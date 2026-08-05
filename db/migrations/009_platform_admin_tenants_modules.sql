CREATE TABLE IF NOT EXISTS platform_tenants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  owner_email TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_strategy_modules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  target_win_rate TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscription_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  billing_period TEXT NOT NULL DEFAULT 'MONTHLY',
  price_usd NUMERIC(12, 2) NOT NULL DEFAULT 0,
  max_tenants INTEGER,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscription_plan_modules (
  plan_id UUID NOT NULL REFERENCES subscription_plans(id) ON DELETE CASCADE,
  module_id UUID NOT NULL REFERENCES platform_strategy_modules(id) ON DELETE CASCADE,
  PRIMARY KEY (plan_id, module_id)
);

CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES subscription_plans(id),
  status TEXT NOT NULL DEFAULT 'TRIAL',
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  renews_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_modules (
  tenant_id UUID NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  module_id UUID NOT NULL REFERENCES platform_strategy_modules(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'ENABLED',
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  PRIMARY KEY (tenant_id, module_id)
);

INSERT INTO admin_permissions (code, name, category, description)
VALUES
  ('platform.manage', 'Manage Platform', 'Platform Admin', 'Create tenants, assign modules, and manage subscription plans.')
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  description = EXCLUDED.description;

INSERT INTO admin_role_permissions (role_id, permission_code)
SELECT r.id, 'platform.manage'
FROM admin_roles r
WHERE r.code = 'owner_admin'
ON CONFLICT DO NOTHING;

INSERT INTO platform_strategy_modules (code, name, description, target_win_rate, sort_order)
VALUES
  ('orb_max_options', 'Module 1: ORB MAX Options Strategy', 'Automated XAUUSD New York ORB checklist, paper trading, journal, reports, and learning recommendations.', 'Research validated, rules-first', 10),
  ('high_probability_strategy_2', 'Module 2: High Probability Strategy', 'Placeholder module for the next rules-based strategy targeting 70-80% historical win-rate validation before release.', 'Target 70-80% after backtest validation', 20)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  target_win_rate = EXCLUDED.target_win_rate,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

INSERT INTO subscription_plans (code, name, description, billing_period, price_usd, max_tenants)
VALUES
  ('starter_orb', 'Starter ORB', 'Single-tenant access to Module 1 ORB MAX Options Strategy.', 'MONTHLY', 49, 1),
  ('professional_multi_strategy', 'Professional Multi-Strategy', 'Tenant access to ORB plus future high-probability strategy modules.', 'MONTHLY', 149, 5),
  ('enterprise_platform', 'Enterprise Platform', 'Full platform access with all modules, tenant controls, and priority strategy expansion.', 'MONTHLY', 499, NULL)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  billing_period = EXCLUDED.billing_period,
  price_usd = EXCLUDED.price_usd,
  max_tenants = EXCLUDED.max_tenants,
  updated_at = now();

INSERT INTO subscription_plan_modules (plan_id, module_id)
SELECT p.id, m.id
FROM subscription_plans p
JOIN platform_strategy_modules m ON m.code = 'orb_max_options'
WHERE p.code IN ('starter_orb', 'professional_multi_strategy', 'enterprise_platform')
ON CONFLICT DO NOTHING;

INSERT INTO subscription_plan_modules (plan_id, module_id)
SELECT p.id, m.id
FROM subscription_plans p
JOIN platform_strategy_modules m ON m.code = 'high_probability_strategy_2'
WHERE p.code IN ('professional_multi_strategy', 'enterprise_platform')
ON CONFLICT DO NOTHING;
