-- Adds protocol selector to ssh_credentials so the same vault row can describe
-- either an SSH or a Telnet target. Default 'ssh' keeps existing rows valid.
-- Telnet credentials always use auth_type='password' (private keys are not a
-- thing on telnet); we enforce that in the API layer, not here, so a future
-- protocol can extend the matrix without another migration.

ALTER TABLE ssh_credentials
  ADD COLUMN IF NOT EXISTS protocol TEXT NOT NULL DEFAULT 'ssh';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ssh_credentials_protocol_check'
  ) THEN
    ALTER TABLE ssh_credentials
      ADD CONSTRAINT ssh_credentials_protocol_check
      CHECK (protocol IN ('ssh','telnet'));
  END IF;
END$$;
