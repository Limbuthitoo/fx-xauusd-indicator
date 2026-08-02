INSERT INTO platform_tenants (name, slug, owner_email, status)
VALUES ('Default ORB Tenant', 'default-orb-tenant', 'admin@orb.local', 'ACTIVE')
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  owner_email = EXCLUDED.owner_email,
  status = EXCLUDED.status,
  updated_at = now();

ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES platform_tenants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS platform_super_admin BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES platform_tenants(id) ON DELETE SET NULL;

ALTER TABLE risk_profiles
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES platform_tenants(id) ON DELETE SET NULL;

ALTER TABLE trading_sessions
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES platform_tenants(id) ON DELETE SET NULL;

ALTER TABLE setup_candidates
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES platform_tenants(id) ON DELETE SET NULL;

ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES platform_tenants(id) ON DELETE SET NULL;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES platform_tenants(id) ON DELETE SET NULL;

ALTER TABLE backtest_runs
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES platform_tenants(id) ON DELETE SET NULL;

ALTER TABLE daily_performance
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES platform_tenants(id) ON DELETE SET NULL;

ALTER TABLE weekly_performance
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES platform_tenants(id) ON DELETE SET NULL;

UPDATE admin_users
SET platform_super_admin = true
WHERE lower(email) = 'admin@orb.local';

UPDATE admin_users
SET tenant_id = (SELECT id FROM platform_tenants WHERE slug = 'default-orb-tenant')
WHERE tenant_id IS NULL;

UPDATE users
SET tenant_id = (SELECT id FROM platform_tenants WHERE slug = 'default-orb-tenant')
WHERE tenant_id IS NULL;

UPDATE risk_profiles
SET tenant_id = COALESCE(
  (SELECT tenant_id FROM users WHERE users.id = risk_profiles.user_id),
  (SELECT id FROM platform_tenants WHERE slug = 'default-orb-tenant')
)
WHERE tenant_id IS NULL;

UPDATE trading_sessions
SET tenant_id = COALESCE(
  (SELECT tenant_id FROM users WHERE users.id = trading_sessions.user_id),
  (SELECT id FROM platform_tenants WHERE slug = 'default-orb-tenant')
)
WHERE tenant_id IS NULL;

UPDATE setup_candidates
SET tenant_id = COALESCE(
  (SELECT tenant_id FROM trading_sessions WHERE trading_sessions.id = setup_candidates.session_id),
  (SELECT id FROM platform_tenants WHERE slug = 'default-orb-tenant')
)
WHERE tenant_id IS NULL;

UPDATE journal_entries
SET tenant_id = COALESCE(
  (SELECT tenant_id FROM trading_sessions WHERE trading_sessions.id = journal_entries.session_id),
  (SELECT tenant_id FROM setup_candidates WHERE setup_candidates.id = journal_entries.setup_candidate_id),
  (SELECT id FROM platform_tenants WHERE slug = 'default-orb-tenant')
)
WHERE tenant_id IS NULL;

UPDATE backtest_runs
SET tenant_id = (SELECT id FROM platform_tenants WHERE slug = 'default-orb-tenant')
WHERE tenant_id IS NULL;

UPDATE daily_performance
SET tenant_id = COALESCE(
  (SELECT tenant_id FROM users WHERE users.id = daily_performance.user_id),
  (SELECT id FROM platform_tenants WHERE slug = 'default-orb-tenant')
)
WHERE tenant_id IS NULL;

UPDATE weekly_performance
SET tenant_id = COALESCE(
  (SELECT tenant_id FROM users WHERE users.id = weekly_performance.user_id),
  (SELECT id FROM platform_tenants WHERE slug = 'default-orb-tenant')
)
WHERE tenant_id IS NULL;

INSERT INTO tenant_modules (tenant_id, module_id, status)
SELECT t.id, m.id, 'ENABLED'
FROM platform_tenants t
JOIN platform_strategy_modules m ON m.code = 'orb_max_options'
WHERE t.slug = 'default-orb-tenant'
ON CONFLICT (tenant_id, module_id) DO UPDATE SET status = 'ENABLED';

INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, renews_at)
SELECT t.id, p.id, 'ACTIVE', now() + interval '30 days'
FROM platform_tenants t
JOIN subscription_plans p ON p.code = 'starter_orb'
WHERE t.slug = 'default-orb-tenant'
  AND NOT EXISTS (
    SELECT 1 FROM tenant_subscriptions existing
    WHERE existing.tenant_id = t.id
  );

CREATE INDEX IF NOT EXISTS admin_users_tenant_idx ON admin_users(tenant_id);
CREATE INDEX IF NOT EXISTS users_tenant_idx ON users(tenant_id);
CREATE INDEX IF NOT EXISTS risk_profiles_tenant_idx ON risk_profiles(tenant_id);
CREATE INDEX IF NOT EXISTS trading_sessions_tenant_idx ON trading_sessions(tenant_id, symbol, session_date);
CREATE INDEX IF NOT EXISTS setup_candidates_tenant_idx ON setup_candidates(tenant_id, detected_at);
CREATE INDEX IF NOT EXISTS journal_entries_tenant_idx ON journal_entries(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS notifications_tenant_idx ON notifications(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS backtest_runs_tenant_idx ON backtest_runs(tenant_id, started_at);
