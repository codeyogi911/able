# Deployment guide

This guide provisions one single-tenant Able Desk deployment. Use a separate Cloudflare account or fresh preview resources for the first clean-clone release test.

## 1. Provision the application

Authenticate Wrangler, install dependencies, and deploy:

```sh
npm ci
npm run check
npm run deploy
npm run db:migrate:remote
```

The committed Wrangler configuration omits database IDs, bucket names, hostnames, senders, and Access metadata. Wrangler can provision missing D1 and R2 resources and binds Workers AI plus Images for attachment evidence. Confirm those services are enabled for the deployment account and covered by the privacy notice. Record generated resource names in private deployment operations, not in source.

At this point the Worker is provisioned, but the support desk is intentionally not operational.

The browser support assistant is published as the public homepage at `/` when `ABLE_VOICE_DEMO_ENABLED` is `1`; `/voice` and `/demo/voice` redirect there. It requires the production Email Service, Turnstile, rate-limit, D1, R2, Workers AI, and `CUSTOMER_CAPABILITY_SECRET` bindings. A session-level Turnstile proof enables anonymous text or voice help. The assistant collects a rate-limited name and email in-thread only before an identity-bearing order, ticket, or human-review action. Those details are unverified contact information used to name tickets, scope order lookup, and deliver follow-up. If the assistant is disabled or its required production setup is incomplete, `/` fails safely back to the conventional portal.

For an already-provisioned production Worker, use `npm run deploy:production`. It refuses a non-`main` Cloudflare Builds branch, applies pending additive D1 migrations, rebuilds the embedded MCP App, and then deploys the Worker.

### Cloudflare Workers Builds

Connect this repository under **Worker > Settings > Build** and keep a single production trigger:

- production branch: `main`;
- build command: `npm run check`;
- deploy command: `npm run deploy:production`;
- root directory: `/`;
- branch includes: `main`;
- branch excludes: empty;
- path includes: `*`;
- non-production or preview builds: disabled.

Cloudflare stores this Git trigger outside `wrangler.jsonc`; the committed production command adds a second branch guard, but the trigger itself must still exclude non-production branches. The build token needs permission to apply the declared D1 migrations and deploy the Worker.

Keep deployment-specific resource coordinates in private Workers Builds variables rather than the reusable Wrangler source:

- `ABLE_D1_DATABASE_ID`: the production D1 database UUID;
- `ABLE_D1_DATABASE_NAME`: the production D1 database name;
- `ABLE_R2_BUCKET_NAME`: the production attachment bucket;
- `ABLE_MEDIA_QUEUE_NAME`: the production attachment-analysis queue.

`npm run deploy:production` validates these values and creates an ignored, ephemeral Wrangler file for the build. It never writes the production coordinates into the public repository.

## 2. Configure secrets

Bind two distinct custom domains to the same Worker: one public portal hostname and one operator hostname. Create one Cloudflare Access self-hosted application covering the entire operator hostname, not path-scoped applications. That protected hostname carries both `/mcp` and `/ops`; the public portal hostname remains outside Access. Enable Managed OAuth for MCP clients, following Cloudflare's [Managed OAuth guidance](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/), and restrict the application to the intended operator group.

Set secrets without placing values in shell history when possible:

```sh
npx wrangler secret put ABLE_OPERATOR_HOSTNAME
npx wrangler secret put CF_ACCESS_AUD
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put ABLE_OWNER_EMAIL
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put TURNSTILE_SITE_KEY
npx wrangler secret put CUSTOMER_CAPABILITY_SECRET
npx wrangler secret put WHATSAPP_VERIFY_TOKEN
npx wrangler secret put WHATSAPP_APP_SECRET
npx wrangler secret put WHATSAPP_ACCESS_TOKEN
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put WHATSAPP_WABA_ID
```

`ABLE_OPERATOR_HOSTNAME` is a bare hostname with no scheme, port, path, or wildcard. The first verified identity matching `ABLE_OWNER_EMAIL` becomes an administrator. Other Access-approved identities are provisioned as agents and can later be promoted by an administrator. In production, `/mcp` and `/ops` return a configuration error until the operator hostname is valid, and are unavailable on every other hostname. Portal routes return 404 on the operator hostname. Localhost keeps the direct development workflow.

The committed observability configuration disables automatic invocation logs. Keep it disabled unless your private logging policy explicitly redacts request headers and cookies; customer sessions carry a bearer capability in a secure transport cookie.

## 3. Configure hostnames and workspace settings

Bind the public portal hostname and dedicated operator hostname to the same Worker. Configure the workspace through `/ops/settings` on the operator hostname:

- display name and portal title;
- brand icon or logo, favicon, and home URL;
- portal base URL;
- support and outbound sender addresses;
- case prefix, locale, and timezone;
- one accent, neutral canvas, ink, and the fixed font family.

