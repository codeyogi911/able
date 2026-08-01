# ADR 0003: Keep channel conversations distinct from Desk and CRM work

- Status: accepted
- Date: 2026-07-20

## Context

The first WhatsApp Cloud API tracer proved signed ingress, provider idempotency, verified reply addressing, durable delivery, and the rolling customer-service window. It also sent every inbound WhatsApp message directly into Helpdesk intake. That assumption makes transport determine business intent: a sales inquiry becomes a support case before an agent has evaluated it.

A channel exchange is evidence, not inherently a case or a lead. The same conversation can contain support and sales intent, and a known customer can begin a new sales inquiry without creating a new canonical identity. Moving provider threads into either Helpdesk or CRM would also make the other module depend on private transport state and delivery policy.

## Decision

**Communications** is a deep module that owns verified external conversations, immutable messages, provider coordinates, attention state, customer-service windows, outbound delivery requests, and provider evidence. It is not a generic event bus or universal activity table.

Every transport adapter **enrolled in Communications** normalizes a verified inbound message into one `ConversationInboundEvent`: channel, provider, provider event and message IDs, account/endpoint/thread coordinates, occurrence time, and a payload hash. Communications records the provider-event receipt before exposing a decision workspace, so provider retries are harmless and later reconciliation can be added without trusting webhook delivery. It owns a channel-neutral contact address (`email`, `phone`, or opaque provider identity); channel-specific parsing and delivery stay in adapters.

The first enrolled adapter is signed WhatsApp. The pre-existing public portal and Email Service paths still create Helpdesk cases directly; they are not yet compliant with this decision and must be migrated only with a deliberate replacement for their current capability, attachment, and customer-confirmation behavior. This ADR defines their target architecture; it does not claim that migration is complete.

Signed inbound channel messages create or update a Conversation in `needs_attention`. They do not create a Desk case, CRM sales lead, Directory party, or relationship automatically.

A Conversation is a bounded work session, not the sender's permanent lifetime thread. Inbound messages accumulate while the session needs attention. After routing or reply marks it handled, the next inbound message begins a new Conversation for that same verified sender so later support or buying intent can create new work without reusing old route links.

An authenticated agent explicitly routes a Conversation to:

- **support**, creating and linking one Helpdesk Case;
- **sales**, explicitly adopting the channel contact into Directory and creating and linking one CRM Sales Lead;
- **both**, preserving one Conversation while creating distinct module-owned work items and receipts.

The suite router coordinates only public module commands. It never queries module-private tables, and it preserves truthful partial state if one target succeeds and another fails. Route links make retries idempotent and keep evidence coordinates explicit.

CRM owns Sales Leads as first-class qualification work. A Sales Lead is separate from the Party and from the longer-lived CRM Relationship. The initial lead lifecycle is intentionally small; opportunities and configurable pipelines remain later CRM work.

Customer-visible replies are commands on the Conversation only when that channel has an installed delivery adapter. The first adapter is WhatsApp: Communications rechecks the verified recipient and reply window when its durable outbox executes. Cases and leads may retain source snapshots and links, but they do not own WhatsApp credentials, provider message IDs, or service-window authority.

The agent-facing normal path is conversation-first: inspect the next Conversation needing attention or list compact inbox cards, load detailed history only when needed, then use its exact revision to route it or record a final no-action disposition. A mistaken final disposition can be reopened with an auditable reason and a new revision. Customer-visible replies go through that Conversation. The human recovery surface remains a thin view over unclassified, partially routed, blocked, or indeterminate work.

The email-verified browser voice surface is a bounded exception to the conversation-first path. It is support-only, has no general inbox, and creates a Helpdesk case only after the verified customer explicitly asks for a ticket or a deterministic safety policy requires human review. Helpdesk owns its voice source receipt and idempotency key. Ticket-status reads are scoped server-side to the verified email. Ambiguous channel messages still require Communications routing; this exception does not authorize voice to create CRM work or deliver a live human transfer.

## Consequences

- A WhatsApp inquiry no longer becomes a support case merely because it arrived over WhatsApp.
- One external thread can support Desk and CRM work without duplicating provider messages or canonical identity.
- Directory adoption remains explicit and auditable.
- Delivery truth and policy have one owner for every module.
- Cross-module routing can be partially complete; agents receive the completed links and the remaining target rather than a false all-or-nothing result.
- The unshipped migration `0008` is replaced in place so no deployed channel records require data conversion.
- Verified browser voice may create support cases directly under the narrow, explicit rules above; it cannot infer sales work or bypass Communications for a general-purpose channel inbox.

## Deferred decisions

- automatic route proposals and confidence thresholds;
- media ingestion and attachment projection;
- approved template sends outside the customer-service window;
- asynchronous sent, delivered, and read projection;
- opportunity conversion and configurable sales pipelines;
- route removal and merge commands.
