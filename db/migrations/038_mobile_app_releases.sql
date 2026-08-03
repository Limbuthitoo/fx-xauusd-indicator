CREATE TABLE IF NOT EXISTS mobile_app_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL DEFAULT 'android',
  version_name text NOT NULL,
  version_code integer,
  file_name text NOT NULL,
  storage_path text NOT NULL,
  download_path text NOT NULL,
  file_size_bytes bigint NOT NULL DEFAULT 0,
  sha256 text NOT NULL,
  changelog text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'ACTIVE',
  uploaded_by_admin_user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mobile_app_releases_platform_status_created
  ON mobile_app_releases(platform, status, created_at DESC);
