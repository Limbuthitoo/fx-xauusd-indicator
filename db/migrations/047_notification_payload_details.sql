ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS notifications_tenant_data_module_idx
  ON notifications(tenant_id, ((data->>'moduleCode')), created_at DESC);
