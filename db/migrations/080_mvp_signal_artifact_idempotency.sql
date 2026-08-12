CREATE TEMP TABLE duplicate_trade_map ON COMMIT DROP AS
WITH ranked AS (
  SELECT id, trade_plan_id,
         first_value(id) OVER (
           PARTITION BY trade_plan_id
           ORDER BY CASE WHEN outcome = 'ACTIVE' THEN 0 ELSE 1 END,
                    COALESCE(opened_at, closed_at) DESC NULLS LAST,
                    id
         ) AS keep_id,
         row_number() OVER (
           PARTITION BY trade_plan_id
           ORDER BY CASE WHEN outcome = 'ACTIVE' THEN 0 ELSE 1 END,
                    COALESCE(opened_at, closed_at) DESC NULLS LAST,
                    id
         ) AS rank
  FROM trades
)
SELECT id AS duplicate_id, keep_id
FROM ranked
WHERE rank > 1;

-- Keep historical evidence attached to the canonical trade before removing
-- duplicate rows created by older concurrent paper-entry attempts.
UPDATE trade_events event
SET trade_id = duplicate.keep_id
FROM duplicate_trade_map duplicate
WHERE event.trade_id = duplicate.duplicate_id;

UPDATE journal_entries journal
SET trade_id = duplicate.keep_id
FROM duplicate_trade_map duplicate
WHERE journal.trade_id = duplicate.duplicate_id;

UPDATE positions position
SET trade_id = duplicate.keep_id
FROM duplicate_trade_map duplicate
WHERE position.trade_id = duplicate.duplicate_id;

UPDATE manual_execution_reconciliations reconciliation
SET trade_id = duplicate.keep_id
FROM duplicate_trade_map duplicate
WHERE reconciliation.trade_id = duplicate.duplicate_id;

UPDATE tenant_automation_states automation
SET latest_trade_id = duplicate.keep_id
FROM duplicate_trade_map duplicate
WHERE automation.latest_trade_id = duplicate.duplicate_id;

DELETE FROM trades trade
USING duplicate_trade_map duplicate
WHERE trade.id = duplicate.duplicate_id;

CREATE UNIQUE INDEX IF NOT EXISTS trades_trade_plan_unique_idx
  ON trades (trade_plan_id);

CREATE TEMP TABLE duplicate_paper_journal_map ON COMMIT DROP AS
WITH ranked AS (
  SELECT id, setup_candidate_id,
         first_value(id) OVER (
           PARTITION BY setup_candidate_id
           ORDER BY created_at, id
         ) AS keep_id,
         row_number() OVER (
           PARTITION BY setup_candidate_id
           ORDER BY created_at, id
         ) AS rank
  FROM journal_entries
  WHERE decision = 'PAPER_TRADE_OPENED'
    AND setup_candidate_id IS NOT NULL
)
SELECT id AS duplicate_id, keep_id
FROM ranked
WHERE rank > 1;

UPDATE attachments attachment
SET journal_entry_id = duplicate.keep_id
FROM duplicate_paper_journal_map duplicate
WHERE attachment.journal_entry_id = duplicate.duplicate_id;

DELETE FROM journal_entries journal
USING duplicate_paper_journal_map duplicate
WHERE journal.id = duplicate.duplicate_id;

CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_paper_open_unique_idx
  ON journal_entries (setup_candidate_id)
  WHERE decision = 'PAPER_TRADE_OPENED';

WITH ranked AS (
  SELECT id, trade_id, event_type,
         row_number() OVER (PARTITION BY trade_id, event_type ORDER BY created_at, id) AS rank
  FROM trade_events
  WHERE event_type = 'PAPER_ENTRY'
)
DELETE FROM trade_events
WHERE id IN (SELECT id FROM ranked WHERE rank > 1);

CREATE UNIQUE INDEX IF NOT EXISTS trade_events_paper_entry_unique_idx
  ON trade_events (trade_id, event_type)
  WHERE event_type = 'PAPER_ENTRY';
