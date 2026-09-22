-- Prepared migration. No historical position is inferred from timestamps or IDs.
-- Apply before deploying the Poster handler that writes these columns.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['testnet', 'mainnet', 'dev', 'public'] LOOP
    IF to_regclass(format('%I.ds_records', s)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.ds_records ADD COLUMN IF NOT EXISTS transaction_index INTEGER', s);
      EXECUTE format('ALTER TABLE %I.ds_records ADD COLUMN IF NOT EXISTS log_index INTEGER', s);
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ds_records_event_order_check' AND conrelid = to_regclass(format('%I.ds_records', s))) THEN
        EXECUTE format('ALTER TABLE %I.ds_records ADD CONSTRAINT ds_records_event_order_check CHECK ((transaction_index IS NULL AND log_index IS NULL) OR (transaction_index IS NOT NULL AND log_index IS NOT NULL AND transaction_index >= 0 AND log_index >= 0)) NOT VALID', s);
      END IF;
    END IF;
  END LOOP;
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;
