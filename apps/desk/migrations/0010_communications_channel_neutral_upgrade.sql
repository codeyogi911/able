-- 0008 shipped the WhatsApp-only schema. Keep this forward-only so existing
-- D1 databases receive the same channel-neutral Communications model as new
-- installations. The table rebuild also rewires its only child tables.
PRAGMA defer_foreign_keys = ON;

DROP TRIGGER communication_message_delivery_needs_attention;

ALTER TABLE communication_conversations RENAME TO communication_conversations_legacy;
ALTER TABLE communication_messages RENAME TO communication_messages_legacy;
ALTER TABLE communication_routes RENAME TO communication_routes_legacy;
ALTER TABLE outbox_rows RENAME TO outbox_rows_legacy;

CREATE TABLE communication_conversations (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'email', 'portal', 'web_chat', 'voice', 'instagram', 'facebook_messenger')),
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  external_thread_id TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_address_kind TEXT NOT NULL CHECK (contact_address_kind IN ('email', 'phone', 'opaque')),
  contact_address TEXT NOT NULL,
  contact_email TEXT,
  contact_phone TEXT,
  attention_state TEXT NOT NULL DEFAULT 'needs_attention' CHECK (attention_state IN ('needs_attention', 'handled', 'delivery_problem')),
  revision TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  last_inbound_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO communication_conversations
  (id, channel, provider, account_id, endpoint_id, external_thread_id, contact_name,
   contact_address_kind, contact_address, contact_email, contact_phone,
   attention_state, revision, version, last_inbound_at, created_at, updated_at)
SELECT id, channel, 'meta_whatsapp', account_id, endpoint_id, external_thread_id, contact_name,
       'phone', contact_phone, NULL, contact_phone,
       attention_state, revision, version, last_inbound_at, created_at, updated_at
FROM communication_conversations_legacy;

CREATE TABLE communication_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES communication_conversations(id) ON DELETE RESTRICT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  author_type TEXT NOT NULL CHECK (author_type IN ('contact', 'operator', 'system')),
  operator_id TEXT REFERENCES operators(id),
  author_name TEXT NOT NULL,
  body_text TEXT NOT NULL,
  delivery_state TEXT CHECK (delivery_state IN ('queued', 'accepted', 'blocked', 'failed', 'indeterminate')),
  provider TEXT,
  provider_account_id TEXT,
  provider_message_id TEXT,
  provider_payload_hash TEXT,
  source_created_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO communication_messages
  (id, conversation_id, direction, author_type, operator_id, author_name, body_text, delivery_state,
   provider, provider_account_id, provider_message_id, provider_payload_hash, source_created_at, created_at)
SELECT m.id, m.conversation_id, m.direction, m.author_type, m.operator_id, m.author_name, m.body_text, m.delivery_state,
       CASE WHEN m.provider_message_id IS NULL THEN NULL ELSE 'meta_whatsapp' END,
       CASE WHEN m.provider_message_id IS NULL THEN NULL ELSE c.account_id END,
       m.provider_message_id, m.provider_payload_hash, m.source_created_at, m.created_at
FROM communication_messages_legacy m
JOIN communication_conversations_legacy c ON c.id = m.conversation_id;

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

INSERT INTO communication_routes
  (id, conversation_id, target, target_module, target_entity_type, target_entity_id, routing_intent_id, actor_id, created_at)
SELECT id, conversation_id, target, target_module, target_entity_type, target_entity_id, routing_intent_id, actor_id, created_at
FROM communication_routes_legacy;

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
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  communication_message_id TEXT REFERENCES communication_messages(id) ON DELETE RESTRICT
);

INSERT INTO outbox_rows
  (id, case_id, subject_type, subject_id, message_id, kind, recipient, sender, subject, body_text, body_html,
   state, attempt_count, next_attempt_at, provider_message_id, last_error, lease_id, lease_expires_at,
   created_at, updated_at, communication_message_id)
SELECT id, case_id, subject_type, subject_id, message_id, kind, recipient, sender, subject, body_text, body_html,
       state, attempt_count, next_attempt_at, provider_message_id, last_error, lease_id, lease_expires_at,
       created_at, updated_at, communication_message_id
FROM outbox_rows_legacy;

DROP TABLE communication_routes_legacy;
DROP TABLE outbox_rows_legacy;
DROP TABLE communication_messages_legacy;
DROP TABLE communication_conversations_legacy;

CREATE INDEX communication_conversations_attention_idx
ON communication_conversations(attention_state, last_inbound_at, id);

CREATE UNIQUE INDEX communication_conversations_active_sender_idx
ON communication_conversations(channel, provider, account_id, endpoint_id, external_thread_id)
WHERE attention_state = 'needs_attention';

CREATE INDEX communication_messages_conversation_idx
ON communication_messages(conversation_id, source_created_at, created_at, id);

CREATE UNIQUE INDEX communication_messages_provider_message_idx
ON communication_messages(provider, provider_account_id, provider_message_id)
WHERE provider IS NOT NULL AND provider_account_id IS NOT NULL AND provider_message_id IS NOT NULL;

CREATE INDEX communication_routes_target_idx
ON communication_routes(target_module, target_entity_type, target_entity_id);

CREATE INDEX outbox_retry_idx ON outbox_rows(state, next_attempt_at, created_at);
CREATE INDEX outbox_subject_idx ON outbox_rows(subject_type, subject_id, created_at);

CREATE TABLE communication_provider_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'email', 'portal', 'web_chat', 'voice', 'instagram', 'facebook_messenger')),
  account_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES communication_conversations(id) ON DELETE RESTRICT,
  message_id TEXT NOT NULL REFERENCES communication_messages(id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL REFERENCES operation_receipts(id) ON DELETE RESTRICT,
  UNIQUE(provider, account_id, provider_event_id)
);

CREATE INDEX communication_provider_events_conversation_idx
ON communication_provider_events(conversation_id, occurred_at, id);

CREATE TABLE communication_provider_delivery_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  payload_hash TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  conversation_id TEXT REFERENCES communication_conversations(id) ON DELETE RESTRICT,
  communication_message_id TEXT REFERENCES communication_messages(id) ON DELETE RESTRICT,
  UNIQUE(provider, provider_account_id, provider_message_id, status, occurred_at)
);

CREATE INDEX communication_provider_delivery_events_message_idx
ON communication_provider_delivery_events(communication_message_id, occurred_at, id);

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

PRAGMA defer_foreign_keys = OFF;
