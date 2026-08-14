# Private deployment context (example)

Copy this file to `AGENTS.local.md` and fill it in. `AGENTS.local.md` is git-ignored and rejected by `npm run scan:public`; it is the one place in your working copy where your business may be named.

It is **context, not credentials.** Record what your agent needs to reason about your deployment. Never put a secret, token, capability, customer record, or raw export here — those belong in Wrangler secrets, Workers Builds variables, and `.dev.vars`.

Delete the guidance lines and keep it short. A page an agent reads at the start of every session beats a runbook nobody maintains.

---

## Deployment

- **Business:** <name customers see>
- **Public portal hostname:** <help.example.com>
- **Operator hostname:** <desk.example.com>
- **Cloudflare account / Worker:** <which account; Worker name if it differs from the committed default>
- **Where resource coordinates live:** <e.g. Workers Builds variables on the production trigger — name the location, not the values>
- **Deployment trigger:** <Workers Builds on `main` / manual `npm run deploy:production` from a workstation>

## Rails enabled

- **Email:** <sender address, inbound routing status, setup test accepted?>
- **Public intake:** <enabled / still gated>
- **WhatsApp:** <off / pilot on test number / live number>
- **Shopify order lookup:** <off / read-only / customer-account sign-in also on>
- **Voice assistance:** <off / on>

## Where we are

- **Current goal:** <what this deployment is trying to reach next>
- **Cutover state:** <what still runs on the system Able is replacing, and what has moved>
- **Known gaps:** <capabilities customers need that Able does not have yet — these are your real blockers>
- **Open decisions:** <things waiting on a human>

## House rules for agents in this working copy

- Tenant facts stay here, in the deployment platform, or in the running workspace settings — never in tracked files, tests, fixtures, issues, or commit messages.
- Prefer level 1 (workspace settings) over level 2 (code) for anything customer-visible. See [docs/adopt.md](docs/adopt.md).
- When a problem here is generic, fix it upstream with a neutral test rather than patching locally.
- Run `npm run check` before any deploy; it includes the public-readiness scan.
- <add your own: change windows, who approves a deploy, what must never be touched>
