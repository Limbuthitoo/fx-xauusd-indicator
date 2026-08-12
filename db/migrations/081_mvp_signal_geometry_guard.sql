UPDATE setup_candidates sc
SET status = 'INVALIDATED',
    final_reason = concat_ws(
      ' ',
      NULLIF(sc.final_reason, ''),
      'Invalid directional entry/stop/target geometry was rejected by the production MVP audit.'
    ),
    scenario_flags = COALESCE(sc.scenario_flags, '{}'::jsonb) || jsonb_build_object(
      'invalidatedBy', 'MVP_SIGNAL_GEOMETRY_GUARD',
      'invalidatedAt', now()
    )
WHERE sc.module_code IN ('orb_max_options', 'high_probability_strategy_2')
  AND sc.status IN ('LONG SETUP READY', 'SHORT SETUP READY')
  AND NOT EXISTS (
    SELECT 1
    FROM trade_plans tp
    WHERE tp.setup_candidate_id = sc.id
  )
  AND NOT (
    (sc.direction = 'LONG' AND sc.stop_price < sc.entry_price AND sc.entry_price < sc.target_price)
    OR (sc.direction = 'SHORT' AND sc.target_price < sc.entry_price AND sc.entry_price < sc.stop_price)
  );
