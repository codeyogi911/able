# Able Desk V1 product contract

This document is the implementation contract for the first public-ready Able Desk release. Able Desk is a single-tenant Desk + CRM foundation per Worker deployment. Operators work primarily through MCP, customers use the public portal, email, and a bounded WhatsApp text pilot, and administrators retain a small Cloudflare Access-protected recovery console.

## Product boundary

V1 includes case queues and search, complete case workspaces, manual case opening, public replies, private notes, status, priority, category, assignment, customer corrections, knowledge articles, attachments, magic-link customer threads, inbound email, agent-customizable rich outbound notifications, browser text and optional voice assistance, optional read-only Shopify order lookup, manually recorded phone cases, signed WhatsApp text conversations with explicit Desk/CRM routing and conversation-owned replies, immutable audit evidence, operational diagnostics, canonical Directory adoption, first-class CRM sales leads, CRM relationship state, sourced activities, scheduled follow-ups, cross-module customer context, operation closure contracts, and inactive improvement proposals with independent evaluation records.

V1 excludes customer passwords, community features, live human chat, telephone-network calling, non-WhatsApp social channels, WhatsApp media/templates/status receipts, opportunity/deal pipelines, configurable CRM objects, sales forecasting, write-capable store integrations, macros, general workflow automation, SLA timers, analytics, CSAT, custom fields, an integration marketplace, autonomous candidate activation, and multi-tenant SaaS.

## Required interfaces

The normal Desk path is exactly two calls: `able_case_next`, then `able_case_reply`. New external conversations begin with `able_inbox_next` or `able_inbox_list`, followed by `able_conversation_get` when deeper history is needed, an explicit route or clear decision, and any reply on the Conversation. The MCP surface is:

- `able_case_next`
- `able_case_get`
- `able_attachment_inspect`
- `able_case_list`
- `able_case_search`
- `able_knowledge_search`
- `able_case_create`
- `able_case_reply`
- `able_case_add_note`
- `able_case_update`
- `able_inbox_next`
- `able_inbox_list`
- `able_conversation_get`
- `able_conversation_route`
- `able_conversation_classify`
- `able_conversation_reopen`
- `able_conversation_reply`
- `able_crm_lead_next`
- `able_crm_lead`
- `able_customer_workspace`
- `able_party_adopt`
- `able_crm_relationship`
- `able_crm_activity`
- `able_crm_followup`
- `able_operation`
- `able_operation_track`
- `able_operation_observe`
- `able_operation_expire`
- admin-only `able_improvement`
- admin-only `able_improvement_propose`
- admin-only `able_improvement_evaluate`
- admin-only `able_article_put`
- admin-only `able_portal_customize`
- admin-only `able_email_customize`
- admin-only `able_diagnostics`
- resources `able://attachments/{id}`, `able://attachments/{id}/preview`, and `able://articles/{slug}`
- MCP App resource `ui://able/workspace.html`

`able_case_next` returns case state and opaque revision, customer identity, public and internal messages, assignment, attachments, delivery warnings, and up to three relevant knowledge suggestions.

`able_attachment_inspect` is a read-only, task-shaped evidence tool. It defaults to a bounded summary and progressively discloses extracted evidence or one verified image only when requested. Immutable originals stay private in R2. Type detection comes from file signatures, image and PDF descriptions are processed outside MCP request latency and cached by source hash and processor version, and all customer-derived content is marked as untrusted evidence rather than instructions.

`able_customer_workspace` composes Helpdesk, Directory, and CRM through their public interfaces. It returns module revisions, explicit unknowns, evidence coordinates, and permitted next actions. Identity remains unresolved until `able_party_adopt` explicitly links the Helpdesk customer snapshot to a canonical Directory party.

An operation receipt proves that a command committed. `able_operation_track` declares a separate outcome contract, `able_operation_observe` retains sourced observations, and `able_operation_expire` marks an elapsed pending window as not observable from server time. Non-authoritative or out-of-window evidence cannot close the operation. Improvement proposals remain inactive after passing evaluation; V1 exposes no activation tool or active proposal status.

Every successful tool result exposes the same secret-filtered payload as both structured content for MCP Apps and a JSON text fallback. The App is presentation-only: case mutations remain model-mediated tool calls that must use the latest opaque revision.

