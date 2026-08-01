# Architecture

For the system at a glance, start with the [architecture overview](architecture-overview.md). This document defines the detailed boundaries behind that diagram.

Morrow Desk is one Cloudflare Worker with Hono JSX server rendering, static assets, D1, a private R2 bucket, Email Service, a rate-limit binding, and a retry cron. The V1 product has no browser SPA or live-chat state. Verified browser voice support adds one Agents SDK Durable Object: Turnstile and a short-lived email OTP bind a customer identity to one WebSocket connection, then narrow bridge methods can open Helpdesk cases or read status only for that verified email. The model never supplies the customer identity. Portal branding is deployment data behind one shared validator: `/ops/settings` and the admin-only MCP customization tool write the same bounded identity, asset URL, color, and font fields and emit the same audit event. Customer email templates are separate audited deployment data: the admin MCP tool validates known brace placeholders, stores plain-text and Markdown variants, and sanitizes rich HTML before it enters the durable outbox.

## Deep modules

The `Helpdesk` module is the only place that knows case SQL, lifecycle rules, capability hashing, revision checks, idempotency derivation, audit evidence, and outbox creation.

```ts
interface Helpdesk {
  work(actor, selector): Promise<CaseWorkspace | QueueResult | SearchResult>
  act(actor, command): Promise<ActionReceipt>
  intake(source, request): Promise<CustomerReceipt>
  customer(capability, command): Promise<CustomerResult>
  inspectAttachment(actor, attachmentId): Promise<AttachmentInspection>
  resource(actor, uri): Promise<ResourceBody>
}
```

MCP, portal, email, WhatsApp, and `/ops` are adapters. They authenticate or parse transport input, call the module, and render the result. They do not duplicate case policy. The current implementation lives under `apps/desk/src`; future package extraction must preserve these ownership boundaries.

Directory and CRM follow the same rule:

- Directory owns canonical parties, contact points, and immutable external source links.
- Helpdesk retains its module-local customer snapshot and never treats an email address as universal identity.
- CRM owns relationship status and owner, append-only activities, and revisioned follow-ups.
- CRM verifies a party through the Directory interface; it never queries Directory tables.
- `customer_workspace.v1` composes Helpdesk, Directory, and CRM results through their public interfaces and exposes each module revision plus unresolved facts.
- Every composed envelope identifies the `morrow-business.v1` ontology documented in [the v1 ontology](ontology/morrow-business-v1.md).

MCP exposes task-shaped adapters for these capabilities. It does not offer generic table, graph, object, or JSON mutation tools.

## Closed-loop control

Immutable operation receipts and mutable outcome closure records are separate. A receipt proves command commit. A closure contract adds the intended effect, definitions for accepted, delivered, succeeded, failed, and indeterminate outcomes, an authenticated authoritative source, guard metrics, recovery policy, observation window, status, reconciliation state, revision, and append-only observations. Non-authoritative evidence is retained but cannot close the contract. A pending contract transitions to `not_observable` only through server-time expiry; expiry never invents an observation.

Improvement proposals are isolated from canonical business state. A proposal records artifact kind, target, base and candidate versions, and operation-receipt evidence coordinates. A different administrator from the proposer may append an independent evaluation against the latest proposal revision. The persisted state machine ends at `evaluated` or `rejected`; it has no activation state, and MCP has no deployment or promotion tool.

The `loop_controls` row starts with tenant adaptation and product improvement frozen. It reserves an independent recovery boundary without pretending that those loops are operationally autonomous today.

Attachment intelligence is derived infrastructure, not case truth. Originals remain immutable in private R2. A background media processor verifies signatures, extracts UTF-8 deterministically, and uses the configured Workers AI Markdown conversion for image and PDF evidence. D1 caches only bounded derived Markdown and provenance. MCP inspection reads that cache without enqueuing hidden work, progressively discloses evidence, and labels every customer-derived observation as untrusted.

Provider delivery owns only generic outbox claims, retries, and provider submission. Helpdesk-owned delivery projectors materialize case capabilities and project provider state into case messages inside the same D1 batch. Operational queue counts and case-reference labels likewise come from Helpdesk read models; platform diagnostics never query Helpdesk tables directly.

## Commit-before-delivery

A mutation first commits case state, message, audit evidence, operation receipt, attachment metadata, and outbox row. External mail starts afterward. `accepted` means the provider accepted the request; it never means the message reached an inbox. If provider acceptance succeeds and persistence cannot be confirmed, the row becomes `indeterminate` and is never retried automatically.

Cloudflare Email Service failures are classified from its documented error code. Only explicit quota or rate-limit rejection is automatically retried. Explicit permanent rejection becomes `blocked`; internal, unknown, or untyped failures become terminal `indeterminate` because they do not prove the provider rejected the submission before acceptance. See the [official Workers API error contract](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).

## Identity and capabilities

Operator identity comes only from a verified Cloudflare Access assertion. Tool arguments cannot name an actor. The public portal and operator surfaces are separate hostnames bound to the same Worker. One domain-wide Access application protects the dedicated operator hostname, which carries both `/mcp` and `/ops`; portal routes are rejected there, and operator routes are rejected on the public hostname. Production operator routing fails closed until the bare operator hostname, Access issuer, and audience are configured. Localhost retains a development-only bypass.

Customer access uses a high-entropy per-case capability. Only its hash is stored. Raw capabilities are excluded from MCP output, audit evidence, application logs, and operation receipts. Attachments remain private in R2 and require either operator identity or a capability authorized for the owning case.

Email places the capability in the URL fragment of `/requests/access`, so it is not sent in the HTTP request target. A same-origin bootstrap exchanges it at the fixed `/requests/session` endpoint for an `HttpOnly`, `Secure`, `SameSite=Strict` cookie, removes the fragment from browser history, and then uses only fixed `/requests/case` and attachment paths. The capability is never rendered into portal HTML. Automatic invocation logs are disabled in the committed Worker configuration so customer cookies and request headers are not captured by default.

## Reusable suite substrate

Workspace settings and operators are deployment-wide. Directory identity, context envelopes, operation closures, audit, operation receipts, attachments, delivery, provenance, and inactive improvement records are shared substrate. A business module may reuse that substrate but cannot reach into another module's tables or lifecycle logic.

See [ADR 0001](adr/0001-agent-first-suite.md) for the long-term module rule and [ADR 0002](adr/0002-agent-first-desk-crm-foundation.md) for the Desk + CRM and closed-loop decisions.

A richer cross-module relationship view is proposed as a rebuildable, read-only projection in [the bounded context graph proposal](context-graph.md). It is not part of the implemented V1 architecture or a source of business truth.
