# ADR 0004: Publish the suite as Able, beginning with Able Desk

- Status: accepted
- Date: 2026-08-01

## Context

The implementation began with a single-tenant Desk + CRM foundation, while its longer-term direction is an agent-first ERP composed of deep business modules. The project identity therefore cannot be limited to helpdesk work, and the public repository must distinguish the suite from its first application.

## Decision

The suite name is **Able**. Its first application is **Able Desk**, a trustworthy, MCP-first Desk + CRM foundation. Future inventory, purchasing, orders, and accounting applications use the Able suite identity only when they exist as independent deep modules.

`Able` expresses forward motion and work carried into the next day. It is short, pronounceable, memorable, and broad enough for a durable open-source project without claiming that V1 is already a complete ERP.

This decision fixes project direction, not legal clearance. Maintainers must obtain jurisdiction- and class-appropriate trademark advice before treating the name or visual identity as legally cleared.

The public repository is the canonical development source. Private proving deployments consume exact commits and keep all tenant-specific configuration and evidence outside the project history.

## Consequences

- Public positioning is: **Able is being built as an agent-first ERP. Able Desk is its first application.**
- Documentation describes Desk as the first application and never markets the unfinished ERP as complete.
- New applications must satisfy the deep-module rule in ADR 0001 instead of expanding a universal object model.
- Publication and every contribution remain subject to repository, history, secret, and neutral-fixture gates.