An administrator can inspect or patch the same brand subset through `able_portal_customize`. The tool and `/ops/settings` share validation and immutable audit evidence. V1 does not accept custom CSS, remote font code, or scripts; this keeps agent-authored portal changes inside contrast-checked, URL-validated guardrails.

The admin-only `able_email_customize` tool controls the four customer notification types: case received, customer update received, agent reply, and case recovery. Each has its own enable switch, subject, plain-text fallback, and sanitized rich Markdown body. Call the tool with no arguments to inspect the supported placeholders before changing a template.

Do not add customer domains or resource IDs to `wrangler.jsonc`.

## 4. Onboard email

Cloudflare Email Service must be able to send to arbitrary customer recipients. That currently requires Workers Paid; 3,000 outbound messages per account per month are included before usage pricing, while inbound Email Routing is unlimited. Confirm the current [official pricing](https://developers.cloudflare.com/email-service/platform/pricing/) and sender-domain requirements, configure inbound routing to the Worker, and send the setup test from `/ops/settings`.

Provider acceptance records the setup test as accepted. It does not prove inbox delivery; manually inspect the receiving mailbox, sender authentication, and reply routing. Public intake cannot be enabled until the setup test has been accepted.

## 5. Configure Turnstile and edge controls

Create a Turnstile widget for the portal hostname and expose only its site key through private workspace/deployment configuration. Keep the secret in Wrangler. The Worker also applies a rate-limit binding; production deployments should add appropriate WAF rules and bot controls for their risk profile.

## 6. Connect WhatsApp Cloud API

Use the Meta app owned by this single-tenant deployment. In **WhatsApp > Configuration**, set the callback URL to the public portal origin plus `/webhooks/whatsapp`, enter the same private value stored in `WHATSAPP_VERIFY_TOKEN`, verify the callback, and subscribe the app to the WABA's `messages` webhook field.

For the generated test number, the dashboard token is sufficient only for a short engineering smoke test. Before a new real-number pilot, create a least-authority system user with `whatsapp_business_messaging` access, store its token in `WHATSAPP_ACCESS_TOKEN`, and confirm that `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_WABA_ID` match the selected Meta assets. Never commit any of these values.

The current transport slice accepts signed inbound text, deduplicates Meta retries, and keeps later sender messages on one Communications conversation. It does not invent a Desk case or CRM lead. An authenticated agent explicitly routes the conversation to support, sales, both, or leaves it unclassified, and sends human-approved replies through the conversation using Graph API v25.0. Free-form outbound is rechecked against the rolling 24-hour customer-service window when the durable outbox executes. Provider acceptance is recorded as `accepted`, not as delivered or read proof.

Do not expose a new number to customers yet if you need media ingestion, template sends outside the service window, or `sent`/`delivered`/`read` status projection. Those are explicit pilot gates still to be implemented. Keep the established support number unchanged until the new-number pilot has its own cutover decision.

## 7. Validate

- Access denies an unapproved browser and permits an approved operator across the full operator hostname.
- Public portal routes return 404 on the operator hostname, while `/mcp` and `/ops` return 404 on the public hostname.
- MCP completes `able_case_next` then `able_case_reply` with an exact revision.
- A photo attachment reaches `ready`, `able_attachment_inspect` returns bounded evidence, and `detail: "visual"` supplies a normalized WebP preview rather than the original.
- A test request emails a usable private link.
- The private link can view and reply but cannot read another case's attachment.
- `/ops` shows outbox failure and indeterminate states truthfully.
- A signed WhatsApp text creates one unclassified conversation and no case or lead; replaying the same Meta message ID creates nothing new.
- MCP can route that conversation to one Desk case, one CRM sales lead, or both without collapsing the work items.
- `able_conversation_reply` inside the customer-service window reaches the verified recipient and retains the returned Meta message ID.
- An agent reply outside the customer-service window is blocked before Meta is called.
- A 360 px browser has no horizontal overflow and all form controls remain usable.

Deployment buttons may automate step 1 and request secrets. They cannot safely automate custom-domain ownership, Email Service onboarding, Access policy, sender validation, or the final enablement decision.

## 8. Run the deployment-specific publication scan

The repository scanner rejects personal email addresses, concrete Wrangler resource identifiers, secret-bearing files, and common private-key material without carrying any customer's identity in source. Before publication, add every private brand, domain, sender, and legacy product name to a protected CI variable with one value per line, then run:

```sh
ABLE_PRIVATE_DENYLIST="$PRIVATE_RELEASE_DENYLIST" npm run scan:public
```

Keep the denylist in private release configuration. Do not commit it, encode it into a test fixture, or print it in CI logs.
