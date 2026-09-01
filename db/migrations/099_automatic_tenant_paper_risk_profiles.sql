CREATE OR REPLACE FUNCTION provision_tenant_paper_risk_profile(target_tenant_id UUID, target_name TEXT)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  paper_user_id UUID;
BEGIN
  SELECT id
  INTO paper_user_id
  FROM users
  WHERE tenant_id = target_tenant_id
  ORDER BY created_at
  LIMIT 1;

  IF paper_user_id IS NULL THEN
    INSERT INTO users (display_name, tenant_id)
    VALUES (COALESCE(NULLIF(target_name, ''), 'Subscriber') || ' Paper Account', target_tenant_id)
    RETURNING id INTO paper_user_id;
  END IF;

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
    target_tenant_id,
    paper_user_id,
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
  WHERE NOT EXISTS (
    SELECT 1
    FROM risk_profiles
    WHERE tenant_id = target_tenant_id
      AND is_active = true
  );
END;
$$;

CREATE OR REPLACE FUNCTION ensure_tenant_paper_risk_profile()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'ACTIVE' THEN
    PERFORM provision_tenant_paper_risk_profile(NEW.id, NEW.name);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS platform_tenant_paper_risk_profile_trigger ON platform_tenants;

CREATE TRIGGER platform_tenant_paper_risk_profile_trigger
AFTER INSERT OR UPDATE OF status ON platform_tenants
FOR EACH ROW
EXECUTE FUNCTION ensure_tenant_paper_risk_profile();

DO $$
DECLARE
  tenant_row RECORD;
BEGIN
  FOR tenant_row IN
    SELECT id, name FROM platform_tenants WHERE status = 'ACTIVE'
  LOOP
    PERFORM provision_tenant_paper_risk_profile(tenant_row.id, tenant_row.name);
  END LOOP;
END;
$$;
