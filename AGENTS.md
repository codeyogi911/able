# Able

## Goal

Build a trustworthy, agent-first ERP for service businesses. Able Desk is the first application: a single-tenant Desk + CRM foundation on Cloudflare Workers where MCP is the normal operator interface, customers use accessible approved channels, and `/ops` is a small Cloudflare Access-protected recovery surface. Grow through deep business modules with small agent interfaces—not generic CRUD, a plug-in framework, or a universal object model.

## Working context

Two different jobs happen in this repository. Decide which one you are doing before you change anything.

- **Upstream work** — improving Able itself. Everything you produce must be tenant-neutral: generic issues, neutral fixtures, no business named anywhere. This is the default when no private context is present.
- **Deployment work** — configuring, deploying, or extending Able for one specific business. If `AGENTS.local.md` exists, read it first: it holds that deployment's standing context. Tenant facts belong there, in the deployment platform, or in runtime workspace settings — never in tracked files, tests, fixtures, commit messages, or issues.

Prefer the lowest customization level that solves the problem: runtime workspace settings, then a module or adapter that respects the public seams, then core change. [docs/adopt.md](docs/adopt.md) defines the boundary and the levels; when deployment work uncovers a generic defect, fix it upstream with a neutral test instead of patching locally.

## Operating model

Act as the lead orchestrator. Start from the user outcome, inspect relevant evidence, define the completion bar, and own integration and final verification. For sizeable work with genuinely independent streams, delegate bounded research, implementation, or review tasks with the context, constraints, success criteria, and expected return each delegate needs. Run safe independent reads in parallel. Work directly when the task is simple, sequential, or tightly coupled; do not delegate merely to duplicate work.

## Scope and autonomy

For an in-scope local change, implement it and run relevant non-destructive validation without waiting. State material assumptions. Ask before destructive, externally visible, costly, or materially scope-expanding actions. Do not claim a capability, delivery state, or production readiness without evidence.

## Architecture and quality

- Keep business policy, lifecycle, state, audit, idempotency, and outbox behavior inside the owning deep module. Adapters authenticate, translate transport, and render results; cross-module work uses public interfaces.
- Follow [CONTRIBUTING.md](CONTRIBUTING.md), including its package-first, latest-compatible-stable dependency policy. Use compatible maintained packages for standard protocols and security primitives.
- For behavioral or architectural changes, cover the affected public seam and run `npm run check`. Changes to voice prompts or tool descriptions also require `npm run eval:voice`.
- Keep the public repository generic. Proving-ground deployments consume exact Able commits; their secrets, identifiers, content, data, and runbooks never enter this repository. Generalize discoveries upstream instead of creating a tenant fork.
- Never commit secrets, real customer data, production identifiers, private tenant configuration, or raw migration exports.

## Canonical references

Use [README.md](README.md) for the project and repository map, [docs/adopt.md](docs/adopt.md) for the adopter journey and tenant boundary, [docs/product-v1.md](docs/product-v1.md) for the binding Desk V1 contract, [docs/architecture.md](docs/architecture.md) and [docs/adr/](docs/adr/) for design boundaries, [docs/development.md](docs/development.md) for the upstream/proving-ground workflow, and [docs/roadmap.md](docs/roadmap.md) for direction. Put detailed path-specific rules beside the code or documentation they govern.
