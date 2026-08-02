ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS max_admin_users INTEGER,
  ADD COLUMN IF NOT EXISTS max_notifications_per_month INTEGER,
  ADD COLUMN IF NOT EXISTS max_report_history_months INTEGER,
  ADD COLUMN IF NOT EXISTS automation_included BOOLEAN NOT NULL DEFAULT true;

UPDATE subscription_plans
SET
  max_admin_users = 2,
  max_notifications_per_month = 500,
  max_report_history_months = 3,
  automation_included = true
WHERE code = 'starter_orb';

UPDATE subscription_plans
SET
  max_admin_users = 10,
  max_notifications_per_month = 5000,
  max_report_history_months = 12,
  automation_included = true
WHERE code = 'professional_multi_strategy';

UPDATE subscription_plans
SET
  max_admin_users = NULL,
  max_notifications_per_month = NULL,
  max_report_history_months = NULL,
  automation_included = true
WHERE code = 'enterprise_platform';
