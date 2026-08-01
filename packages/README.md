# Packages

Morrow is a monorepo, but this directory is intentionally empty in the first public release. The working Desk application remains one buildable workspace while its module boundaries are proven.

Reusable packages will be extracted only when they have a stable public interface, independent tests, and no transport-specific dependencies. The planned extraction order is platform primitives, directory, CRM, operations, communications, Desk, portal, and MCP adapters.

This avoids publishing decorative packages that merely mirror folders without owning real behavior.
