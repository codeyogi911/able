# Changelog

All notable changes to Able are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A public catalog-only UCP agent profile and Shopify Storefront Catalog MCP integration for bounded, live product search and detail.
- Adopter guide at `docs/adopt.md`: prerequisites, fork-and-track-upstream setup, the tenant boundary, three customization levels, the human-only deployment gates, and the upgrade path.
- `AGENTS.local.example.md`, a template for the git-ignored `AGENTS.local.md` where a deployer's own standing context lives. `npm run scan:public` now rejects any published `*.local.md` and requires both new documents.
- Committed `/deploy-able` agent skill that drives `docs/deployment.md` in order and stops at every step only a human can complete.

### Changed

- `AGENTS.md` distinguishes upstream work from deployment work, points agents at `AGENTS.local.md` for private context, and states the customization-level preference.
- `.gitignore` narrows the blanket `.claude/` rule to local session state so committed agent assets ship to adopters.

## [0.1.0] - 2026-08-01

### Added

- Initial public Able source tree with Able Desk as the first buildable workspace.
- Agent-native Desk, Communications, Directory, CRM, Operations, and controlled-improvement modules behind task-shaped MCP tools.
- Accessible support portal, knowledge search, browser assistant, email delivery, signed WhatsApp text ingress, private attachments, and a small recovery console.
- Cloudflare Workers deployment configuration for D1, R2, Workers AI, Email Service, Access, Turnstile, queues, and Durable Objects.
- Neutral test fixtures, visual regression coverage, public-readiness scanning, full-history scanning, CodeQL, and pinned secret scanning.
- Apache-2.0 license, governance, security policy, contribution guide, architecture decisions, and public roadmap.

[Unreleased]: https://github.com/codeyogi911/able/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/codeyogi911/able/releases/tag/v0.1.0
