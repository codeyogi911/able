# Adopt Able for your business

This guide is for someone who wants to **run** Able, not develop it. It covers what to bring, how to take a copy that can still receive upstream fixes, where your business's identity is allowed to live, and how much of the work an AI agent can do for you.

If you are here to change Able itself, read [CONTRIBUTING.md](../CONTRIBUTING.md) and [development.md](development.md) instead.

## What Able is, honestly

Able Desk is a single-tenant support desk and CRM that runs as one Cloudflare Worker in **your** Cloudflare account, on **your** domain, holding **your** data. There is no Able-hosted service, no sign-up, and no vendor between you and your customers.

It is early V1. The architecture and Desk flows are implemented and tested, but a deployed Worker is not by itself an operational support desk — several steps in [deployment.md](deployment.md) are gates, not suggestions. Do not point real customers at it until you have worked through them.

## What you need to bring

| Requirement | Why | Notes |
| --- | --- | --- |
| A Cloudflare account, Workers Paid | Email Service outbound sending | 3,000 outbound messages/month included; inbound routing is unlimited. Confirm [current pricing](https://developers.cloudflare.com/email-service/platform/pricing/). |
| A domain on Cloudflare | Two hostnames on the same Worker | e.g. `help.example.com` (public portal) and `desk.example.com` (operators). |
| Cloudflare Zero Trust (Access) | Operator identity | One self-hosted Access application over the whole operator hostname. |
| A mail domain you control | Sending and receiving support mail | Sender authentication must pass before public intake can be enabled. |
| Node.js 22 or 24+, npm, git | Build and deploy | See `.nvmrc`. |
| An MCP-capable agent client | The normal operator interface | Able is operated through MCP tools first; `/ops` is recovery, not a second desk. |

Optional rails, each independently switchable: WhatsApp Cloud API (Meta app + WABA), Shopify product discovery over the catalog-only UCP profile, Shopify read-only order lookup, Shopify customer-account sign-in, browser voice assistance.

## Try it before you provision

`npm install && npm run dev:parity` builds the same assets and Worker entry point used for deployment, applies every migration, and seeds only neutral `example.test` fixtures. No Cloudflare resources, customer data, or secrets are required. Read the topology caveats in [development.md](development.md) first — notably that the microphone is deliberately disabled locally, and that Access, Turnstile, and email acceptance are only real on a deployed hostname.

## Fork — do not use a template copy

Take a **fork** (or a clone with `upstream` wired up), not a detached snapshot. Able ships schema migrations and security fixes; a copy that cannot pull them becomes a liability within a release or two.

```bash
git clone https://github.com/codeyogi911/able.git my-desk && cd my-desk && git remote add upstream https://github.com/codeyogi911/able.git
```

Then follow [deployment.md](deployment.md) end to end.

## The tenant boundary

The single rule that keeps your deployment upgradable: **your business never appears in the repository.** Everything specific to you lives in one of three places, none of which is source control.

| Where it lives | What belongs there | Examples |
| --- | --- | --- |
| **Runtime workspace settings** (D1, edited via `/ops/settings` or the admin MCP tools) | Everything customer-visible | Display name, portal title, logo, favicon, colors, font, case prefix, locale, timezone, support hours, sender addresses, portal base URL, the four customer email templates, knowledge articles |
| **Deployment platform** (Wrangler secrets and Workers Builds variables) | Credentials and resource coordinates | Operator hostname, Access AUD and team domain, owner email, Turnstile keys, capability secret, WhatsApp and Shopify credentials, `ABLE_D1_DATABASE_ID`, `ABLE_R2_BUCKET_NAME`, `ABLE_MEDIA_QUEUE_NAME`, `ABLE_WORKER_NAME` |
| **Your private working context** (`AGENTS.local.md`, `.dev.vars` — both git-ignored) | Local context and local-only values | Who you are, which rails you run, your cutover state, house rules for your agents; local development values in `.dev.vars` |
| **The repository** | Nothing about you | — |

`npm run scan:public` enforces the last row on every `npm run check`: it rejects personal email addresses, concrete resource identifiers, secret-bearing file types, private keys, and any file matching `*.local.md`. Private release automation can add your own brand and domain names through the `ABLE_PRIVATE_DENYLIST` environment variable without teaching the repository those strings.

Because branding is runtime data, `git pull upstream main` never conflicts with your logo, your colors, or your email copy.

## Three levels of customization

Reach for the lowest level that solves the problem. Level 1 survives every upgrade untouched; level 3 is where merge pain lives.

**Level 1 — Configure. No code, no deploy.**
Brand and portal identity, the four customer notification templates, knowledge articles, case prefix and locale, support hours, which optional rails are on. Done through `/ops/settings` and the admin MCP tools (`able_portal_customize`, `able_email_customize`, `able_article_put`), all audited and validated. Custom CSS, remote fonts, and scripts are deliberately not accepted here — that guardrail is what makes agent-authored branding changes safe.

**Level 2 — Extend. Code in your fork, upstream-shaped.**
A new channel adapter, an extra MCP tool over existing module interfaces, a new deep module for your vertical (inventory, dispatch, billing). Follow [ADR 0001](adr/0001-agent-first-suite.md): business policy, lifecycle, audit, idempotency, and outbox behavior live inside the owning module; adapters only authenticate, translate transport, and render. A module that respects those seams rebases cleanly across upstream releases — and is worth contributing back.

**Level 3 — Change core behavior.** Editing Helpdesk lifecycle rules, the capability model, the revision contract, or the migration set. You now own a fork with real merge cost. If the change is generic, open an issue upstream first — the fix is usually cheaper as an upstream change than as a permanent local patch.

## Working with an agent

Able is built to be operated and deployed by agents, but some steps are irreducibly human. Give your agent [deployment.md](deployment.md) and let it drive; hold the following yourself.

An agent can: install and build, run `npm run check`, apply migrations, prepare and run deploys, generate configuration values, draft knowledge articles and email templates, and — once `/mcp` is live — run the whole Desk loop.

Only a human can: prove domain ownership, set Access policy and group membership, complete Email Service onboarding and verify a real inbox, create Turnstile widgets and Meta or Shopify apps, hold secrets, and make the final decision to enable public intake and point customers at the deployment.

If you use Claude Code, the committed `/deploy-able` skill walks the deployment in order and stops at each human gate. Record your deployment's standing context in `AGENTS.local.md` — copy [AGENTS.local.example.md](../AGENTS.local.example.md) to get started. That file is git-ignored by design: it is how your agent remembers your business between sessions without any of it reaching the repository.

## Taking upstream updates

```bash
git fetch upstream && git merge upstream/main
npm ci && npm run check
npm run deploy:production   # applies pending additive migrations, then deploys
```

Committed D1 migrations are additive or carry an explicit compatibility plan, so a merge does not rewrite your history. Read [CHANGELOG.md](../CHANGELOG.md) before upgrading; until 1.0.0, minor versions may contain breaking changes and each is called out there.

## Before you serve real customers

Work the validation list in [deployment.md](deployment.md) §7, and confirm at minimum: Access denies an unapproved browser; portal routes 404 on the operator hostname and operator routes 404 on the public one; a test request delivers a usable private link to a real inbox; a private link cannot read another case's attachment; `/ops` reports outbox failures truthfully. Read [privacy-and-backups.md](privacy-and-backups.md) and make sure your privacy notice covers Workers AI, Images, and any channel provider you enabled.

Questions belong in [Discussions](https://github.com/codeyogi911/able/discussions). When you report anything, strip your customers, hostnames, and identifiers — see [SUPPORT.md](../SUPPORT.md).
