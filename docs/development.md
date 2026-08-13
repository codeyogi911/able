# Development workflow

Able's public repository is the canonical source for product work. A private hosted environment may prove real workflows, but it is a consumer of Able—not a separate product fork.

## Change flow

1. Describe the generic user outcome or invariant in a public issue. Strip tenant names, domains, identifiers, screenshots, payloads, and customer content.
2. Implement the change on a short-lived branch with neutral fixtures and coverage at the affected public seam.
3. Run `npm run check`; also run `npm run eval:voice` when voice prompts or MCP tool descriptions change.
4. Review and merge the generic change into `main`.
5. Deploy the exact commit through a protected proving environment. Keep resource coordinates and secrets in the deployment platform, not Git.
6. Record only sanitized product findings upstream. Delivery logs, customer evidence, and operational runbooks stay private.
7. Tag a release once the documented release bar is met.

An urgent hosted fix may be developed against the affected public commit, but it must still be generalized and merged upstream before it becomes the maintained solution. Do not let a proving environment accumulate a long-lived source fork.

## Production-like local assistant

Use the dedicated local workflow when testing the customer-facing assistant:

```sh
npm install
npx wrangler login
npm run dev:parity
```

Open `http://127.0.0.1:8787/`. The command builds the same browser assets and
Worker entry point used for deployment, applies every D1 migration, and adds
only reserved `example.test` workspace readiness data plus a neutral knowledge
fixture. Its state persists under the ignored
`apps/desk/.wrangler/local-parity` directory, so agent conversations and local
requests behave consistently across restarts. No production database export,
customer record, attachment, resource ID, or secret is required.

The command intentionally uses a hybrid Cloudflare development topology:

- Workers AI is remote and consumes the authenticated account's inference
  quota. It is the real model path used by the deployed Worker.
- D1, R2, queues, Durable Objects, Email Service, rate limits, and fixtures are
  local simulations. Email acceptance and edge security controls therefore
  need separate staging smoke tests.
- Durable Object state is newly local; it cannot mirror a deployed object's
  identity, location, connection state, or warm/cold timing. Do not copy its
  production storage into the local workspace.
- Turnstile and Cloudflare Access are bypassed only for the localhost surface.
  Test their real policies on an isolated staging hostname.
- Local data is neutral. Production knowledge articles, storefront content,
  and customer history are absent by design, so answers grounded in those
  sources differ until equivalent non-customer fixtures or a staging provider
  are configured.

For Shopify product-discovery parity, copy
`apps/desk/.dev.vars.parity.example` to the ignored `apps/desk/.dev.vars` and
set `SHOPIFY_SHOP_DOMAIN` to a dedicated development store. Add
`SHOPIFY_STOREFRONT_ACCESS_TOKEN` when that shop does not allow tokenless
Storefront API access. For order and customer-account testing, also supply the
corresponding least-authority development app values shown in the template.
Never reuse production credentials. Product answers then use the development
store's live published catalog; they will not match production unless the
staging catalog intentionally contains equivalent neutral products. Do not
copy `.dev.vars.example` for this workflow: that file documents deployment
setup and its placeholders intentionally fail closed.

Use plain `npm run dev` when you want to preserve and manage the default local
Wrangler state yourself. Unlike `dev:parity`, it does not seed the support
sender and accepted email-test values required for the assistant homepage, so
a fresh database may correctly fall back to the conventional portal.

## Repository boundaries

- `apps/desk` is the first deployable product workspace.
- `packages` receives a module only after its public interface and independent tests are proven.
- Repository docs describe reusable product behavior and architecture.
- Protected deployment configuration owns hostnames, resource IDs, senders, secrets, tenant content, data handling procedures, and environment-specific runbooks.

Fork pull requests never receive deployment secrets. Production or proving deployments should use a manually approved environment, a pinned commit, least-authority credentials, and logs that do not expose customer input or bearer capabilities.

## Cutover from an earlier private codebase

Keep the earlier repository read-only until a clean clone of Able installs, passes all gates, produces a dry-run deploy artifact, and successfully serves the required proving-ground smoke tests. Port any remaining generic work as reviewed commits with neutral fixtures. Archive the predecessor only after the new public upstream is the verified development source.
