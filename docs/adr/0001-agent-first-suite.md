# ADR 0001: Grow through deep business modules over shared agent substrate

- Status: accepted
- Date: 2026-07-17

## Context

Traditional ERP deployments often make users assemble many products, duplicate identity and records, and bridge shallow interfaces with fragile integrations. Morrow Desk begins as a support desk, but its intended direction is a coherent agent-first operations suite.

Building a generic ERP framework in V1 would recreate a different version of the same complexity. Support also has real invariants—private customer capabilities, case revisions, visibility, and email truth—that should not be diluted into generic CRUD.

## Decision

Morrow Desk is the first complete vertical module. Future modules such as inventory, purchasing, orders, fulfillment, and accounting must each present a small, high-leverage agent interface and own their rules and persistence.

The suite may share only infrastructure with proven cross-module semantics:

- verified people and operator identity;
- workspace configuration;
- immutable audit evidence;
- idempotent operation receipts;
- private files and typed resources;
- durable external-delivery state;
- external-source provenance;
- consistent MCP discovery, errors, revisions, and diagnostic conventions.

Cross-module behavior is explicit orchestration through module interfaces. A module may not query another module's private tables. We will not add a runtime plugin framework, universal custom-field engine, or universal business-object table before at least two real modules prove a seam.

## Consequences

- V1 stays small enough to ship and replace the existing desk.
- Later modules can share one identity and operating surface without sharing accidental domain coupling.
- Agents get stable, task-shaped operations instead of raw table tools.
- Some concepts that look similar remain separate until their invariants are actually common.
- A later product rename or umbrella project may be appropriate; this ADR does not force the helpdesk name onto every module.

## First extension test

This section is superseded by [ADR 0002](0002-agent-first-desk-crm-foundation.md), which selects CRM as the second module. Its design is acceptable only if it can reuse the shared substrate while being deleted or deployed without changing Helpdesk lifecycle code.
