-- Runtime outcome reconciliation is separate from immutable command receipts.
-- A receipt proves a command commit; a closure records what happened later.
CREATE TABLE operation_closures (
  operation_id TEXT PRIMARY KEY REFERENCES operation_receipts(id) ON DELETE RESTRICT,
  contract_name TEXT NOT NULL CHECK (length(contract_name) BETWEEN 1 AND 160),
  intended_effect TEXT NOT NULL CHECK (length(intended_effect) BETWEEN 1 AND 2000),
  authoritative_source TEXT NOT NULL CHECK (length(authoritative_source) BETWEEN 1 AND 160),
  accepted_definition TEXT NOT NULL CHECK (length(accepted_definition) BETWEEN 1 AND 2000),
  delivered_definition TEXT NOT NULL CHECK (length(delivered_definition) BETWEEN 1 AND 2000),
  success_definition TEXT NOT NULL CHECK (length(success_definition) BETWEEN 1 AND 2000),
  failure_definition TEXT NOT NULL CHECK (length(failure_definition) BETWEEN 1 AND 2000),
  indeterminate_definition TEXT NOT NULL CHECK (length(indeterminate_definition) BETWEEN 1 AND 2000),
  recovery_policy TEXT NOT NULL
    CHECK (recovery_policy IN ('no_retry', 'idempotent_retry', 'compensate', 'human_review')),
  guard_metrics_json TEXT NOT NULL DEFAULT '[]',
  not_before TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed', 'indeterminate', 'superseded', 'not_observable')),
  reconciliation TEXT NOT NULL DEFAULT 'not_started'
    CHECK (reconciliation IN ('not_started', 'pending', 'reconciled', 'diverged')),
  revision TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (not_before < expires_at)
);

CREATE INDEX operation_closure_status_idx
ON operation_closures(status, expires_at, updated_at, operation_id);

CREATE TABLE operation_outcome_observations (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operation_closures(operation_id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 160),
  source_revision TEXT,
  observed_at TEXT NOT NULL,
  business_at TEXT,
  result TEXT NOT NULL CHECK (result IN ('accepted', 'delivered', 'succeeded', 'failed', 'indeterminate')),
  authoritative INTEGER NOT NULL CHECK (authoritative IN (0, 1)),
  within_window INTEGER NOT NULL CHECK (within_window IN (0, 1)),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  actor_id TEXT REFERENCES operators(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX operation_observation_idx
ON operation_outcome_observations(operation_id, observed_at, id);

CREATE TRIGGER operation_outcome_observations_immutable_update
BEFORE UPDATE ON operation_outcome_observations
BEGIN
  SELECT RAISE(ABORT, 'operation outcome observations are immutable');
END;

CREATE TRIGGER operation_outcome_observations_immutable_delete
BEFORE DELETE ON operation_outcome_observations
BEGIN
  SELECT RAISE(ABORT, 'operation outcome observations are immutable');
END;

-- Improvement evidence is isolated from canonical business state. The first
-- release intentionally has no runtime activation column or automatic learner.
CREATE TABLE improvement_proposals (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('tenant', 'product')),
  artifact_kind TEXT NOT NULL
    CHECK (artifact_kind IN ('playbook', 'prompt', 'policy', 'tool', 'context_compiler', 'ontology', 'model', 'code')),
  target_key TEXT NOT NULL CHECK (length(target_key) BETWEEN 1 AND 240),
  base_version TEXT NOT NULL CHECK (length(base_version) BETWEEN 1 AND 240),
  candidate_version TEXT NOT NULL CHECK (length(candidate_version) BETWEEN 1 AND 240),
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'evaluated', 'rejected', 'withdrawn')),
  evidence_json TEXT NOT NULL,
  revision TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT REFERENCES operators(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX improvement_proposal_status_idx
ON improvement_proposals(status, scope, artifact_kind, updated_at, id);

CREATE TABLE improvement_evaluations (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES improvement_proposals(id) ON DELETE RESTRICT,
  suite_version TEXT NOT NULL CHECK (length(suite_version) BETWEEN 1 AND 240),
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  report_json TEXT NOT NULL,
  actor_id TEXT REFERENCES operators(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX improvement_evaluation_proposal_idx
ON improvement_evaluations(proposal_id, created_at, id);

CREATE TRIGGER improvement_evaluations_immutable_update
BEFORE UPDATE ON improvement_evaluations
BEGIN
  SELECT RAISE(ABORT, 'improvement evaluations are immutable');
END;

CREATE TRIGGER improvement_evaluations_immutable_delete
BEFORE DELETE ON improvement_evaluations
BEGIN
  SELECT RAISE(ABORT, 'improvement evaluations are immutable');
END;

CREATE TABLE loop_controls (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  runtime_frozen INTEGER NOT NULL DEFAULT 0 CHECK (runtime_frozen IN (0, 1)),
  tenant_adaptation_frozen INTEGER NOT NULL DEFAULT 1 CHECK (tenant_adaptation_frozen IN (0, 1)),
  product_improvement_frozen INTEGER NOT NULL DEFAULT 1 CHECK (product_improvement_frozen IN (0, 1)),
  updated_by TEXT REFERENCES operators(id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO loop_controls (id) VALUES (1);
