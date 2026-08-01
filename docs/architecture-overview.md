# Architecture overview

![Morrow Desk architecture overview](assets/architecture-overview.svg)

Morrow Desk is one Cloudflare Worker with narrow channel adapters, deep business modules, and Cloudflare-managed storage and delivery services. This diagram describes the implemented V1 architecture; the binding details remain in [the architecture reference](architecture.md) and [V1 product contract](product-v1.md).

## How to read the diagram

- **Operator plane:** agent clients reach MCP and the small `/ops` recovery surface only through verified Cloudflare Access identity.
- **Customer channels:** the public portal, knowledge base, browser voice, email, and signed WhatsApp ingress enter through channel-specific security boundaries.
- **Adapters:** MCP, portal, email, WhatsApp, voice, and `/ops` authenticate, translate, and render. They do not own business policy.
- **Deep modules:** Communications, Helpdesk, Directory, CRM, Operations, and Improvement own their state, lifecycle, revisions, evidence, and public interfaces.
- **Platform:** D1 holds canonical business state, private R2 holds originals, queues and cron isolate asynchronous work, one Durable Object owns a verified voice session, and Workers AI, Images, Email Service, and external providers remain bounded infrastructure.

The normal truth flow is: authenticate, load a bounded workspace, commit state plus audit and receipt, deliver asynchronously, then observe the business outcome. Provider acceptance and successful business outcome are deliberately different states.

## Context direction

Morrow already composes revisioned cross-module context through public interfaces. A richer relationship view should extend that boundary as a rebuildable projection, not let agents query module tables or receive an unbounded graph dump. See the [bounded context graph proposal](context-graph.md).
