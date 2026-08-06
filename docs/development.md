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

## Repository boundaries

- `apps/desk` is the first deployable product workspace.
- `packages` receives a module only after its public interface and independent tests are proven.
- Repository docs describe reusable product behavior and architecture.
- Protected deployment configuration owns hostnames, resource IDs, senders, secrets, tenant content, data handling procedures, and environment-specific runbooks.

Fork pull requests never receive deployment secrets. Production or proving deployments should use a manually approved environment, a pinned commit, least-authority credentials, and logs that do not expose customer input or bearer capabilities.

## Cutover from an earlier private codebase

Keep the earlier repository read-only until a clean clone of Able installs, passes all gates, produces a dry-run deploy artifact, and successfully serves the required proving-ground smoke tests. Port any remaining generic work as reviewed commits with neutral fixtures. Archive the predecessor only after the new public upstream is the verified development source.
