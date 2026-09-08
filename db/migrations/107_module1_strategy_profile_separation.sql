ALTER TABLE setup_candidates
  ADD COLUMN IF NOT EXISTS strategy_profile text;

UPDATE setup_candidates
SET strategy_profile = CASE
  WHEN upper(scenario) LIKE '%HORIZONTAL%' THEN 'HORIZONTAL_RANGE_BREAKOUT'
  ELSE 'ORB_BREAKOUT'
END
WHERE module_code = 'orb_max_options'
  AND strategy_profile IS NULL;

CREATE OR REPLACE FUNCTION assign_module1_strategy_profile()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.module_code = 'orb_max_options' AND NEW.strategy_profile IS NULL THEN
    NEW.strategy_profile := CASE
      WHEN upper(NEW.scenario) LIKE '%HORIZONTAL%' THEN 'HORIZONTAL_RANGE_BREAKOUT'
      ELSE 'ORB_BREAKOUT'
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS setup_candidates_module1_strategy_profile_trg ON setup_candidates;
CREATE TRIGGER setup_candidates_module1_strategy_profile_trg
BEFORE INSERT OR UPDATE OF module_code, scenario, strategy_profile
ON setup_candidates
FOR EACH ROW
EXECUTE FUNCTION assign_module1_strategy_profile();

ALTER TABLE setup_candidates
  DROP CONSTRAINT IF EXISTS setup_candidates_module1_strategy_profile_check;
ALTER TABLE setup_candidates
  ADD CONSTRAINT setup_candidates_module1_strategy_profile_check
  CHECK (
    module_code <> 'orb_max_options'
    OR strategy_profile IN ('ORB_BREAKOUT', 'HORIZONTAL_RANGE_BREAKOUT')
  );

CREATE INDEX IF NOT EXISTS setup_candidates_module1_profile_history_idx
  ON setup_candidates (tenant_id, strategy_profile, detected_at DESC)
  WHERE module_code = 'orb_max_options';

UPDATE strategy_versions
SET configuration_json = jsonb_set(
      jsonb_set(
        COALESCE(configuration_json, '{}'::jsonb),
        '{tradeSetup}',
        '{"profileMode":"ORB_AND_HORIZONTAL"}'::jsonb
          || COALESCE(configuration_json->'tradeSetup', '{}'::jsonb),
        true
      ),
      '{strategyProfiles}',
      '{
          "orb": {
            "enabled": true,
            "signalWindowEnd": "11:00",
            "maximumSignalsPerDay": 1,
            "risk": {"minimumStopAtr": 2, "liquidityBufferAtr": 0.25}
          },
          "horizontal": {
            "enabled": true,
            "signalWindowStart": "11:00",
            "maximumSignalsPerDay": 1,
            "risk": {"minimumStopAtr": 2, "liquidityBufferAtr": 0.25}
          }
        }'::jsonb || COALESCE(configuration_json->'strategyProfiles', '{}'::jsonb),
      true
    ),
    activated_at = CASE WHEN status = 'ACTIVE' THEN now() ELSE activated_at END
WHERE configuration_json->>'moduleCode' = 'orb_max_options';

UPDATE tenant_module_settings
SET value = jsonb_set(
      jsonb_set(
        COALESCE(value, '{}'::jsonb),
        '{tradeSetup}',
        '{"profileMode":"ORB_AND_HORIZONTAL"}'::jsonb
          || COALESCE(value->'tradeSetup', '{}'::jsonb),
        true
      ),
      '{strategyProfiles}',
      '{
          "orb": {
            "enabled": true,
            "signalWindowEnd": "11:00",
            "maximumSignalsPerDay": 1,
            "risk": {"minimumStopAtr": 2, "liquidityBufferAtr": 0.25}
          },
          "horizontal": {
            "enabled": true,
            "signalWindowStart": "11:00",
            "maximumSignalsPerDay": 1,
            "risk": {"minimumStopAtr": 2, "liquidityBufferAtr": 0.25}
          }
        }'::jsonb || COALESCE(value->'strategyProfiles', '{}'::jsonb),
      true
    ),
    description = 'Module 1 ORB and Horizontal Breakout profiles with independent windows, limits, and risk settings.',
    updated_at = now()
WHERE module_code = 'orb_max_options'
  AND key = 'orb.strategy';

COMMENT ON COLUMN setup_candidates.strategy_profile IS
  'First-class strategy identity. Module 1 uses ORB_BREAKOUT or HORIZONTAL_RANGE_BREAKOUT instead of inferring ownership in reporting and controls.';
