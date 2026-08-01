-- Canonical cross-module identity. Module-local records remain owned by their
-- modules and are linked explicitly through source coordinates.
CREATE TABLE directory_parties (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('person', 'organization')),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 240),
  revision TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE directory_contact_points (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL REFERENCES directory_parties(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'phone')),
  value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 320),
  normalized_value TEXT NOT NULL CHECK (length(normalized_value) BETWEEN 1 AND 320),
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (party_id, kind, normalized_value)
);

CREATE INDEX directory_contact_lookup_idx
ON directory_contact_points(kind, normalized_value, party_id);

CREATE TABLE directory_external_links (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL REFERENCES directory_parties(id) ON DELETE RESTRICT,
  source_module TEXT NOT NULL CHECK (length(source_module) BETWEEN 1 AND 80),
  source_entity_type TEXT NOT NULL CHECK (length(source_entity_type) BETWEEN 1 AND 80),
  source_entity_id TEXT NOT NULL CHECK (length(source_entity_id) BETWEEN 1 AND 240),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_module, source_entity_type, source_entity_id)
);

CREATE INDEX directory_external_party_idx
ON directory_external_links(party_id, created_at, id);

CREATE TRIGGER directory_external_links_immutable_update
BEFORE UPDATE ON directory_external_links
BEGIN
  SELECT RAISE(ABORT, 'directory external links are immutable');
END;

CREATE TRIGGER directory_external_links_immutable_delete
BEFORE DELETE ON directory_external_links
BEGIN
  SELECT RAISE(ABORT, 'directory external links are immutable');
END;

-- The first CRM aggregate and its append-only operational records. CRM owns
-- these tables; Directory and Helpdesk may only be reached through interfaces.
CREATE TABLE crm_relationships (
  id TEXT PRIMARY KEY,
  party_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'lead' CHECK (status IN ('lead', 'prospect', 'customer', 'inactive')),
  owner_id TEXT REFERENCES operators(id),
  revision TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX crm_relationship_owner_idx
ON crm_relationships(owner_id, status, updated_at, id);

CREATE TABLE crm_activities (
  id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL REFERENCES crm_relationships(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'call', 'email', 'meeting', 'support')),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  occurred_at TEXT NOT NULL,
  actor_id TEXT REFERENCES operators(id),
  source_module TEXT,
  source_entity_type TEXT,
  source_entity_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX crm_activity_relationship_idx
ON crm_activities(relationship_id, occurred_at DESC, id DESC);

CREATE TABLE crm_followups (
  id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL REFERENCES crm_relationships(id) ON DELETE RESTRICT,
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 500),
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
  owner_id TEXT REFERENCES operators(id),
  revision TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX crm_followup_queue_idx
ON crm_followups(status, due_at, owner_id, id);
