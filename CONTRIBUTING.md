# Contributing

Able Desk welcomes focused changes that preserve its deep-module architecture and generic public repository.

This repository is the canonical source for product development. Private proving deployments must consume an exact commit or release rather than carry a long-lived source fork. Bring discoveries back as generic issues, neutral fixtures, and upstream changes; never copy tenant data or operational evidence into a report or test.

1. Open an issue for behavior or architecture changes.
2. Create a branch and add a test at a public seam.
3. Run `npm run check`.
4. Confirm no customer name, domain, production resource ID, personal email, secret, raw export, database, or attachment is present.
5. Submit a small pull request explaining the invariant or user outcome changed.

See [docs/development.md](docs/development.md) for the branch, review, and proving-ground workflow.

Adapters may parse transport and render results, but case SQL, lifecycle policy, capability logic, auditing, idempotency, and outbox creation belong inside the Helpdesk module. New business modules should follow [ADR 0001](docs/adr/0001-agent-first-suite.md); do not introduce a generic plug-in framework speculatively.

## Dependencies and standards

- Prefer an official or mature, maintained package for standard protocols, formats, security primitives, and platform integrations. Do not hand-roll a standard when a compatible package exists.
- Use the latest stable version compatible with Able Desk's supported runtime. Keep runtime, types, and CI versions aligned; prereleases require a documented reason.
- Check the package registry and upstream release notes before adding or updating a dependency. Major updates require focused compatibility tests plus `npm run check`.
- Keep Able Desk business behavior in its own modules, while packages own wire parsing, schema validation, content negotiation, and transport compliance.
- Run `npm outdated` during dependency maintenance and resolve compatible direct-dependency drift promptly.

## Releases

Able follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html); until 1.0.0, minor versions may contain breaking changes and each is called out in [CHANGELOG.md](CHANGELOG.md). To cut a release: update the root and affected workspace versions, move the relevant `Unreleased` entries under a dated version heading in the changelog, run `npm run check`, commit, tag `vX.Y.Z`, and publish a GitHub release whose notes mirror the changelog entry. Changes touching the voice prompt or tool descriptions additionally require a passing `npm run eval:voice` before the release, per the pin policy in [docs/voice-demo.md](docs/voice-demo.md).

By submitting a contribution, you agree it is licensed under Apache-2.0.
