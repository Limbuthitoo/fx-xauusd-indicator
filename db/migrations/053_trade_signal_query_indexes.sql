CREATE INDEX IF NOT EXISTS setup_rule_evaluations_candidate_idx
  ON setup_rule_evaluations(setup_candidate_id, evaluated_at);

CREATE INDEX IF NOT EXISTS setup_candidates_tenant_signal_idx
  ON setup_candidates(tenant_id, detected_at DESC)
  WHERE direction IN ('LONG', 'SHORT')
    AND entry_price IS NOT NULL
    AND stop_price IS NOT NULL
    AND target_price IS NOT NULL;
