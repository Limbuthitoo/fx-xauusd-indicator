ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS password_change_required BOOLEAN NOT NULL DEFAULT false;

UPDATE admin_users
SET password_change_required = false
WHERE platform_super_admin = true;
