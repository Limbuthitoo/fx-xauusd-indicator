UPDATE module2_strategy_variants
SET
  category = 'ENTRY_GRADE',
  approval_status = 'PAPER_APPROVED',
  paper_eligible = true,
  description = 'Variant A. Sweep and close-back-inside profile. Actionable after risk approval; lower confirmation than structure profiles.',
  required_rules = '["LIQUIDITY_SWEEP_CONFIRMED","SWEEP_REJECTION_CONFIRMED"]'::jsonb,
  sort_order = 10,
  updated_at = now()
WHERE code = 'SWEEP_CLOSE_BACK_INSIDE';

UPDATE module2_strategy_variants
SET
  category = 'ENTRY_GRADE',
  approval_status = 'PAPER_APPROVED',
  paper_eligible = true,
  description = 'Variant B. Sweep, close-back-inside, and continuation BOS profile. Actionable after risk approval.',
  required_rules = '["LIQUIDITY_SWEEP_CONFIRMED","SWEEP_REJECTION_CONFIRMED","CONTINUATION_BOS"]'::jsonb,
  sort_order = 30,
  updated_at = now()
WHERE code = 'SWEEP_BOS';

UPDATE module2_strategy_variants
SET
  category = 'ENTRY_GRADE',
  approval_status = 'PAPER_APPROVED',
  paper_eligible = true,
  description = 'Variant C. Sweep, close-back-inside, and reversal MSS profile. Recommended baseline for XAUUSD; actionable after risk approval.',
  required_rules = '["LIQUIDITY_SWEEP_CONFIRMED","SWEEP_REJECTION_CONFIRMED","REVERSAL_MSS"]'::jsonb,
  sort_order = 40,
  updated_at = now()
WHERE code = 'SWEEP_MSS';

UPDATE module2_strategy_variants
SET
  category = 'ENTRY_GRADE',
  approval_status = 'PAPER_APPROVED',
  paper_eligible = true,
  description = 'Variant D. Sweep plus engulfing confirmation profile. Actionable after risk approval.',
  required_rules = '["LIQUIDITY_SWEEP_CONFIRMED","CONFIRM_ENGULFING"]'::jsonb,
  sort_order = 20,
  updated_at = now()
WHERE code = 'SWEEP_ENGULFING';

UPDATE module2_strategy_variants
SET
  description = 'Variant E. Sweep, continuation BOS, and retest profile. Production-approved after risk approval.',
  required_rules = '["LIQUIDITY_SWEEP_CONFIRMED","CONTINUATION_BOS","ENTRY_ZONE_RETRACE"]'::jsonb,
  sort_order = 70,
  updated_at = now()
WHERE code = 'SWEEP_BOS_RETEST';

UPDATE module2_strategy_variants
SET
  description = 'Variant F. Sweep, reversal MSS, and retest profile. Recommended production profile after risk approval.',
  required_rules = '["LIQUIDITY_SWEEP_CONFIRMED","REVERSAL_MSS","ENTRY_ZONE_RETRACE"]'::jsonb,
  sort_order = 80,
  updated_at = now()
WHERE code = 'SWEEP_MSS_RETEST';

UPDATE module2_strategy_variants
SET
  category = 'ENTRY_GRADE',
  approval_status = 'PAPER_APPROVED',
  paper_eligible = true,
  description = 'Variant G. Sweep plus EMA alignment profile. Actionable after risk approval.',
  required_rules = '["LIQUIDITY_SWEEP_CONFIRMED","CONFIRM_EMA_200"]'::jsonb,
  sort_order = 50,
  updated_at = now()
WHERE code = 'SWEEP_EMA_ALIGNMENT';

UPDATE module2_strategy_variants
SET
  category = 'ENTRY_GRADE',
  approval_status = 'PAPER_APPROVED',
  paper_eligible = true,
  description = 'Variant H. Sweep plus volume expansion profile. Actionable after risk approval, but provider volume quality must be reviewed.',
  required_rules = '["LIQUIDITY_SWEEP_CONFIRMED","CONFIRM_VOLUME_EXPANSION"]'::jsonb,
  sort_order = 60,
  updated_at = now()
WHERE code = 'SWEEP_VOLUME_EXPANSION';

UPDATE module2_strategy_variants
SET
  description = 'Variant I. Sweep, reversal MSS, displacement, and retest profile. Highest-confirmation production profile after risk approval.',
  required_rules = '["LIQUIDITY_SWEEP_CONFIRMED","REVERSAL_MSS","DISPLACEMENT_CONFIRMED","ENTRY_ZONE_RETRACE"]'::jsonb,
  sort_order = 90,
  updated_at = now()
WHERE code = 'SWEEP_MSS_DISPLACEMENT_RETEST';

UPDATE module2_strategy_variants
SET
  category = 'RESEARCH',
  approval_status = 'RESEARCH_ONLY',
  paper_eligible = false,
  description = 'Variant J. Sweep-only negative-control profile for backtesting comparison. It must not open paper trades.',
  required_rules = '["LIQUIDITY_SWEEP_CONFIRMED"]'::jsonb,
  sort_order = 100,
  updated_at = now()
WHERE code = 'SWEEP_NO_CONFIRMATION';
