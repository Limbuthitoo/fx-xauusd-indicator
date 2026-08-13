CREATE INDEX IF NOT EXISTS setup_candidates_observer_scan_idx
  ON setup_candidates (module_code, detected_at DESC)
  WHERE direction IN ('LONG', 'SHORT')
     OR status IN ('LONG SETUP READY', 'SHORT SETUP READY', 'TRADE_PLANNED', 'PAPER_TRADE_OPENED');

CREATE INDEX IF NOT EXISTS notifications_setup_signal_idx
  ON notifications (tenant_id, ((data->>'setupCandidateId')), event_type, created_at DESC)
  WHERE event_type IN ('SETUP_READY', 'MODULE2_SETUP_READY');

CREATE INDEX IF NOT EXISTS operational_events_brain_setup_idx
  ON operational_events (tenant_id, ((metadata->>'setupId')), created_at DESC)
  WHERE event_type = 'MAIN_BRAIN_DECISION';

CREATE INDEX IF NOT EXISTS journal_entries_setup_tenant_idx
  ON journal_entries (setup_candidate_id, tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS trade_events_terminal_lookup_idx
  ON trade_events (trade_id, created_at DESC)
  WHERE event_type IN ('PAPER_TP3_HIT', 'PAPER_SL_HIT', 'PAPER_EXIT');
