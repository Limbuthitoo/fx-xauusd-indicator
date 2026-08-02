CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_roles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  system_role BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_permissions (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS admin_role_permissions (
  role_id UUID NOT NULL REFERENCES admin_roles(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES admin_permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE IF NOT EXISTS admin_user_roles (
  user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES admin_roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  updated_by UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_user_id UUID REFERENCES admin_users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  old_value JSONB,
  new_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO admin_permissions (code, name, category, description)
VALUES
  ('dashboard.view', 'View Dashboard', 'Dashboard', 'Open the admin console.'),
  ('chart.view', 'View Live Chart', 'Live Chart', 'View realtime candles and indicators.'),
  ('signals.view', 'View ORB Signals', 'ORB Admin', 'View generated ORB BUY/SELL records.'),
  ('reports.view', 'View Reports', 'Reports', 'View weekly, monthly, and scenario performance.'),
  ('notifications.manage', 'Manage Notifications', 'Notifications', 'View and acknowledge notifications.'),
  ('permissions.manage', 'Manage Permissions', 'Permissions', 'View and maintain roles and permissions.'),
  ('settings.manage', 'Manage Settings', 'Settings', 'View and maintain trading/feed settings.'),
  ('data.manage', 'Manage Data Tools', 'Data Admin', 'Use replay, cache, and backtest tools.')
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  description = EXCLUDED.description;

INSERT INTO admin_roles (code, name, description, system_role)
VALUES
  ('owner_admin', 'Owner Admin', 'Full control over the ORB admin console.', true),
  ('trader_operator', 'Trader Operator', 'Live chart, ORB signal, report, and notification access.', true),
  ('analyst', 'Analyst', 'Read-only reports and ORB performance access.', true),
  ('data_admin', 'Data Admin', 'Feed diagnostics, cache, replay, and backtest access.', true)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  system_role = EXCLUDED.system_role,
  updated_at = now();

INSERT INTO admin_role_permissions (role_id, permission_code)
SELECT r.id, p.code
FROM admin_roles r
CROSS JOIN admin_permissions p
WHERE r.code = 'owner_admin'
ON CONFLICT DO NOTHING;

INSERT INTO admin_role_permissions (role_id, permission_code)
SELECT r.id, p.code
FROM admin_roles r
JOIN admin_permissions p ON p.code IN ('dashboard.view', 'chart.view', 'signals.view', 'reports.view', 'notifications.manage')
WHERE r.code = 'trader_operator'
ON CONFLICT DO NOTHING;

INSERT INTO admin_role_permissions (role_id, permission_code)
SELECT r.id, p.code
FROM admin_roles r
JOIN admin_permissions p ON p.code IN ('dashboard.view', 'signals.view', 'reports.view')
WHERE r.code = 'analyst'
ON CONFLICT DO NOTHING;

INSERT INTO admin_role_permissions (role_id, permission_code)
SELECT r.id, p.code
FROM admin_roles r
JOIN admin_permissions p ON p.code IN ('dashboard.view', 'data.manage', 'reports.view')
WHERE r.code = 'data_admin'
ON CONFLICT DO NOTHING;

INSERT INTO app_settings (key, value, category, description)
VALUES
  ('trading.symbol', '"XAUUSD"'::jsonb, 'Trading', 'Primary traded instrument.'),
  ('trading.timeframeMinutes', '5'::jsonb, 'Trading', 'Signal candle timeframe in minutes.'),
  ('trading.paperTrading', '{"enabled":true,"brokerExecution":false}'::jsonb, 'Trading', 'Paper trading and broker execution mode.'),
  ('orb.session', '{"timezone":"America/New_York","sessionStart":"09:30","tradeWindowEnd":"11:30","apiStartLeadMinutes":15}'::jsonb, 'ORB', 'New York ORB session schedule.'),
  ('feed.provider', '{"name":"TWELVE_DATA","rawCandleStorage":true,"cacheDays":7}'::jsonb, 'Feed', 'Market data provider and storage behavior.'),
  ('notifications.browser', '{"enabled":true}'::jsonb, 'Notifications', 'Browser notification preference.')
ON CONFLICT (key) DO NOTHING;
