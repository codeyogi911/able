ALTER TABLE communication_conversations
ADD COLUMN final_disposition TEXT CHECK (final_disposition IN ('no_action', 'spam', 'duplicate'));

ALTER TABLE communication_conversations
ADD COLUMN final_disposition_reason TEXT;

ALTER TABLE communication_conversations
ADD COLUMN final_disposition_at TEXT;

CREATE TRIGGER communication_conversations_final_disposition_consistent_insert
BEFORE INSERT ON communication_conversations
WHEN (NEW.final_disposition IS NULL AND (NEW.final_disposition_reason IS NOT NULL OR NEW.final_disposition_at IS NOT NULL))
  OR (NEW.final_disposition IS NOT NULL AND (NEW.final_disposition_reason IS NULL OR NEW.final_disposition_at IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'conversation final disposition fields must be set together');
END;

CREATE TRIGGER communication_conversations_final_disposition_consistent_update
BEFORE UPDATE OF final_disposition, final_disposition_reason, final_disposition_at ON communication_conversations
WHEN (NEW.final_disposition IS NULL AND (NEW.final_disposition_reason IS NOT NULL OR NEW.final_disposition_at IS NOT NULL))
  OR (NEW.final_disposition IS NOT NULL AND (NEW.final_disposition_reason IS NULL OR NEW.final_disposition_at IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'conversation final disposition fields must be set together');
END;
