-- Signal evaluation must never fail because a subscriber has not opened risk settings yet.
INSERT INTO users (display_name, tenant_id)
SELECT COALESCE(NULLIF(t.name, ''), 'Subscriber') || ' Paper Account', t.id
FROM platform_tenants t
WHERE t.status = 'ACTIVE'
  AND NOT EXISTS (
    SELECT 1
    FROM users u
    WHERE u.tenant_id = t.id
  );

INSERT INTO risk_profiles (
  tenant_id,
  user_id,
  name,
  account_balance,
  account_equity,
  account_currency,
  risk_per_trade_percent,
  maximum_daily_loss_percent,
  maximum_weekly_loss_percent,
  maximum_trades_per_session,
  maximum_consecutive_losses,
  mandatory_stop_loss,
  minimum_reward_to_risk,
  allow_martingale,
  allow_adding_to_loss,
  allow_moving_stop_farther,
  is_active
)
SELECT
  t.id,
  (SELECT u.id FROM users u WHERE u.tenant_id = t.id ORDER BY u.created_at LIMIT 1),
  'Automatic Paper Trading',
  10000,
  10000,
  'USD',
  0.25,
  0.75,
  2.0,
  1,
  3,
  true,
  1.5,
  false,
  false,
  false,
  true
FROM platform_tenants t
WHERE t.status = 'ACTIVE'
  AND NOT EXISTS (
    SELECT 1
    FROM risk_profiles rp
    WHERE rp.tenant_id = t.id
      AND rp.is_active = true
  );

CREATE INDEX IF NOT EXISTS risk_profiles_active_tenant_idx
  ON risk_profiles (tenant_id, created_at DESC)
  WHERE is_active = true;
