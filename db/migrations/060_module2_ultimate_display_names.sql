UPDATE platform_strategy_modules
SET
  name = 'Module 2: Ultimate Liquidity Sweep',
  description = 'Automated XAUUSD Ultimate Liquidity Sweep + Structure Confirmation strategy family: liquidity sweep rejection, displacement, BOS/MSS/CHoCH, FVG/order-block retest, variant gating, paper trading, checklist, alerts, reports, and learning.',
  target_win_rate = 'Backtest-proven only; production target depends on variant metrics',
  updated_at = now()
WHERE code = 'high_probability_strategy_2';

UPDATE strategy_sources
SET
  strategy_name = 'Ultimate Liquidity Sweep + Structure Confirmation',
  metadata = COALESCE(metadata, '{}'::jsonb) || '{"moduleCode":"high_probability_strategy_2","strategyFamily":"ULTIMATE_LIQUIDITY_SWEEP","version":"ULTIMATE_LIQUIDITY_SWEEP_V1.0"}'::jsonb
WHERE metadata->>'moduleCode' = 'high_probability_strategy_2'
   OR id = '00000000-0000-0000-0000-000000000202';

UPDATE strategies
SET
  name = 'Ultimate Liquidity Sweep + Structure Confirmation',
  description = 'Module 2 strategy family for XAUUSD liquidity sweeps, rejection, displacement, BOS/MSS/CHoCH, FVG/order-block retest entries, and variant-gated paper trading.'
WHERE id = '00000000-0000-0000-0000-000000000302';

UPDATE strategy_versions sv
SET configuration_json = COALESCE(sv.configuration_json, '{}'::jsonb)
  || '{"name":"Ultimate Liquidity Sweep + Structure Confirmation","strategyFamily":"ULTIMATE_LIQUIDITY_SWEEP","version":"ULTIMATE_LIQUIDITY_SWEEP_V1.0"}'::jsonb
FROM strategies s
WHERE s.id = sv.strategy_id
  AND s.id = '00000000-0000-0000-0000-000000000302';

UPDATE tenant_module_settings
SET
  category = 'Ultimate Liquidity Sweep',
  description = 'User-account Module 2 thresholds for XAUUSD Ultimate Liquidity Sweep + Structure Confirmation paper-trade automation.',
  updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND key = 'liquiditySweep.strategy';
