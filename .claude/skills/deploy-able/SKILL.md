---
name: deploy-able
description: Drive an Able Desk deployment onto the user's own Cloudflare account, in order, stopping at every step only a human can complete. Use when the user wants to deploy Able, set it up for their business, stand up a support desk, resume a half-finished deployment, or check what is left before real customers can be served.
---

# Deploy Able for a business

You are standing up **one single-tenant Able Desk deployment** in the user's Cloudflare account, on their domains, holding their data. There is no hosted Able service to sign into.

[docs/deployment.md](../../../docs/deployment.md) is the authoritative runbook — read it before acting, and follow its steps in order. This skill is the driver: it tells you how to sequence the work, what you may do unattended, and where to stop.

## Before you start

1. Read `AGENTS.local.md` if it exists. It is the deployment's standing context — hostnames, which rails are on, where the deployment left off. If it does not exist, copy `AGENTS.local.example.md` to `AGENTS.local.md` and fill it in with the user as you go. Never commit it.
2. Read `docs/adopt.md` for the tenant boundary. Nothing about this business goes into a tracked file.
3. Establish where the deployment already is. A resumed deployment is the normal case — check what exists before creating anything: `npx wrangler whoami`, `npx wrangler d1 list`, `npx wrangler r2 bucket list`, `npx wrangler secret list`, and whether the Worker already serves `/healthz`.

## Sequence

Work `docs/deployment.md` §1 → §8 in order. Do not skip ahead: later steps fail confusingly when an earlier gate is incomplete, and several steps are irreversible in practice once customers are pointed at them.

Announce which step you are on, what you are about to run, and what the user must do themselves. After each step, verify rather than assume — the runbook's §7 list is the acceptance criteria, not a formality.

## You may do these unattended

- `npm ci`, `npm run check`, `npm run build:assets`.
- Read-only Wrangler and Cloudflare inspection to establish current state.
- Apply committed D1 migrations (`npm run db:migrate:local`; `npm run db:migrate:remote` once the user confirms the target).
- Generate values that should be random — for example a `CUSTOMER_CAPABILITY_SECRET` of at least 32 characters — and hand them to the user to set. Do not put a generated secret into a file, a commit, or your visible output beyond what the user needs to paste.
- Draft workspace settings, knowledge articles, and email templates for the user's review.
- Run the §7 validation checks and report results truthfully, including failures.

## Stop and hand to the user

These are not automatable, and attempting them produces a half-configured deployment that looks finished:

- Proving domain ownership and binding the two custom hostnames.
- Creating the Cloudflare Access application, its policy, and its group membership; enabling Managed OAuth for MCP clients.
- Setting secrets. Ask the user to run each `npx wrangler secret put …` themselves. Never accept a secret value into the conversation, a file, or a command line.
- Email Service onboarding, sender authentication, and confirming a real message landed in a real inbox. Provider acceptance is not delivery.
- Creating the Turnstile widget, the Meta app and WABA, or any Shopify client.
- **Enabling public intake and pointing real customers at the deployment.** This is the user's decision, made after §7 passes — never yours.

## Report honestly

A provisioned Worker is not an operational support desk. When you finish a session, state plainly which steps are complete, which are gated on the user, and which §7 checks have actually been run versus assumed. If a check failed, say so with its output. Update `AGENTS.local.md` with the new state so the next session resumes instead of restarting.
