# Governance

Able Desk is a maintainer-led project.

## Roles

- **Maintainers** hold commit access, review and merge changes, cut releases,
  and hold final say on architecture and scope. The current maintainer list is
  the set of accounts with write access to this repository.
- **Contributors** are everyone who submits issues, discussions, or pull
  requests. Contributions are accepted under Apache-2.0 as described in
  [CONTRIBUTING.md](CONTRIBUTING.md).

## How decisions are made

Ordinary changes are decided in pull-request review. Architectural and scope
decisions are recorded as ADRs under [docs/adr/](docs/adr/) before or alongside
the change that implements them; the roadmap in [docs/roadmap.md](docs/roadmap.md)
records priority. When reviewers disagree, the maintainers decide; when
maintainers disagree, the longest-serving maintainer decides.

Two standing constraints outrank convenience, and pull requests that violate
them will be declined regardless of merit elsewhere:

1. **Tenant neutrality** — the repository never contains a deployer's identity,
   customers, hostnames, resource identifiers, or data. Enforced by
   `npm run scan:public` and full-history secret scanning in CI.
2. **Deep modules over plug-ins** — business behavior belongs inside its
   module behind a small agent interface (see ADR 0001); speculative
   frameworks and generic plug-in layers are out of scope.

## Becoming a maintainer

Sustained, high-quality contributions and reviews are the only path. An
existing maintainer proposes the promotion; existing maintainers decide.

## Releases

Maintainers cut releases from `main` following the process in
[CONTRIBUTING.md](CONTRIBUTING.md), with versions and notable changes recorded
in [CHANGELOG.md](CHANGELOG.md).
