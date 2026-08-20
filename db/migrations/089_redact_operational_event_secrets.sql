UPDATE operational_events
SET message = regexp_replace(
      regexp_replace(message, '(postgresql?|redis)://[^[:space:]"'']+', '[REDACTED_URL]', 'gi'),
      '--database-url([=[:space:]]+)[^[:space:]"'']+', '--database-url [REDACTED]', 'gi'
    ),
    metadata = regexp_replace(
      regexp_replace(metadata::text, '(postgresql?|redis)://[^[:space:]"'']+', '[REDACTED_URL]', 'gi'),
      '--database-url([=[:space:]]+)[^[:space:]"'']+', '--database-url [REDACTED]', 'gi'
    )::jsonb
WHERE message ~* '(postgresql?|redis)://|--database-url'
   OR metadata::text ~* '(postgresql?|redis)://|--database-url';

COMMENT ON TABLE operational_events IS
  'Operational audit events. Secret-bearing URLs and command arguments must be redacted before persistence.';
