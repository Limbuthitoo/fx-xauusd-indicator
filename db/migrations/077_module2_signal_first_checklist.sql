UPDATE strategy_versions
SET configuration_json = jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(configuration_json, '{}'::jsonb),
          '{maximumTradesPerSession}',
          '2'::jsonb,
          true
        ),
        '{maximumActiveSetupsPerSymbol}',
        '2'::jsonb,
        true
      ),
      '{maximumActivePositions}',
      '2'::jsonb,
      true
    )
WHERE configuration_json->>'moduleCode' = 'high_probability_strategy_2';

UPDATE tenant_module_settings
SET value = jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(value, '{}'::jsonb),
          '{maximumTradesPerSession}',
          '2'::jsonb,
          true
        ),
        '{maximumActiveSetupsPerSymbol}',
        '2'::jsonb,
        true
      ),
      '{maximumActivePositions}',
      '2'::jsonb,
      true
    ),
    updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND key = 'liquiditySweep.strategy';

UPDATE risk_profiles
SET maximum_trades_per_session = GREATEST(maximum_trades_per_session, 2)
WHERE is_active = true;

UPDATE strategy_versions
SET configuration_json = jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(configuration_json, '{}'::jsonb),
          '{favorability,minimumScoreForPaperTrade}',
          '80'::jsonb,
          true
        ),
        '{risk,maximumTradesPerSession}',
        '2'::jsonb,
        true
      ),
      '{paperTrading,maximumTradesPerSession}',
      '2'::jsonb,
      true
    )
WHERE configuration_json->>'moduleCode' = 'orb_max_options';

UPDATE tenant_module_settings
SET value = jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(value, '{}'::jsonb),
          '{favorability,minimumScoreForPaperTrade}',
          '80'::jsonb,
          true
        ),
        '{risk,maximumTradesPerSession}',
        '2'::jsonb,
        true
      ),
      '{paperTrading,maximumTradesPerSession}',
      '2'::jsonb,
      true
    ),
    updated_at = now()
WHERE module_code = 'orb_max_options'
  AND key = 'orb.strategy';
