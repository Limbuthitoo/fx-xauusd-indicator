DELETE FROM backtest_runs
WHERE module_code = 'strategy_lab_3'
   OR strategy_version_id IN (
     SELECT sv.id
     FROM strategy_versions sv
     JOIN strategies s ON s.id = sv.strategy_id
     JOIN strategy_sources src ON src.id = s.source_id
     WHERE sv.configuration_json->>'moduleCode' = 'strategy_lab_3'
        OR src.metadata->>'moduleCode' = 'strategy_lab_3'
   );

DELETE FROM trades t
USING trade_plans tp, setup_candidates sc
WHERE t.trade_plan_id = tp.id
  AND tp.setup_candidate_id = sc.id
  AND (
    sc.module_code = 'strategy_lab_3'
    OR sc.strategy_version_id IN (
      SELECT sv.id
      FROM strategy_versions sv
      JOIN strategies s ON s.id = sv.strategy_id
      JOIN strategy_sources src ON src.id = s.source_id
      WHERE sv.configuration_json->>'moduleCode' = 'strategy_lab_3'
         OR src.metadata->>'moduleCode' = 'strategy_lab_3'
    )
  );

DELETE FROM trade_plans tp
USING setup_candidates sc
WHERE tp.setup_candidate_id = sc.id
  AND (
    sc.module_code = 'strategy_lab_3'
    OR sc.strategy_version_id IN (
      SELECT sv.id
      FROM strategy_versions sv
      JOIN strategies s ON s.id = sv.strategy_id
      JOIN strategy_sources src ON src.id = s.source_id
      WHERE sv.configuration_json->>'moduleCode' = 'strategy_lab_3'
         OR src.metadata->>'moduleCode' = 'strategy_lab_3'
    )
  );

DELETE FROM trading_sessions
WHERE module_code = 'strategy_lab_3'
   OR strategy_version_id IN (
     SELECT sv.id
     FROM strategy_versions sv
     JOIN strategies s ON s.id = sv.strategy_id
     JOIN strategy_sources src ON src.id = s.source_id
     WHERE sv.configuration_json->>'moduleCode' = 'strategy_lab_3'
        OR src.metadata->>'moduleCode' = 'strategy_lab_3'
   );

DELETE FROM setup_candidates
WHERE module_code = 'strategy_lab_3'
   OR strategy_version_id IN (
     SELECT sv.id
     FROM strategy_versions sv
     JOIN strategies s ON s.id = sv.strategy_id
     JOIN strategy_sources src ON src.id = s.source_id
     WHERE sv.configuration_json->>'moduleCode' = 'strategy_lab_3'
        OR src.metadata->>'moduleCode' = 'strategy_lab_3'
   );

DELETE FROM module_session_closeouts
WHERE module_code = 'strategy_lab_3';

DELETE FROM module_session_reports
WHERE module_code = 'strategy_lab_3';

DELETE FROM module_learning_reviews
WHERE module_code = 'strategy_lab_3';

DELETE FROM module_learning_recommendations
WHERE module_code = 'strategy_lab_3';

DELETE FROM module_learning_runs
WHERE module_code = 'strategy_lab_3';

DELETE FROM module_tuning_promotions
WHERE module_code = 'strategy_lab_3';

DELETE FROM module_launch_rehearsals
WHERE module_code = 'strategy_lab_3';

DELETE FROM tenant_module_settings
WHERE module_code = 'strategy_lab_3'
   OR key = 'vwapOpeningDrive.strategy';

DELETE FROM tenant_automation_states
WHERE module_code = 'strategy_lab_3';

DELETE FROM tenant_modules
WHERE module_id IN (
  SELECT id FROM platform_strategy_modules WHERE code = 'strategy_lab_3'
);

DELETE FROM subscription_plan_modules
WHERE module_id IN (
  SELECT id FROM platform_strategy_modules WHERE code = 'strategy_lab_3'
);

UPDATE platform_support_tickets
SET requested_module_code = NULL,
    updated_at = now()
WHERE requested_module_code = 'strategy_lab_3';

DELETE FROM strategy_versions
WHERE configuration_json->>'moduleCode' = 'strategy_lab_3'
   OR strategy_id IN (
     SELECT s.id
     FROM strategies s
     JOIN strategy_sources src ON src.id = s.source_id
     WHERE src.metadata->>'moduleCode' = 'strategy_lab_3'
   );

DELETE FROM strategies
WHERE source_id IN (
  SELECT id FROM strategy_sources WHERE metadata->>'moduleCode' = 'strategy_lab_3'
);

DELETE FROM strategy_sources
WHERE metadata->>'moduleCode' = 'strategy_lab_3';

DELETE FROM platform_strategy_modules
WHERE code = 'strategy_lab_3';
