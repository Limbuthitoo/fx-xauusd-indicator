CREATE TABLE IF NOT EXISTS module2_strategy_variants (
  code TEXT PRIMARY KEY,
  module_code TEXT NOT NULL REFERENCES platform_strategy_modules(code) ON DELETE CASCADE DEFAULT 'high_probability_strategy_2',
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('RESEARCH', 'ENTRY_GRADE', 'PRODUCTION')),
  approval_status TEXT NOT NULL CHECK (approval_status IN ('RESEARCH_ONLY', 'PAPER_APPROVED', 'PRODUCTION_APPROVED')),
  paper_eligible BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 100,
  required_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO module2_strategy_variants (
  code,
  version,
  name,
  description,
  category,
  approval_status,
  paper_eligible,
  sort_order,
  required_rules
)
VALUES
  (
    'SWEEP_CLOSE_BACK_INSIDE',
    'ULTIMATE_LIQUIDITY_SWEEP_V1.0',
    'Sweep + Close Back Inside',
    'Research-only stop-run evidence. Price sweeps a potential liquidity level and closes back inside.',
    'RESEARCH',
    'RESEARCH_ONLY',
    false,
    10,
    '["LIQUIDITY_SWEEP_CONFIRMED","SWEEP_REJECTION_CONFIRMED"]'::jsonb
  ),
  (
    'SWEEP_NO_CONFIRMATION',
    'ULTIMATE_LIQUIDITY_SWEEP_V1.0',
    'Sweep + No Confirmation',
    'Research-only negative-control variant used to prove why sweep alone should not open a trade.',
    'RESEARCH',
    'RESEARCH_ONLY',
    false,
    20,
    '["LIQUIDITY_SWEEP_CONFIRMED"]'::jsonb
  ),
  (
    'SWEEP_ENGULFING',
    'ULTIMATE_LIQUIDITY_SWEEP_V1.0',
    'Sweep + Engulfing',
    'Research-only candle-pattern confirmation after a sweep. It needs structure and retest before paper entry.',
    'RESEARCH',
    'RESEARCH_ONLY',
    false,
    30,
    '["LIQUIDITY_SWEEP_CONFIRMED","CONFIRM_ENGULFING"]'::jsonb
  ),
  (
    'SWEEP_BOS',
    'ULTIMATE_LIQUIDITY_SWEEP_V1.0',
    'Sweep + BOS',
    'Research-only continuation structure-break variant used for backtest comparison.',
    'RESEARCH',
    'RESEARCH_ONLY',
    false,
    40,
    '["LIQUIDITY_SWEEP_CONFIRMED","BOS_CHOCH_CONFIRMED"]'::jsonb
  ),
  (
    'SWEEP_MSS',
    'ULTIMATE_LIQUIDITY_SWEEP_V1.0',
    'Sweep + MSS',
    'Research-only reversal market-structure-shift variant before entry-zone confirmation.',
    'RESEARCH',
    'RESEARCH_ONLY',
    false,
    50,
    '["LIQUIDITY_SWEEP_CONFIRMED","REVERSAL_MSS"]'::jsonb
  ),
  (
    'SWEEP_VOLUME_EXPANSION',
    'ULTIMATE_LIQUIDITY_SWEEP_V1.0',
    'Sweep + Volume Expansion',
    'Record-only volume expansion variant. Twelve Data volume coverage can be incomplete, so it is not a hard trade gate.',
    'RESEARCH',
    'RESEARCH_ONLY',
    false,
    60,
    '["LIQUIDITY_SWEEP_CONFIRMED","CONFIRM_VOLUME_EXPANSION"]'::jsonb
  ),
  (
    'SWEEP_DISPLACEMENT_RETEST',
    'ULTIMATE_LIQUIDITY_SWEEP_V1.0',
    'Sweep + Displacement + Retest',
    'Entry-grade variant requiring sweep, strong displacement, retest, confirmation candle, and valid risk.',
    'ENTRY_GRADE',
    'PAPER_APPROVED',
    true,
    70,
    '["LIQUIDITY_SWEEP_CONFIRMED","DISPLACEMENT_CONFIRMED","ENTRY_ZONE_RETRACE","CONFIRM_ENTRY_CANDLE","RISK_OK"]'::jsonb
  ),
  (
    'SWEEP_EMA_ALIGNMENT',
    'ULTIMATE_LIQUIDITY_SWEEP_V1.0',
    'Sweep + EMA Alignment',
    'Entry-grade variant using 15M bias/EMA alignment as a quality booster with retest and confirmation candle.',
    'ENTRY_GRADE',
    'PAPER_APPROVED',
    true,
    80,
    '["LIQUIDITY_SWEEP_CONFIRMED","CONFIRM_EMA_200","ENTRY_ZONE_RETRACE","CONFIRM_ENTRY_CANDLE","RISK_OK"]'::jsonb
  ),
  (
    'SWEEP_BOS_RETEST',
    'ULTIMATE_LIQUIDITY_SWEEP_V1.0',
    'Sweep + BOS + Retest',
    'Production paper variant requiring sweep, BOS/CHoCH, fresh zone, retest, confirmation candle, and valid risk.',
    'PRODUCTION',
    'PRODUCTION_APPROVED',
    true,
    90,
    '["LIQUIDITY_SWEEP_CONFIRMED","BOS_CHOCH_CONFIRMED","ENTRY_ZONE_READY","ENTRY_ZONE_RETRACE","CONFIRM_ENTRY_CANDLE","RISK_OK"]'::jsonb
  ),
  (
    'SWEEP_MSS_RETEST',
    'ULTIMATE_LIQUIDITY_SWEEP_V1.0',
    'Sweep + MSS + Retest',
    'Production reversal variant requiring sweep, market-structure shift, fresh zone, retest, confirmation candle, and valid risk.',
    'PRODUCTION',
    'PRODUCTION_APPROVED',
    true,
    100,
    '["LIQUIDITY_SWEEP_CONFIRMED","REVERSAL_MSS","ENTRY_ZONE_READY","ENTRY_ZONE_RETRACE","CONFIRM_ENTRY_CANDLE","RISK_OK"]'::jsonb
  ),
  (
    'SWEEP_MSS_DISPLACEMENT_RETEST',
    'ULTIMATE_LIQUIDITY_SWEEP_V1.0',
    'Sweep + MSS + Displacement + Retest',
    'Highest-priority production variant: sweep rejection, displacement, reversal MSS, fresh entry zone, retest, confirmation candle, and risk validation.',
    'PRODUCTION',
    'PRODUCTION_APPROVED',
    true,
    110,
    '["LIQUIDITY_SWEEP_CONFIRMED","DISPLACEMENT_CONFIRMED","REVERSAL_MSS","ENTRY_ZONE_READY","ENTRY_ZONE_RETRACE","CONFIRM_ENTRY_CANDLE","RISK_OK"]'::jsonb
  )
ON CONFLICT (code) DO UPDATE SET
  version = EXCLUDED.version,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  approval_status = EXCLUDED.approval_status,
  paper_eligible = EXCLUDED.paper_eligible,
  sort_order = EXCLUDED.sort_order,
  required_rules = EXCLUDED.required_rules,
  updated_at = now();

CREATE INDEX IF NOT EXISTS module2_strategy_variants_module_idx
  ON module2_strategy_variants(module_code, paper_eligible, sort_order);
