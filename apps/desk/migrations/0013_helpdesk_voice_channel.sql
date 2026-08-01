PRAGMA defer_foreign_keys = ON;

CREATE TABLE cases_voice_upgrade (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  ref TEXT UNIQUE,
  subject TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_on_customer', 'on_hold', 'resolved', 'closed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  channel TEXT NOT NULL CHECK (channel IN ('portal', 'email', 'manual', 'whatsapp', 'voice')),
  category_id TEXT REFERENCES categories(id),
  assignee_id TEXT REFERENCES operators(id),
  revision TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  customer_capability_nonce TEXT NOT NULL,
  customer_capability_hash TEXT NOT NULL,
  customer_capability_expires_at TEXT,
  opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  closed_at TEXT
);

CREATE TABLE messages_voice_upgrade (
  id TEXT PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'internal')),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'note', 'system')),
  channel TEXT NOT NULL CHECK (channel IN ('portal', 'email', 'manual', 'whatsapp', 'voice')),
  author_type TEXT NOT NULL CHECK (author_type IN ('customer', 'operator', 'system', 'import')),
  operator_id TEXT REFERENCES operators(id),
  customer_id TEXT REFERENCES customers(id),
  author_name TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_html TEXT,
  delivery_state TEXT CHECK (delivery_state IN ('queued', 'accepted', 'blocked', 'failed', 'indeterminate')),
  provider_message_id TEXT,
  source_created_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO cases_voice_upgrade SELECT * FROM cases;
INSERT INTO messages_voice_upgrade SELECT * FROM messages;

DROP TABLE messages;
DROP TABLE cases;

ALTER TABLE cases_voice_upgrade RENAME TO cases;
ALTER TABLE messages_voice_upgrade RENAME TO messages;

CREATE INDEX cases_queue_idx ON cases(status, priority, updated_at, id);
CREATE INDEX cases_assignee_idx ON cases(assignee_id, status, updated_at);
CREATE INDEX cases_customer_idx ON cases(customer_id, updated_at);
CREATE INDEX messages_case_idx ON messages(case_id, created_at, id);
CREATE INDEX messages_provider_message_id_idx
ON messages(provider_message_id)
WHERE provider_message_id IS NOT NULL;

-- A reconnect must not reset the public voice-ticket creation ceiling. The
-- table stores only domain-separated hashes, never the customer's email.
CREATE TABLE voice_ticket_events (
  id TEXT PRIMARY KEY,
  subject_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
);

CREATE INDEX voice_ticket_events_subject_created_idx
ON voice_ticket_events(subject_hash, created_at_ms);

CREATE TRIGGER cases_set_ref_after_insert
AFTER INSERT ON cases
WHEN NEW.ref IS NULL
BEGIN
  UPDATE cases
  SET ref = (SELECT case_prefix FROM workspace_settings WHERE id = 1) || '-' || NEW.id
  WHERE id = NEW.id;
END;

PRAGMA defer_foreign_keys = OFF;
