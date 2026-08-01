# Security policy

## Supported versions

Until the first stable release, only the latest commit on `main` receives security fixes.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include customer data in a report. Use GitHub's private vulnerability reporting for this repository. Include affected version, impact, reproduction steps, and any suggested mitigation. You should receive acknowledgement within five business days.

## Security model

- Cloudflare Access is the sole operator identity boundary. One domain-wide application protects the dedicated operator hostname carrying `/mcp` and `/ops`; the public portal uses another hostname. MCP has no bearer-token fallback.
- Customer capabilities are high entropy and stored only as hashes.
- R2 attachments are private and authorized through the owning case.
- Attachment MIME claims are not trusted for model-readable content. Verified signatures control inline images, and extracted descriptions remain labelled as untrusted customer evidence so embedded prompt text cannot expand agent authority.
- Case mutations require an opaque current revision and derived idempotency key.
- Audit and operation receipts are immutable.
- Email is delivered through a durable outbox with truthful provider states.
- Public writes require same-origin checks, rate limiting, and Turnstile in production.

Do not deploy with incomplete operator-hostname, Access, email, portal URL, or Turnstile configuration.
