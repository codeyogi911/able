# Morrow Desk business ontology v1

Version identifier: `morrow-business.v1`

This deliberately small ontology is the semantic contract for the first Desk + CRM tracer. It is implemented through typed module interfaces and relational projections; it is not a generic writable graph or a replacement for module invariants.

## Terms

- **Party:** a canonical person or organization identity owned by Directory.
- **Helpdesk customer:** a module-local customer snapshot participating in a support case.
- **Case:** a Helpdesk-owned support request and its lifecycle.
- **CRM relationship:** a CRM-owned lifecycle relationship between the business and one Party.
- **CRM activity:** an append-only record of an interaction or business observation.
- **CRM follow-up:** a revisioned commitment to perform a future action.
- **Operation closure:** a declared outcome contract and its sourced reconciliation observations.
- **Improvement proposal:** an inactive, versioned candidate change supported by retained evidence.

## Relations

- `represents`: an explicit source link from a module-local identity to a canonical Party.
- `concernsParty`: connects a CRM aggregate to the Party whose relationship it owns.
- `sourcedFrom`: connects derived context or an activity to its evidence coordinate.
- `closesOperation`: connects an authoritative outcome observation to its operation closure.
- `motivates`: connects retained evidence to an inactive improvement proposal.

Missing relationships remain unknown. Similar names, email addresses, phone numbers, or model confidence never imply identity equality. Canonical mutations remain commands in their owning module.
