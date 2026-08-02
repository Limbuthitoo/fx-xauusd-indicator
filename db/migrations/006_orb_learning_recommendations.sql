CREATE TABLE IF NOT EXISTS orb_learning_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  sample_size INTEGER NOT NULL DEFAULT 0,
  summary JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS orb_learning_recommendations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  learning_run_id UUID NOT NULL REFERENCES orb_learning_runs(id) ON DELETE CASCADE,
  recommendation_type TEXT NOT NULL,
  scenario TEXT,
  direction TEXT,
  confidence TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}',
  suggested_action JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orb_learning_recommendations_status_idx
ON orb_learning_recommendations(status, created_at DESC);

CREATE INDEX IF NOT EXISTS orb_learning_recommendations_scenario_idx
ON orb_learning_recommendations(scenario, direction);
