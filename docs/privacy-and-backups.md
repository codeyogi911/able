# Privacy, retention, and backups

Able Desk stores customer identity, support conversations, CRM relationship records, attachments, operator actions, delivery evidence, outcome observations, and improvement metadata. The deployer—not the upstream project—controls and is responsible for that data.

## Minimum deployment policy

- Publish a privacy notice naming the operator, purposes, retention periods, processors, contact method, and applicable customer rights.
- Collect only the support information needed to resolve a case.
- Restrict Cloudflare Access to current operators and review it regularly.
- Keep the R2 bucket private. Never expose object URLs directly.
- Document Cloudflare Workers AI as an attachment processor when media intelligence is enabled. Image and PDF bytes are sent through the deployment's Workers AI binding to produce cached Markdown evidence; originals remain in the private R2 bucket.
- Treat raw migration exports as more sensitive than the live database because they may contain deleted or legacy fields.
- Do not place customer data in issue trackers, logs, fixtures, screenshots, or repository history.
- Keep canonical business state, retained receipts and audit, runtime telemetry, evaluation datasets, and improvement proposals under separate retention and access policies.
- Do not copy raw cases, messages, contacts, attachments, graph neighborhoods, or transcripts into an evaluation or product-global learning dataset merely because they motivated an improvement proposal.

## Backups

D1 and R2 need coordinated recovery evidence. On a schedule appropriate to the deployment:

1. export D1 to encrypted storage;
2. inventory R2 objects with size and SHA-256;
3. record Worker version and migration state;
4. encrypt, retain, and delete backups under the documented policy;
5. perform a restore rehearsal into unrelated preview resources.

A database export without attachment bytes is not a complete backup. An R2 copy without D1 metadata cannot prove authorization or ownership. Derived `file_intelligence` rows are reproducible caches, but retaining them preserves processor provenance and avoids unnecessary repeat inference after recovery.

## Erasure and legal holds

Audit evidence is immutable inside the application, but immutability does not override legal erasure requirements. Deployers should define how to anonymize customer fields while retaining minimum non-identifying operational evidence, and how a legal hold pauses normal deletion. This V1 does not automate those policies.
