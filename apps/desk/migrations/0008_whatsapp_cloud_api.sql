PRAGMA defer_foreign_keys = ON;

CREATE TABLE customers_whatsapp_upgrade (
  id TEXT PRIMARY KEY,
  email TEXT COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE cases_whatsapp_upgrade (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  ref TEXT UNIQUE,
  subject TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_on_customer', 'on_hold', 'resolved', 'closed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  channel TEXT NOT NULL CHECK (channel IN ('portal', 'email', 'manual', 'whatsapp')),
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

CREATE TABLE messages_whatsapp_upgrade (
  id TEXT PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'internal')),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'note', 'system')),
  channel TEXT NOT NULL CHECK (channel IN ('portal', 'email', 'manual', 'whatsapp')),
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

INSERT INTO customers_whatsapp_upgrade SELECT * FROM customers;
INSERT INTO cases_whatsapp_upgrade SELECT * FROM cases;
INSERT INTO messages_whatsapp_upgrade SELECT * FROM messages;

DROP TABLE messages;
DROP TABLE cases;
DROP TABLE customers;

ALTER TABLE customers_whatsapp_upgrade RENAME TO customers;
ALTER TABLE cases_whatsapp_upgrade RENAME TO cases;
ALTER TABLE messages_whatsapp_upgrade RENAME TO messages;

CREATE INDEX cases_queue_idx ON cases(status, priority, updated_at, id);
CREATE INDEX cases_assignee_idx ON cases(assignee_id, status, updated_at);
CREATE INDEX cases_customer_idx ON cases(customer_id, updated_at);
CREATE INDEX messages_case_idx ON messages(case_id, created_at, id);

CREATE TRIGGER cases_set_ref_after_insert
AFTER INSERT ON cases
WHEN NEW.ref IS NULL
BEGIN
  UPDATE cases
  SET ref = (SELECT case_prefix FROM workspace_settings WHERE id = 1) || '-' || NEW.id
  WHERE id = NEW.id;
END;

CREATE TABLE communication_conversations (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel = 'whatsapp'),
  account_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  external_thread_id TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  attention_state TEXT NOT NULL DEFAULT 'needs_attention' CHECK (attention_state IN ('needs_attention', 'handled', 'delivery_problem')),
  revision TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  last_inbound_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX communication_conversations_attention_idx
ON communication_conversations(attention_state, last_inbound_at, id);

CREATE UNIQUE INDEX communication_conversations_active_sender_idx
ON communication_conversations(channel, account_id, endpoint_id, external_thread_id)
WHERE attention_state = 'needs_attention';

CREATE TABLE communication_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES communication_conversations(id) ON DELETE RESTRICT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  author_type TEXT NOT NULL CHECK (author_type IN ('contact', 'operator', 'system')),
  operator_id TEXT REFERENCES operators(id),
  author_name TEXT NOT NULL,
  body_text TEXT NOT NULL,
  delivery_state TEXT CHECK (delivery_state IN ('queued', 'accepted', 'blocked', 'failed', 'indeterminate')),
  provider_message_id TEXT UNIQUE,
  provider_payload_hash TEXT,
  source_created_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX communication_messages_conversation_idx
ON communication_messages(conversation_id, source_created_at, created_at, id);

CREATE TRIGGER communication_message_delivery_needs_attention
AFTER UPDATE OF delivery_state ON communication_messages
WHEN NEW.delivery_state IN ('blocked', 'indeterminate')
BEGIN
  UPDATE communication_conversations
  SET attention_state = 'delivery_problem',
      revision = 'rev_' || lower(hex(randomblob(16))),
      version = version + 1,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = NEW.conversation_id;
END;

ALTER TABLE outbox_rows
ADD COLUMN communication_message_id TEXT REFERENCES communication_messages(id) ON DELETE RESTRICT;

CREATE TABLE communication_routes (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES communication_conversations(id) ON DELETE RESTRICT,
  target TEXT NOT NULL CHECK (target IN ('support', 'sales')),
  target_module TEXT NOT NULL CHECK (target_module IN ('helpdesk', 'crm')),
  target_entity_type TEXT NOT NULL CHECK (target_entity_type IN ('case', 'sales_lead')),
  target_entity_id TEXT NOT NULL,
  routing_intent_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES operators(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(conversation_id, target)
);

CREATE INDEX communication_routes_target_idx
ON communication_routes(target_module, target_entity_type, target_entity_id);

CREATE TABLE helpdesk_case_sources (
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  source_module TEXT NOT NULL,
  source_entity_type TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(source_module, source_entity_type, source_entity_id),
  UNIQUE(case_id, source_module, source_entity_type)
);

CREATE TABLE crm_sales_leads (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL REFERENCES directory_parties(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'qualifying', 'qualified', 'disqualified', 'converted')),
  owner_id TEXT REFERENCES operators(id),
  source_module TEXT NOT NULL,
  source_entity_type TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_module, source_entity_type, source_entity_id)
);

CREATE INDEX crm_sales_leads_party_idx
ON crm_sales_leads(party_id, status, updated_at, id);

PRAGMA defer_foreign_keys = OFF;
