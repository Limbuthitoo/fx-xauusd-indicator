UPDATE strategy_versions sv
SET configuration_json = jsonb_set(
  COALESCE(sv.configuration_json, '{}'::jsonb),
  '{newsFilter}',
  COALESCE(sv.configuration_json->'newsFilter', '{}'::jsonb) || jsonb_build_object(
    'enabled', COALESCE((sv.configuration_json#>>'{newsFilter,enabled}')::boolean, true),
    'mode', CASE
      WHEN COALESCE(sv.configuration_json#>>'{newsFilter,mode}', 'BLOCK') LIKE 'BLOCK%' THEN 'BLOCK'
      WHEN sv.configuration_json#>>'{newsFilter,mode}' = 'WARN_ONLY' THEN 'WARN_ONLY'
      ELSE 'OFF'
    END,
    'manualEvents', true
  ),
  true
)
FROM strategies strategy
JOIN strategy_sources source ON source.id = strategy.source_id
WHERE sv.strategy_id = strategy.id
  AND COALESCE(sv.configuration_json->>'moduleCode', source.metadata->>'moduleCode', 'orb_max_options') = 'orb_max_options';

UPDATE tenant_module_settings
SET value = jsonb_set(
  COALESCE(value, '{}'::jsonb),
  '{newsFilter}',
  COALESCE(value->'newsFilter', '{}'::jsonb) || jsonb_build_object(
    'enabled', COALESCE((value#>>'{newsFilter,enabled}')::boolean, true),
    'mode', CASE
      WHEN COALESCE(value#>>'{newsFilter,mode}', 'BLOCK') LIKE 'BLOCK%' THEN 'BLOCK'
      WHEN value#>>'{newsFilter,mode}' = 'WARN_ONLY' THEN 'WARN_ONLY'
      ELSE 'OFF'
    END,
    'manualEvents', true
  ),
  true
),
updated_at = now()
WHERE module_code = 'orb_max_options'
  AND key = 'orb.strategy';

CREATE INDEX IF NOT EXISTS economic_events_impact_time_idx
  ON economic_events (upper(impact), event_time_utc)
  WHERE affected_currency IN ('USD', 'XAU', 'ALL');

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS shadow_observation_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS shadow_observation_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS shadow_observation_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS shadow_max_favorable_price NUMERIC(18,5),
  ADD COLUMN IF NOT EXISTS shadow_max_adverse_price NUMERIC(18,5),
  ADD COLUMN IF NOT EXISTS shadow_max_favorable_excursion_r NUMERIC(12,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shadow_max_adverse_before_tp1_r NUMERIC(12,6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shadow_tp1_hit_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS shadow_tp2_hit_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS shadow_tp3_hit_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS shadow_recovered_after_stop BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS trades_shadow_observation_active_idx
  ON trades (shadow_observation_until, shadow_observation_started_at)
  WHERE shadow_observation_started_at IS NOT NULL
    AND shadow_observation_completed_at IS NULL;

WITH stopped AS (
  SELECT
    t.id,
    t.actual_entry::numeric AS entry,
    COALESCE(t.initial_risk_distance, abs(t.actual_entry - t.actual_stop))::numeric AS risk,
    t.closed_at,
    ts.signal_window_end_at,
    sc.symbol,
    sc.direction
  FROM trades t
  JOIN trade_plans tp ON tp.id = t.trade_plan_id
  JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
  JOIN trading_sessions ts ON ts.id = sc.session_id
  WHERE sc.module_code = 'orb_max_options'
    AND t.outcome = 'LOSS'
    AND t.closed_at IS NOT NULL
    AND t.shadow_observation_started_at IS NULL
), shadow AS (
  SELECT
    stopped.*,
    CASE WHEN stopped.direction = 'SHORT' THEN min(c.low) ELSE max(c.high) END AS favorable_price,
    CASE WHEN stopped.direction = 'SHORT' THEN max(c.high) ELSE min(c.low) END AS adverse_price,
    min(c.timestamp_utc) FILTER (
      WHERE CASE WHEN stopped.direction = 'SHORT'
        THEN c.low <= stopped.entry - stopped.risk
        ELSE c.high >= stopped.entry + stopped.risk END
    ) AS tp1_at,
    min(c.timestamp_utc) FILTER (
      WHERE CASE WHEN stopped.direction = 'SHORT'
        THEN c.low <= stopped.entry - stopped.risk * 1.5
        ELSE c.high >= stopped.entry + stopped.risk * 1.5 END
    ) AS tp2_at,
    min(c.timestamp_utc) FILTER (
      WHERE CASE WHEN stopped.direction = 'SHORT'
        THEN c.low <= stopped.entry - stopped.risk * 2
        ELSE c.high >= stopped.entry + stopped.risk * 2 END
    ) AS tp3_at
  FROM stopped
  LEFT JOIN candles c
    ON c.symbol = stopped.symbol
   AND c.timeframe_minutes = 5
   AND c.timestamp_utc > stopped.closed_at
   AND c.timestamp_utc <= stopped.signal_window_end_at
  WHERE stopped.risk > 0
  GROUP BY stopped.id, stopped.entry, stopped.risk, stopped.closed_at,
           stopped.signal_window_end_at, stopped.symbol, stopped.direction
), calibrated AS (
  SELECT
    shadow.*,
    adverse_before_tp1.adverse_price AS adverse_before_tp1_price
  FROM shadow
  LEFT JOIN LATERAL (
    SELECT CASE WHEN shadow.direction = 'SHORT' THEN max(c.high) ELSE min(c.low) END AS adverse_price
    FROM candles c
    WHERE c.symbol = shadow.symbol
      AND c.timeframe_minutes = 5
      AND c.timestamp_utc > shadow.closed_at
      AND c.timestamp_utc <= COALESCE(shadow.tp1_at, shadow.signal_window_end_at)
  ) adverse_before_tp1 ON true
)
UPDATE trades t
SET shadow_observation_started_at = calibrated.closed_at,
    shadow_observation_until = calibrated.signal_window_end_at,
    shadow_observation_completed_at = calibrated.signal_window_end_at,
    shadow_max_favorable_price = calibrated.favorable_price,
    shadow_max_adverse_price = calibrated.adverse_price,
    shadow_max_favorable_excursion_r = round(greatest(0, CASE
      WHEN calibrated.direction = 'SHORT' THEN calibrated.entry - calibrated.favorable_price
      ELSE calibrated.favorable_price - calibrated.entry END) / calibrated.risk, 6),
    shadow_max_adverse_before_tp1_r = round(greatest(0, CASE
      WHEN calibrated.direction = 'SHORT' THEN calibrated.adverse_before_tp1_price - calibrated.entry
      ELSE calibrated.entry - calibrated.adverse_before_tp1_price END) / calibrated.risk, 6),
    shadow_tp1_hit_at = calibrated.tp1_at,
    shadow_tp2_hit_at = calibrated.tp2_at,
    shadow_tp3_hit_at = calibrated.tp3_at,
    shadow_recovered_after_stop = calibrated.tp1_at IS NOT NULL
FROM calibrated
WHERE t.id = calibrated.id
  AND calibrated.favorable_price IS NOT NULL;

CREATE OR REPLACE VIEW module1_stop_calibration AS
WITH independent_signals AS (
  SELECT DISTINCT ON (
    sc.scenario,
    sc.direction,
    t.opened_at,
    t.actual_entry,
    t.actual_stop
  )
    sc.scenario,
    sc.direction,
    t.opened_at,
    t.shadow_recovered_after_stop,
    t.shadow_max_adverse_before_tp1_r,
    COALESCE(
      NULLIF(sc.scenario_flags#>>'{tradePlan,stopDistanceAtr}', '')::numeric,
      NULLIF(sc.scenario_flags#>>'{horizontalRangeSignal,tradePlan,stopDistanceAtr}', '')::numeric
    ) AS original_stop_atr
  FROM trades t
  JOIN trade_plans tp ON tp.id = t.trade_plan_id
  JOIN setup_candidates sc ON sc.id = tp.setup_candidate_id
  WHERE sc.module_code = 'orb_max_options'
    AND t.shadow_observation_completed_at IS NOT NULL
  ORDER BY sc.scenario, sc.direction, t.opened_at, t.actual_entry, t.actual_stop, t.id
)
SELECT
  scenario,
  direction,
  count(*)::int AS observed_signals,
  count(*) FILTER (WHERE shadow_recovered_after_stop)::int AS recovered_after_stop,
  round(
    count(*) FILTER (WHERE shadow_recovered_after_stop)::numeric
      / NULLIF(count(*), 0),
    4
  ) AS recovery_rate,
  round(
    percentile_cont(0.80) WITHIN GROUP (
      ORDER BY shadow_max_adverse_before_tp1_r * original_stop_atr
    ) FILTER (
      WHERE shadow_recovered_after_stop
        AND original_stop_atr IS NOT NULL
        AND original_stop_atr > 0
    )::numeric,
    3
  ) AS recovered_trade_mae_p80_atr,
  count(*) >= 30 AS calibration_eligible
FROM independent_signals
GROUP BY scenario, direction;

COMMENT ON VIEW module1_stop_calibration IS
  'Deduplicated post-stop Module 1 observations. Calibration remains ineligible until 30 independent completed signals exist per scenario and direction.';
