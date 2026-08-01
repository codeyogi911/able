PRAGMA foreign_keys = ON;

CREATE TABLE workspace_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  display_name TEXT NOT NULL DEFAULT 'Morrow Desk',
  portal_title TEXT NOT NULL DEFAULT 'How can we help?',
  logo_url TEXT,
  home_url TEXT,
  support_email TEXT,
  outbound_sender TEXT,
  case_prefix TEXT NOT NULL DEFAULT 'MD' CHECK (length(case_prefix) BETWEEN 2 AND 8),
  locale TEXT NOT NULL DEFAULT 'en',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  support_hours_json TEXT NOT NULL DEFAULT '{}',
  accent_color TEXT NOT NULL DEFAULT '#b54a28',
  canvas_color TEXT NOT NULL DEFAULT '#f5f2ec',
  ink_color TEXT NOT NULL DEFAULT '#191918',
  font_family TEXT NOT NULL DEFAULT 'system',
  portal_base_url TEXT,
  public_intake_enabled INTEGER NOT NULL DEFAULT 0 CHECK (public_intake_enabled IN (0, 1)),
  email_tested_at TEXT,
  setup_completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO workspace_settings (id) VALUES (1);

CREATE TABLE operators (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'agent')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO categories (id, slug, name, description, sort_order) VALUES
  ('general', 'general', 'General', 'Questions that do not fit another category.', 100);

CREATE TABLE cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  ref TEXT UNIQUE,
  subject TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_on_customer', 'on_hold', 'resolved', 'closed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  channel TEXT NOT NULL CHECK (channel IN ('portal', 'email', 'manual')),
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

CREATE INDEX cases_queue_idx ON cases(status, priority, updated_at, id);
CREATE INDEX cases_assignee_idx ON cases(assignee_id, status, updated_at);
CREATE INDEX cases_customer_idx ON cases(customer_id, updated_at);

CREATE TRIGGER cases_set_ref_after_insert
AFTER INSERT ON cases
WHEN NEW.ref IS NULL
BEGIN
  UPDATE cases
  SET ref = (SELECT case_prefix FROM workspace_settings WHERE id = 1) || '-' || NEW.id
  WHERE id = NEW.id;
END;

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'internal')),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'note', 'system')),
  channel TEXT NOT NULL CHECK (channel IN ('portal', 'email', 'manual')),
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

CREATE INDEX messages_case_idx ON messages(case_id, created_at, id);

-- Immutable object metadata is shared substrate. Business modules own their
-- link tables and never need to reach into another module's records.
CREATE TABLE stored_files (
  id TEXT PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL,
  source_created_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE case_attachments (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES stored_files(id) ON DELETE RESTRICT,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  subject_type TEXT NOT NULL DEFAULT 'case',
  subject_id TEXT,
  message_id TEXT REFERENCES messages(id) ON DELETE RESTRICT,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'internal')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX case_attachments_case_idx ON case_attachments(case_id, created_at);

-- Helpdesk reads retain one convenient relation while writes remain explicit:
-- platform metadata first, then the module-owned case link in the same batch.
CREATE VIEW attachments AS
SELECT link.id, link.case_id, link.subject_type, link.subject_id, link.message_id,
       file.storage_key, file.filename, file.content_type, file.size, file.sha256,
       link.visibility, file.source_created_at, link.created_at
FROM case_attachments link
JOIN stored_files file ON file.id = link.file_id;

CREATE TABLE kb_sections (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE kb_articles (
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES kb_sections(id),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  revision TEXT NOT NULL,
  source_created_at TEXT,
  source_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX kb_articles_public_idx ON kb_articles(published, section_id, updated_at);

CREATE TABLE kb_article_attachments (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES stored_files(id) ON DELETE RESTRICT,
  article_id TEXT NOT NULL REFERENCES kb_articles(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX kb_article_attachments_article_idx ON kb_article_attachments(article_id, created_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  case_id INTEGER REFERENCES cases(id),
  subject_type TEXT NOT NULL DEFAULT 'case',
  subject_id TEXT,
  actor_id TEXT REFERENCES operators(id),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('operator', 'customer', 'system', 'import')),
  event_type TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  source_created_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX audit_case_idx ON audit_events(case_id, created_at, id);
CREATE INDEX audit_subject_idx ON audit_events(subject_type, subject_id, created_at, id);

CREATE TRIGGER audit_events_immutable_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END;

CREATE TRIGGER audit_events_immutable_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END;

CREATE TABLE operation_receipts (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 80),
  actor_id TEXT REFERENCES operators(id),
  case_id INTEGER REFERENCES cases(id),
  subject_type TEXT NOT NULL DEFAULT 'case',
  subject_id TEXT,
  command_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX operation_case_idx ON operation_receipts(case_id, created_at);
CREATE INDEX operation_subject_idx ON operation_receipts(subject_type, subject_id, created_at);

CREATE TRIGGER operation_receipts_immutable_update
BEFORE UPDATE ON operation_receipts
BEGIN
  SELECT RAISE(ABORT, 'operation receipts are immutable');
END;

CREATE TRIGGER operation_receipts_immutable_delete
BEFORE DELETE ON operation_receipts
BEGIN
  SELECT RAISE(ABORT, 'operation receipts are immutable');
END;

CREATE TABLE outbox_rows (
  id TEXT PRIMARY KEY,
  case_id INTEGER REFERENCES cases(id),
  subject_type TEXT NOT NULL DEFAULT 'case',
  subject_id TEXT,
  message_id TEXT REFERENCES messages(id),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 120),
  recipient TEXT NOT NULL,
  sender TEXT,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_html TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'sending', 'accepted', 'blocked', 'failed', 'indeterminate')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  provider_message_id TEXT,
  last_error TEXT,
  lease_id TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX outbox_retry_idx ON outbox_rows(state, next_attempt_at, created_at);
CREATE INDEX outbox_subject_idx ON outbox_rows(subject_type, subject_id, created_at);

CREATE TABLE external_provenance (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  local_entity_type TEXT NOT NULL,
  local_entity_id TEXT NOT NULL,
  lookup_alias TEXT,
  source_url TEXT,
  source_created_at TEXT,
  source_updated_at TEXT,
  raw_sha256 TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, entity_type, source_id)
);

CREATE INDEX provenance_alias_idx ON external_provenance(lookup_alias);
CREATE INDEX provenance_local_idx ON external_provenance(local_entity_type, local_entity_id);
