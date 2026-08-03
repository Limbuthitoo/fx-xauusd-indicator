ALTER TABLE mobile_app_releases
  ADD COLUMN IF NOT EXISTS package_name TEXT;

CREATE INDEX IF NOT EXISTS idx_mobile_app_releases_platform_version
  ON mobile_app_releases(platform, status, version_code DESC NULLS LAST, created_at DESC);
