PRAGMA foreign_keys = ON;

-- Local-only readiness data for the browser assistant. These reserved example
-- addresses cannot deliver email and contain no tenant or customer data.
UPDATE workspace_settings
SET display_name = CASE
      WHEN trim(display_name) = '' THEN 'Able Desk'
      ELSE display_name
    END,
    portal_title = 'How can we help?',
    support_email = 'support@example.test',
    outbound_sender = 'support@example.test',
    portal_base_url = 'http://127.0.0.1:8787',
    public_intake_enabled = 1,
    email_tested_at = '2026-01-01T00:00:00.000Z',
    setup_completed_at = '2026-01-01T00:00:00.000Z',
    updated_at = CURRENT_TIMESTAMP
WHERE id = 1;

INSERT INTO kb_sections
  (id, slug, name, description, sort_order, created_at, updated_at)
VALUES
  ('local-parity-getting-started', 'getting-started', 'Getting started',
   'Neutral local fixtures for exercising grounded assistant answers.', 10,
   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  description = excluded.description,
  sort_order = excluded.sort_order,
  updated_at = excluded.updated_at;

INSERT INTO kb_articles
  (id, section_id, slug, title, body_markdown, excerpt, published, revision,
   source_created_at, source_updated_at, created_at, updated_at)
VALUES
  ('local-parity-private-links', 'local-parity-getting-started',
   'keep-your-private-request-link-safe', 'Keep your private request link safe',
   'A private request link opens one support conversation. Do not forward it or paste it into a public channel. If it is lost, use **Find a request** with the same email address and case reference.',
   'How to handle the private link for a support request.', 1,
   'local-parity-rev-1', '2026-01-01T00:00:00.000Z',
   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
   '2026-01-01T00:00:00.000Z')
ON CONFLICT(id) DO UPDATE SET
  section_id = excluded.section_id,
  slug = excluded.slug,
  title = excluded.title,
  body_markdown = excluded.body_markdown,
  excerpt = excluded.excerpt,
  published = excluded.published,
  revision = excluded.revision,
  source_updated_at = excluded.source_updated_at,
  updated_at = excluded.updated_at;
