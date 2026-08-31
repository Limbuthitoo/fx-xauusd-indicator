UPDATE strategy_versions sv
SET configuration_json = jsonb_set(
  jsonb_set(
    COALESCE(sv.configuration_json, '{}'::jsonb),
    '{tradeSetup}',
    '{"enabledSessionPresets":["NEW_YORK_ORB"],"maximumSignalsPerDay":3}'::jsonb,
    true
  ),
  '{risk,minimumStopAtr}',
  '1.5'::jsonb,
  true
)
FROM strategies strategy
JOIN strategy_sources source ON source.id = strategy.source_id
WHERE sv.strategy_id = strategy.id
  AND COALESCE(sv.configuration_json->>'moduleCode', source.metadata->>'moduleCode', 'orb_max_options') = 'orb_max_options';

UPDATE tenant_module_settings
SET value = jsonb_set(
  jsonb_set(
    COALESCE(value, '{}'::jsonb),
    '{tradeSetup}',
    COALESCE(value->'tradeSetup', '{"enabledSessionPresets":["NEW_YORK_ORB"],"maximumSignalsPerDay":3}'::jsonb),
    true
  ),
  '{risk,minimumStopAtr}',
  COALESCE(value#>'{risk,minimumStopAtr}', '1.5'::jsonb),
  true
),
updated_at = now()
WHERE module_code = 'orb_max_options'
  AND key = 'orb.strategy';

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY tenant_id, admin_user_id, platform, device_name
           ORDER BY last_seen_at DESC NULLS LAST, created_at DESC, id
         ) AS rank
  FROM mobile_push_tokens
  WHERE enabled = true
)
UPDATE mobile_push_tokens token
SET enabled = false
FROM ranked
WHERE token.id = ranked.id
  AND ranked.rank > 1;

CREATE INDEX IF NOT EXISTS mobile_push_delivery_event_token_status_idx
  ON mobile_push_delivery_logs (event_key, mobile_push_token_id, status)
  WHERE event_key IS NOT NULL;
