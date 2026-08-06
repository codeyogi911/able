# Able roadmap

- Status: living document
- Last reviewed: 2026-08-01
- Owners: repository maintainers

This roadmap keeps day-to-day work pointed at the agreed direction: an agent-first operations suite built as deep vertical modules over a small shared substrate ([ADR 0001](adr/0001-agent-first-suite.md), [ADR 0002](adr/0002-agent-first-desk-crm-foundation.md)). The binding release contract for the current major version stays in [the V1 specification](product-v1.md); this document orders what comes after and records what we have chosen not to do.

Changing an item's horizon is a pull request. Changing the direction itself — module boundaries, substrate scope, authority model — requires a new ADR first.

## Where we are

The V1 foundation includes a Desk + CRM tracer over the shared substrate, MCP-first operation, a portal with guarded branding, email and signed WhatsApp text ingress, and the browser assistant. The customer surface is launch-shaped but still requires clean-clone, deployment, and live proving evidence before a production-readiness claim.

## Now — a launch-ready customer experience

1. **Chat-first assistant, capabilities one at a time.** Grounded article answers with links, order lookup by the order-number/email pair, and ticket creation are shipped behind live evals. Text help starts anonymous and asks for email only at an identity-bearing action. Ticket status remains next only after real mailbox verification is activated for that read. Each addition extends `eval:voice` before it ships.
2. **Knowledge content pipeline.** Starter sections and articles authored per deployment through `able_article_put`, suggested-article quality on intake, and a portal that stays presentable while the base is still empty. The repository ships structure, never tenant content.
3. **Search retrieval depth.** Tokenized, stop-word-aware ranking now weights article title, excerpt, and body for both portal results and assistant grounding. Move to an indexed implementation such as D1 FTS5 only when corpus size or measured latency justifies it, while preserving the no-JS portal fallback and strict CSP.
4. **Proving-ground discipline.** Deploy exact public commits through a protected environment, keep tenant evidence outside the repository, and return sanitized findings as generic upstream issues and tests. Follow [the development workflow](development.md).

## Next — depth in the shipped modules

- **Desk operations:** truthful SLA timers and breach visibility, saved queue views, and reporting read-models (metrics, CSAT capture) — promoted from V1 exclusions only with the same evidence discipline as existing read-models.
- **Communications:** WhatsApp media, templates, and `sent`/`delivered`/`read` status projection as explicit pilot gates; further channels only when their verification and reply-window invariants are owned, not adapted in.
- **Voice:** telephone-network calling only behind a real availability/queue/timeout/receipt/fallback state machine and a telephony provider; until then the channel never claims calls or live-human transfer. Prioritize measured end-to-end latency, barge-in behavior, and truthful fallback states before expanding the channel.
- **CRM:** opportunity and pipeline commands beyond the relationship tracer; fuzzy entity-resolution candidates with explicit merge/split workflows (candidates never become equality automatically).
- **Bounded context graph:** evaluate a rebuildable D1 node-and-edge projection behind one read-only context lens. Add Vectorize only if measured seed discovery needs semantic help; see [the proposal](context-graph.md).
- **Controlled improvement:** recovery-console controls for version manifests, bounded rollout, promotion, and rollback; tenant adaptation activation stays separately authorized and off by default.

## Later — the suite

- Inventory, purchasing, orders, and accounting as deep vertical modules with small agent interfaces, reusing identity, context envelopes, receipts, audit, files, delivery, and provenance — never each other's private tables.
- A dedicated external graph database only when measured traversal or scale evidence shows the D1 projection is the limiting factor.
- Externally delegated agent-to-agent operation only after the delegation model in ADR 0002 gains explicit fields and authorization.

## Standing non-goals

These hold unless an ADR supersedes them: no runtime plugin framework or universal custom-field/business-object engine before two real modules prove a seam; no autonomous activation of improvement proposals; no customer passwords; no arbitrary portal CSS or scripts; no multi-tenant SaaS; no claim of phone calls, live chat with a human, or delivery beyond what receipts actually prove.

## Engineering health

Tracked so quality debt does not queue behind features:

- Reconcile automated dependency bumps with the pinned voice stack policy in [the voice channel doc](voice-demo.md) — either exclude those packages from automation or gate their bumps on the live eval suite.
- Isolate the Workers test pool from developer-local `.dev.vars` so `npm run check` is deterministic on every machine.
- Regenerate and maintain both platform sets of visual baselines (Linux baselines go stale when only macOS runs the suite); prefer running visual checks in CI.
- Connect the documented Workers Builds main-branch trigger so production deploys stop depending on a maintainer's workstation.
- Extend the voice eval suite in lockstep with each new assistant capability.
