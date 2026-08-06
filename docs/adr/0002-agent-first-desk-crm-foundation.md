# ADR 0002: Establish the agent-first Desk + CRM foundation

- Status: accepted
- Date: 2026-07-18
- Supersedes: ADR 0001's choice of inventory or purchasing as the second module

## Context

Able Desk begins as a deep support module, but its intended product is an agent-first ERP for service businesses. Its first extensions must prove shared identity, cross-module decision context, typed module commands, durable outcomes, and controlled improvement rather than broad CRM feature parity or a generic ERP framework.

Traditional admin software makes screens and records the primary interface. Able Desk instead treats agents as the normal operators, MCP as an adapter over business capabilities, deterministic modules as the systems of record, and the recovery console as a thin independent control surface.

## Decision

### Module boundaries

CRM is the second deep business module.

- **Directory** owns canonical parties, contact points, and explicit links from module-local identities. A customer is a contextual role, not the universal identity record.
- **Helpdesk** continues to own cases, messages, case lifecycle, support customer snapshots, and delivery truth.
- **CRM** owns relationships, relationship status and owner, activities, follow-ups, pipeline, and opportunities. The first tracer implements relationship state, activities, and follow-ups.
- A **suite context composer** calls public module interfaces to build `customer_workspace.v1`. It never queries another module's private tables.
- Mutations remain module-local and return immutable operation receipts. A suite-level intent may correlate multiple receipts but cannot hide partial failure.

Directory adoption of an existing Helpdesk customer is an explicit, idempotent command. It receives a Helpdesk-owned identity snapshot and source coordinate; Directory never queries Helpdesk tables. Fuzzy matches remain candidates and never become canonical equality automatically.

### Shared agent substrate

The suite uses four planes:

1. module-owned canonical business state;
2. versioned, authorization-filtered decision context;
3. durable operation and outcome state;
4. immutable receipts, audit, and provenance.

A small versioned business ontology supplies stable meanings across those planes. It is not a universal writable object model. The first implementation uses typed relational projections; a dedicated graph store is deferred until measured cross-module query value justifies it.

Every context envelope identifies its schema version, observation time, module revisions, unknowns, permitted actions, and evidence coordinates. A context response is not permission to mutate.

### Mutation and authority

Principal, executor, client, and delegation remain distinct concepts. The current release has a verified operator principal and the Able Desk MCP executor; future delegation fields may be added without accepting actor identity from tool arguments.

Every mutation has an idempotency identity and immutable receipt. Updates to mutable aggregates require the latest opaque revision. Cross-module work uses typed orchestration and compensation rather than table access or distributed transactions.

### Closed-loop operation and improvement

Closed-loop behavior is a lifecycle and control overlay, not another source of business truth.

1. The **runtime operation loop** connects intent, effect receipts, outcome observations, and reconciliation or compensation.
2. The **tenant adaptation loop** turns tenant evidence into inactive, versioned configuration proposals that require tenant-scoped evaluation and activation.
3. The **product improvement loop** turns minimized telemetry and feedback into findings, evaluation cases, candidate versions, bounded rollout, post-deployment verification, and promotion or rollback.

These loops are separately authorized. Runtime evidence can propose a change but cannot activate it. No learned or inferred value writes canonical business state directly.

An operation closure contract declares the intended effect, authoritative observation source, observation window, terminal statuses, guard metrics, and recovery behavior. A receipt proves a committed command; it does not prove provider delivery or the ultimate business outcome.

Canonical state, retained receipts and audit, telemetry, evaluation datasets, and inactive improvement proposals use distinct schemas, permissions, retention, provenance, and write paths. Raw tenant records do not become product-global evaluation or training data by default.

### Recovery

The Access-protected recovery surface must remain independent of the model and agent host. It will eventually expose active version manifests, pending or indeterminate operations, frozen-loop state, proposal evidence, and rollback controls. This ADR establishes the persisted contracts before adding those controls to `/ops`.

## First vertical tracer

The first end-to-end behavior is:

1. load a Helpdesk case;
2. explicitly adopt its customer snapshot into Directory;
3. load `customer_workspace.v1` from Helpdesk, Directory, and CRM;
4. create or update the CRM relationship;
5. record a CRM activity and schedule a follow-up using module-owned commands;
6. return distinct immutable receipts and expose module revisions and unknowns;
7. preserve truthful partial state if any later command fails.

The tracer is tested at the Directory, CRM, context-composer, MCP, and Worker boundaries. Tests observe public results rather than private SQL implementation.

## Consequences

- Helpdesk does not become a CRM and CRM does not read case tables.
- Shared identity is introduced through explicit adoption rather than a risky in-place customer-table rewrite.
- MCP tools remain task-shaped and thin; domain behavior stays below the adapter.
- The initial semantic projection can be rebuilt from relational truth without adopting a graph database.
- Improvement candidates are evidence-backed, independently evaluated, and inactive; activation, bounded rollout, verification, promotion, and rollback remain deferred, so there is no online self-modification path.
- Inventory and Books remain later deep modules that can reuse the same identity, context, operation, receipt, and provenance contracts.

## Deferred decisions

- fuzzy entity-resolution and merge/split workflows;
- opportunity and pipeline commands beyond the first relationship tracer;
- a dedicated graph database, RDF serialization, or SHACL runtime;
- automated tenant adaptation activation;
- cross-tenant product learning;
- externally delegated A2A agents;
- full recovery-console controls for version promotion and rollback.
