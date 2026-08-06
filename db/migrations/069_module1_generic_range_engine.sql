UPDATE strategy_versions sv
SET configuration_json = jsonb_set(
  COALESCE(sv.configuration_json, '{}'::jsonb),
  '{rangeEngine}',
  '{
    "enabled": true,
    "detectorVersion": "GENERIC_RANGE_ENGINE_V1",
    "authoritativeDetector": "MAX_OPTIONS_ORB",
    "preserveOrbBehavior": true,
    "horizontalRange": {
      "enabled": true,
      "observationOnly": true,
      "scope": "NEW_YORK_SESSION_ONLY",
      "timeframe": "5min",
      "minimumRangeCandles": 12,
      "maximumRangeCandles": 60,
      "minimumUpperTouches": 2,
      "minimumLowerTouches": 2,
      "minimumBarsBetweenTouches": 2,
      "boundaryReactionCount": 3,
      "boundaryToleranceAtr": 0.08,
      "minimumContainmentRatio": 0.75,
      "maximumEfficiencyRatio": 0.35,
      "maximumBoundarySlopeAtrPerBar": 0.02,
      "minimumWidthAtr": 0.8,
      "maximumWidthAtr": 4,
      "minimumMidpointCrosses": 2,
      "minimumQualityScore": 70,
      "lockAfterValidation": true,
      "expireAfterCandles": 60
    }
  }'::jsonb,
  true
)
FROM strategies s
JOIN strategy_sources src ON src.id = s.source_id
WHERE s.id = sv.strategy_id
  AND COALESCE(sv.configuration_json->>'moduleCode', src.metadata->>'moduleCode', 'orb_max_options') = 'orb_max_options';

UPDATE tenant_module_settings
SET value = jsonb_set(
  COALESCE(value, '{}'::jsonb),
  '{rangeEngine}',
  '{
    "enabled": true,
    "detectorVersion": "GENERIC_RANGE_ENGINE_V1",
    "authoritativeDetector": "MAX_OPTIONS_ORB",
    "preserveOrbBehavior": true,
    "horizontalRange": {
      "enabled": true,
      "observationOnly": true,
      "scope": "NEW_YORK_SESSION_ONLY",
      "timeframe": "5min",
      "minimumRangeCandles": 12,
      "maximumRangeCandles": 60,
      "minimumUpperTouches": 2,
      "minimumLowerTouches": 2,
      "minimumBarsBetweenTouches": 2,
      "boundaryReactionCount": 3,
      "boundaryToleranceAtr": 0.08,
      "minimumContainmentRatio": 0.75,
      "maximumEfficiencyRatio": 0.35,
      "maximumBoundarySlopeAtrPerBar": 0.02,
      "minimumWidthAtr": 0.8,
      "maximumWidthAtr": 4,
      "minimumMidpointCrosses": 2,
      "minimumQualityScore": 70,
      "lockAfterValidation": true,
      "expireAfterCandles": 60
    }
  }'::jsonb,
  true
)
WHERE module_code = 'orb_max_options'
  AND key = 'orb.strategy';
