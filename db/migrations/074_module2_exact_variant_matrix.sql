UPDATE module2_strategy_variants
SET
  category = 'ENTRY_GRADE',
  approval_status = 'PAPER_APPROVED',
  paper_eligible = true,
  name = 'A. Sweep + Close Back Inside',
  description = 'Variant A. Price sweeps valid liquidity, closes back inside, then passes risk and confidence gates.',
  required_rules = '["LIQUIDITY_SWEEP_CONFIRMED","SWEEP_REJECTION_CONFIRMED","RISK_OK","SIGNAL_SCORE"]'::jsonb,
  sort_order = 10,
  updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND code = 'SWEEP_CLOSE_BACK_INSIDE';

UPDATE module2_strategy_variants
SET
  category = 'ENTRY_GRADE',
  approval_status = 'PAPER_APPROVED',
  paper_eligible = true,
  name = 'B. Sweep + BOS',
  description = 'Variant B. Liquidity sweep plus continuation BOS, then risk and confidence gates.',
  required_rules = '["LIQUIDITY_SWEEP_CONFIRMED","SWEEP_REJECTION_CONFIRMED","CONTINUATION_BOS","RISK_OK","SIGNAL_SCORE"]'::jsonb,
  sort_order = 20,
  updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND code = 'SWEEP_BOS';

UPDATE module2_strategy_variants
SET
  category = 'ENTRY_GRADE',
  approval_status = 'PAPER_APPROVED',
  paper_eligible = true,
  name = 'C. Sweep + MSS',
  description = 'Variant C. Liquidity sweep plus reversal market-structure shift, then risk and confidence gates.',
  required_rules = '["LIQUIDITY_SWEEP_CONFIRMED","SWEEP_REJECTION_CONFIRMED","REVERSAL_MSS","MSS_STRENGTH","RISK_OK","SIGNAL_SCORE"]'::jsonb,
  sort_order = 30,
  updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND code = 'SWEEP_MSS';

UPDATE module2_strategy_variants
SET
  category = 'ENTRY_GRADE',
  approval_status = 'PAPER_APPROVED',
  paper_eligible = true,
  name = 'D. Sweep + Engulfing',
  description = 'Variant D. Liquidity sweep plus engulfing rejection candle, then risk and confidence gates.',
  required_rules = '["LIQUIDITY_SWEEP_CONFIRMED","CONFIRM_ENGULFING","RISK_OK","SIGNAL_SCORE"]'::jsonb,
  sort_order = 40,
  updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND code = 'SWEEP_ENGULFING';

UPDATE module2_strategy_variants
SET
  category = 'PRODUCTION',
  approval_status = 'PRODUCTION_APPROVED',
  paper_eligible = true,
  name = 'E. Sweep + BOS + Retest',
  description = 'Variant E. Liquidity sweep, continuation BOS, entry-zone retest, risk, and confidence gates.',
  required_rules = '["LIQUIDITY_SWEEP_CONFIRMED","CONTINUATION_BOS","ENTRY_ZONE_RETRACE","RISK_OK","SIGNAL_SCORE"]'::jsonb,
  sort_order = 50,
  updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND code = 'SWEEP_BOS_RETEST';

UPDATE module2_strategy_variants
SET
  category = 'PRODUCTION',
  approval_status = 'PRODUCTION_APPROVED',
  paper_eligible = true,
  name = 'F. Sweep + MSS + Retest',
  description = 'Variant F. Liquidity sweep, reversal MSS, retest confirmation, risk, and confidence gates.',
  required_rules = '["LIQUIDITY_SWEEP_CONFIRMED","REVERSAL_MSS","MSS_STRENGTH","ENTRY_ZONE_READY","ENTRY_ZONE_RETRACE","CONFIRM_ENTRY_CANDLE","RISK_OK","SIGNAL_SCORE"]'::jsonb,
  sort_order = 60,
  updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND code = 'SWEEP_MSS_RETEST';

UPDATE module2_strategy_variants
SET
  category = 'ENTRY_GRADE',
  approval_status = 'PAPER_APPROVED',
  paper_eligible = true,
  name = 'G. Sweep + EMA Alignment',
  description = 'Variant G. Liquidity sweep with EMA alignment, then risk and confidence gates.',
  required_rules = '["LIQUIDITY_SWEEP_CONFIRMED","CONFIRM_EMA_200","RISK_OK","SIGNAL_SCORE"]'::jsonb,
  sort_order = 70,
  updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND code = 'SWEEP_EMA_ALIGNMENT';

UPDATE module2_strategy_variants
SET
  category = 'ENTRY_GRADE',
  approval_status = 'PAPER_APPROVED',
  paper_eligible = true,
  name = 'H. Sweep + Volume Expansion',
  description = 'Variant H. Liquidity sweep with usable volume expansion, then risk and confidence gates.',
  required_rules = '["LIQUIDITY_SWEEP_CONFIRMED","CONFIRM_VOLUME_EXPANSION","RISK_OK","SIGNAL_SCORE"]'::jsonb,
  sort_order = 80,
  updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND code = 'SWEEP_VOLUME_EXPANSION';

UPDATE module2_strategy_variants
SET
  category = 'PRODUCTION',
  approval_status = 'PRODUCTION_APPROVED',
  paper_eligible = true,
  name = 'I. Sweep + MSS + Displacement + Retest',
  description = 'Variant I. Highest-confirmation profile: sweep, reversal MSS, displacement, retest, risk, and confidence gates.',
  required_rules = '["LIQUIDITY_SWEEP_CONFIRMED","REVERSAL_MSS","DISPLACEMENT_CONFIRMED","ENTRY_ZONE_RETRACE","RISK_OK","SIGNAL_SCORE"]'::jsonb,
  sort_order = 90,
  updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND code = 'SWEEP_MSS_DISPLACEMENT_RETEST';

UPDATE module2_strategy_variants
SET
  category = 'RESEARCH',
  approval_status = 'RESEARCH_ONLY',
  paper_eligible = false,
  name = 'J. Sweep + No Confirmation',
  description = 'Variant J. Sweep-only control profile for backtesting and missed-trade research. It must not open paper trades.',
  required_rules = '["LIQUIDITY_SWEEP_CONFIRMED"]'::jsonb,
  sort_order = 100,
  updated_at = now()
WHERE module_code = 'high_probability_strategy_2'
  AND code = 'SWEEP_NO_CONFIRMATION';

DELETE FROM module2_strategy_variants
WHERE module_code = 'high_probability_strategy_2'
  AND code = 'SWEEP_DISPLACEMENT_RETEST';
