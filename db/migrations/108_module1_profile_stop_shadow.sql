CREATE TABLE IF NOT EXISTS module1_stop_shadow_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES platform_tenants(id) ON DELETE CASCADE,
  setup_candidate_id uuid NOT NULL REFERENCES setup_candidates(id) ON DELETE CASCADE,
  strategy_profile text NOT NULL,
  direction text NOT NULL,
  candidate_code text NOT NULL,
  candidate_label text NOT NULL,
  entry_price numeric(14,5) NOT NULL,
  stop_price numeric(14,5) NOT NULL,
  target_price numeric(14,5) NOT NULL,
  risk_distance numeric(14,5) NOT NULL,
  atr numeric(14,5),
  stop_distance_atr numeric(10,4),
  minimum_stop_atr numeric(10,4) NOT NULL,
  liquidity_buffer_atr numeric(10,4) NOT NULL,
  trade_accepted boolean NOT NULL DEFAULT true,
  rejection_reason text,
  started_at timestamptz NOT NULL,
  observation_until timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  outcome text,
  close_reason text,
  exit_price numeric(14,5),
  result_r numeric(12,4),
  target_hit_index integer NOT NULL DEFAULT 0,
  tp1_hit_at timestamptz,
  tp2_hit_at timestamptz,
  tp3_hit_at timestamptz,
  realized_r numeric(12,4) NOT NULL DEFAULT 0,
  remaining_fraction numeric(8,6) NOT NULL DEFAULT 1,
  maximum_favorable_excursion_r numeric(12,4) NOT NULL DEFAULT 0,
  maximum_adverse_excursion_r numeric(12,4) NOT NULL DEFAULT 0,
  ambiguous_exit boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (setup_candidate_id, candidate_code),
  CHECK (strategy_profile IN ('ORB_BREAKOUT', 'HORIZONTAL_RANGE_BREAKOUT')),
  CHECK (direction IN ('LONG', 'SHORT')),
  CHECK (status IN ('ACTIVE', 'COMPLETED', 'SKIPPED')),
  CHECK (outcome IS NULL OR outcome IN ('ACTIVE', 'WIN', 'LOSS', 'BREAKEVEN', 'SKIPPED')),
  CHECK (risk_distance > 0),
  CHECK (target_hit_index BETWEEN 0 AND 3),
  CHECK (remaining_fraction BETWEEN 0 AND 1)
);

CREATE INDEX IF NOT EXISTS module1_stop_shadow_active_idx
  ON module1_stop_shadow_observations (tenant_id, observation_until, started_at)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS module1_stop_shadow_calibration_idx
  ON module1_stop_shadow_observations (strategy_profile, direction, candidate_code, completed_at DESC)
  WHERE status IN ('COMPLETED', 'SKIPPED');

CREATE OR REPLACE VIEW module1_profile_stop_shadow_calibration AS
WITH completed AS (
  SELECT
    observation.*,
    COALESCE(observation.result_r, 0)::numeric AS scored_r
  FROM module1_stop_shadow_observations observation
  WHERE observation.status IN ('COMPLETED', 'SKIPPED')
), equity AS (
  SELECT
    completed.*,
    sum(scored_r) OVER (
      PARTITION BY tenant_id, strategy_profile, direction, candidate_code
      ORDER BY completed_at, id
    ) AS cumulative_r
  FROM completed
), drawdown AS (
  SELECT
    equity.*,
    greatest(0, max(cumulative_r) OVER (
      PARTITION BY tenant_id, strategy_profile, direction, candidate_code
      ORDER BY completed_at, id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )) - cumulative_r AS drawdown_r
  FROM equity
), aggregated AS (
  SELECT
    tenant_id,
    strategy_profile,
    direction,
    candidate_code,
    max(candidate_label) AS candidate_label,
    count(*)::int AS observed_signals,
    count(*) FILTER (WHERE trade_accepted)::int AS traded_signals,
    count(*) FILTER (WHERE NOT trade_accepted)::int AS skipped_signals,
    count(*) FILTER (WHERE outcome = 'WIN')::int AS wins,
    count(*) FILTER (WHERE outcome = 'LOSS')::int AS losses,
    count(*) FILTER (WHERE outcome = 'BREAKEVEN')::int AS breakeven,
    round(sum(scored_r), 4) AS total_r,
    round(avg(scored_r), 4) AS average_r,
    round(COALESCE(max(drawdown_r), 0), 4) AS maximum_drawdown_r,
    round(avg(stop_distance_atr) FILTER (WHERE trade_accepted), 4) AS average_stop_atr,
    round(count(*) FILTER (WHERE target_hit_index >= 1)::numeric / NULLIF(count(*) FILTER (WHERE trade_accepted), 0), 4) AS tp1_rate,
    round(count(*) FILTER (WHERE target_hit_index >= 2)::numeric / NULLIF(count(*) FILTER (WHERE trade_accepted), 0), 4) AS tp2_rate,
    round(count(*) FILTER (WHERE target_hit_index >= 3)::numeric / NULLIF(count(*) FILTER (WHERE trade_accepted), 0), 4) AS tp3_rate,
    round(avg(maximum_favorable_excursion_r) FILTER (WHERE trade_accepted), 4) AS average_mfe_r,
    round(avg(maximum_adverse_excursion_r) FILTER (WHERE trade_accepted), 4) AS average_mae_r,
    count(*) >= 30 AS calibration_eligible,
    max(completed_at) AS latest_observation_at
  FROM drawdown
  GROUP BY tenant_id, strategy_profile, direction, candidate_code
), compared AS (
  SELECT
    candidate.*,
    baseline.average_r AS baseline_average_r,
    baseline.maximum_drawdown_r AS baseline_maximum_drawdown_r,
    round(candidate.average_r - baseline.average_r, 4) AS expectancy_improvement_r
  FROM aggregated candidate
  LEFT JOIN aggregated baseline
    ON baseline.tenant_id = candidate.tenant_id
   AND baseline.strategy_profile = candidate.strategy_profile
   AND baseline.direction = candidate.direction
   AND baseline.candidate_code = 'BASELINE_CURRENT'
)
SELECT
  compared.*,
  candidate_code <> 'BASELINE_CURRENT'
    AND calibration_eligible
    AND baseline_average_r IS NOT NULL
    AND expectancy_improvement_r >= 0.10
    AND maximum_drawdown_r <= baseline_maximum_drawdown_r
    AS promotion_ready
FROM compared;

COMMENT ON TABLE module1_stop_shadow_observations IS
  'Observe-only Module 1 stop candidates. Rows never modify production setup, signal, notification, or paper-trade contracts.';

COMMENT ON VIEW module1_profile_stop_shadow_calibration IS
  'Profile-specific stop comparison. A challenger needs 30 observations, at least +0.10R expectancy improvement, and no worse maximum drawdown before it can be marked promotion-ready.';
