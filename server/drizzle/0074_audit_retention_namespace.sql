-- Move the audit-retention window setting to the Remii namespace.
--
-- The sweep asks PostgreSQL how long the trail is kept by reading a transaction-local setting,
-- `remii.audit_retention_days`, which `audit-retention.ts` sets immediately before the DELETE. The
-- name is part of the contract between the two: the function below is the only reader, and it lives
-- in a function body rather than in application code, which is why this is a migration and not an
-- edit to a seed file.
--
-- WHY THE OLD NAME IS STILL READ. A deployment that upgrades the application before it upgrades the
-- database has a function still asking for `openbot.audit_retention_days` while the new code sets
-- `remii.audit_retention_days`. Reading only the new name there would not fail loudly — `current_setting`
-- with `true` returns NULL, the `IF retention_days IS NULL` branch fires, and every retention sweep is
-- refused as append-only. The trail would stop being trimmed and grow without bound, silently, for as
-- long as that version skew lasted. Reading the new name and falling back to the old one keeps the
-- window honoured across the upgrade instead of depending on the two happening in the right order.
--
-- The fallback is deliberately not the other way round. `remii` is the name the code sets from here, so
-- it wins when both are present; a deployment that has set the old name and not the new one is exactly
-- the one this migration has not yet reached.
CREATE OR REPLACE FUNCTION prevent_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  retention_days integer;
BEGIN
  -- Answered before anything else is read, so no setting and no missing OLD record can change it.
  IF TG_OP = 'TRUNCATE' OR TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Audit events are append-only';
  END IF;

  -- `true` on both so a session that never set either reads NULL instead of raising, which is the
  -- ordinary case and has to stay a plain refusal.
  BEGIN
    retention_days := nullif(
      coalesce(
        current_setting('remii.audit_retention_days', true),
        current_setting('openbot.audit_retention_days', true)
      ),
      ''
    )::integer;
  EXCEPTION WHEN others THEN
    retention_days := NULL;
  END;

  IF retention_days IS NULL OR retention_days < 1 THEN
    RAISE EXCEPTION 'Audit events are append-only';
  END IF;

  IF OLD.created_at >= now() - (retention_days || ' days')::interval THEN
    RAISE EXCEPTION 'Audit events are append-only within the retention window';
  END IF;

  RETURN OLD;
END;
$$;