The public support homepage is an agent conversation that grounds ordinary questions in published knowledge and requests identity only when an order or durable follow-up needs it. Conventional topic browsing, article search, and articles remain at `/kb`; request intake with suggested articles, private attachments, capability-based case threads and replies, and non-enumerating lost-link recovery remain secondary routes. `able_portal_customize` and `/ops/settings` share the same audited, contrast-checked brand settings for display name, portal title, brand icon or logo, favicon, home link, colors, and one of four guarded font families. `able_email_customize` controls enabled state, subject, plain-text fallback, and sanitized Markdown for case received, update received, agent reply, and case recovery notifications. Arbitrary CSS, raw email HTML, remote font code, and scripts are outside V1. `/ops` is a recovery and configuration surface, not a second full agent desk.

## Domain invariants

- Actor identity comes from verified Cloudflare Access claims, never a tool argument.
- The first operator mutation auto-claims an unassigned case.
- Every case mutation requires the latest opaque revision.
- Operator idempotency derives from actor, case, revision, and canonical command. Portal intake uses a form request ID; email uses `Message-ID`.
- Case state, message, audit event, operation receipt, attachment metadata, and outbox work commit before external delivery starts.
- Public operator replies default to `waiting_on_customer`. Customer replies reopen waiting or resolved cases. Closed cases reject replies.
- `accepted` records provider acceptance and never claims inbox delivery.
- Customer capabilities are hashed at rest and never appear in MCP results, logs, or audit events.
- Public intake remains disabled until outbound mail passes a setup test.
- Directory adoption is explicit and never turns fuzzy similarity into equality.
- CRM updates require the latest relationship revision; activities remain append-only and retain source coordinates.
- Context composition never grants mutation authority and never reads another module's private tables.
- Tool success, provider acceptance, delivery, and business outcome remain distinct states.
- Runtime evidence may motivate a proposal but cannot activate a prompt, playbook, policy, tool, ontology, model, or code version.

The domain vocabulary is fixed to `open | waiting_on_customer | on_hold | resolved | closed`, `low | normal | high | urgent`, `portal | email | manual | whatsapp | voice`, and `queued | accepted | blocked | failed | indeterminate`. A Conversation is channel evidence; a Case is support work; a Sales Lead is qualification work.

## Architecture

Deep `Communications`, `Helpdesk`, `Directory`, and `CRM` modules own their business state and rules. Suite routers and context composers call only their public interfaces. Communications owns verified addressing, reply windows, external messages, and provider evidence; it does not decide business intent. Operation closure and improvement-control modules own outcome observations and inactive candidate records. MCP, portal, email, WhatsApp, and recovery-console adapters only authenticate, translate, and render.

The Worker binds static assets, one D1 database, one private R2 bucket, Email Service, a public rate limiter, and a retry cron. The same Worker is exposed on distinct public and operator hostnames. One domain-wide Access application protects the operator hostname carrying `/mcp` and `/ops`; host routing and operator authentication fail closed until the operator hostname, Access issuer, and audience are valid. No production domains, senders, resource identifiers, or Access metadata belong in the repository.

Able Desk is an agent-first business suite foundation. Identity, context envelopes, durable operation state, audit, receipts, files, delivery, provenance, and controlled improvement records are shared substrate. Future inventory, purchasing, order, and accounting capabilities remain deep modules with small interfaces; they do not reach into Helpdesk or CRM private tables. See [ADR 0001](adr/0001-agent-first-suite.md) and [ADR 0002](adr/0002-agent-first-desk-crm-foundation.md).

## Schema and deployment evolution

Committed D1 migrations evolve Able's own schema and must remain additive or carry an explicit compatibility plan. Importing history from another desk is not part of the public V1. A future import adapter must use documented source contracts, restartable evidence, deterministic identity rules, and reconciliation before it can enter the product boundary.

Hosted proving grounds deploy exact public commits through protected environments. Their private configuration and operational cutover procedures are not product source; see [development.md](development.md).

## Release gates

`npm run check` must pass asset generation, type generation, typechecking, Worker integration tests, node tests, and the public-readiness scan. Tests cover authorization, queue ordering, auto-claim, revisions, replays, stale writes, visibility, capability secrecy, state transitions, the two-call Desk contract, explicit conversation routing, route recovery, truthful email and WhatsApp delivery state, portal safety, deduplication and suppression, and stored-XSS payloads.

Portal visual checks run at 360, 390, 768, and 1440 CSS pixels. Mobile inputs are at least 16px, interactive targets at least 44px, layouts do not overflow horizontally, forms are keyboard complete, contrast is WCAG AA, and reduced-motion preferences are safe.

Publication is blocked unless a clean clone deploys in an unrelated Cloudflare account, the full history contains no private branding, production identifiers, personal email, or secret, and all deployment branding comes from private workspace configuration.
