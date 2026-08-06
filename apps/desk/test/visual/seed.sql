PRAGMA foreign_keys = ON;

UPDATE workspace_settings
SET display_name = 'Able Desk',
    portal_title = 'How can we help?',
    support_email = 'help@example.test',
    outbound_sender = 'support@example.test',
    portal_base_url = 'http://127.0.0.1:8791',
    public_intake_enabled = 1,
    email_tested_at = '2026-07-14T08:30:00.000Z',
    setup_completed_at = '2026-07-14T08:35:00.000Z',
    accent_color = '#c87942',
    canvas_color = '#ffffff',
    ink_color = '#121212',
    font_family = 'system',
    updated_at = '2026-07-14T08:35:00.000Z'
WHERE id = 1;

INSERT INTO categories (id, slug, name, description, sort_order, created_at, updated_at)
VALUES
  ('technical', 'technical', 'Technical help', 'Troubleshooting and diagnostics.', 10, '2026-07-10T09:00:00.000Z', '2026-07-10T09:00:00.000Z'),
  ('billing', 'billing', 'Billing', 'Invoices, payments, and account questions.', 20, '2026-07-10T09:00:00.000Z', '2026-07-10T09:00:00.000Z')
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  description = excluded.description,
  active = 1,
  sort_order = excluded.sort_order,
  updated_at = excluded.updated_at;

INSERT INTO kb_sections (id, slug, name, description, sort_order, created_at, updated_at)
VALUES
  ('section-start', 'getting-started', 'Getting started', 'Clear first steps for common support questions.', 10, '2026-07-10T09:00:00.000Z', '2026-07-13T12:00:00.000Z'),
  ('section-diagnostics', 'diagnostics', 'Diagnostics', 'Safe checks that help the team isolate a problem.', 20, '2026-07-10T09:00:00.000Z', '2026-07-13T12:00:00.000Z')
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  description = excluded.description,
  sort_order = excluded.sort_order,
  updated_at = excluded.updated_at;

INSERT INTO kb_articles
  (id, section_id, slug, title, body_markdown, excerpt, published, revision, source_created_at, source_updated_at, created_at, updated_at)
VALUES
  (
    'article-diagnostic-bundle',
    'section-diagnostics',
    'collect-a-diagnostic-bundle',
    'Collect a useful diagnostic bundle',
    '## Before you begin\n\nRemove passwords, payment details, and private keys from every file you share.\n\n## Capture the useful detail\n\n1. Note the exact time the problem happened.\n2. Copy the complete error text.\n3. Export the application log for the same five-minute window.\n4. Record the version shown in **Settings → About**.\n\n> A short, focused log is safer and faster to review than a full system archive.\n\n## Attach the files\n\nUse PDF, plain text, or a screenshot. Keep each file under 10 MB and the complete request under 20 MB.',
    'Capture the smallest safe set of logs, timestamps, and version details for a faster diagnosis.',
    1,
    'rev-kb-20260713-a',
    '2026-07-10T09:00:00.000Z',
    '2026-07-13T12:00:00.000Z',
    '2026-07-10T09:00:00.000Z',
    '2026-07-13T12:00:00.000Z'
  ),
  (
    'article-private-link',
    'section-start',
    'keep-your-private-link-safe',
    'Keep your private request link safe',
    '## Your link is the key\n\nA private request link opens one support conversation without a password. Do not forward it or paste it into a public channel.\n\nIf the link is lost, use **Find a request** with the same email address and case reference. The recovery page never reveals whether a case exists.',
    'Understand how private case links work and how to replace one without exposing a conversation.',
    1,
    'rev-kb-20260712-b',
    '2026-07-10T09:00:00.000Z',
    '2026-07-12T16:20:00.000Z',
    '2026-07-10T09:00:00.000Z',
    '2026-07-12T16:20:00.000Z'
  ),
  (
    'article-email-replies',
    'section-start',
    'reply-without-breaking-the-thread',
    'Reply without breaking the thread',
    'Reply from the original email or return through the private link. Keep the case reference in the subject so every update stays in one conversation.',
    'Keep portal and email replies attached to the same support request.',
    1,
    'rev-kb-20260711-c',
    '2026-07-10T09:00:00.000Z',
    '2026-07-11T15:10:00.000Z',
    '2026-07-10T09:00:00.000Z',
    '2026-07-11T15:10:00.000Z'
  )
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

INSERT INTO operators (id, email, name, role, active, created_at, updated_at)
VALUES ('operator-visual-owner', 'owner@example.com', 'Romy Navarro', 'admin', 1, '2026-07-10T09:00:00.000Z', '2026-07-14T08:35:00.000Z')
ON CONFLICT(email) DO UPDATE SET
  name = excluded.name,
  role = excluded.role,
  active = excluded.active,
  updated_at = excluded.updated_at;

INSERT INTO customers (id, email, name, phone, created_at, updated_at)
VALUES ('customer-visual-inez', 'inez.calder@example.test', 'Inez Calder', '+1 312 847 1928', '2026-07-14T09:10:00.000Z', '2026-07-14T10:22:00.000Z')
ON CONFLICT(email) DO UPDATE SET
  name = excluded.name,
  phone = excluded.phone,
  updated_at = excluded.updated_at;

INSERT INTO cases
  (id, public_id, ref, subject, customer_id, status, priority, channel, category_id, assignee_id, revision, version,
   customer_capability_nonce, customer_capability_hash, opened_at, updated_at)
VALUES
  (204, 'case-visual-204', 'MD-204', 'Desktop app stops during report export', 'customer-visual-inez', 'waiting_on_customer', 'high', 'portal', 'technical', 'operator-visual-owner', 'rev-case-visual-3', 3,
   'nonce-visual-204', '544b1e61fd602045626d5978194eaed615c5918b1ac66d695b05129503a7b1b5', '2026-07-14T09:10:00.000Z', '2026-07-14T10:22:00.000Z')
ON CONFLICT(id) DO UPDATE SET
  subject = excluded.subject,
  customer_id = excluded.customer_id,
  status = excluded.status,
  priority = excluded.priority,
  channel = excluded.channel,
  category_id = excluded.category_id,
  assignee_id = excluded.assignee_id,
  revision = excluded.revision,
  version = excluded.version,
  customer_capability_nonce = excluded.customer_capability_nonce,
  customer_capability_hash = excluded.customer_capability_hash,
  opened_at = excluded.opened_at,
  updated_at = excluded.updated_at;

INSERT INTO messages
  (id, case_id, visibility, direction, channel, author_type, operator_id, customer_id, author_name, body_text, delivery_state, created_at)
VALUES
  ('message-visual-inbound', 204, 'public', 'inbound', 'portal', 'customer', NULL, 'customer-visual-inez', 'Inez Calder',
   'The desktop app reaches 73% during a monthly report export, then closes. I tried twice after restarting. The attached log covers the second attempt.', NULL, '2026-07-14T09:10:00.000Z'),
  ('message-visual-note', 204, 'internal', 'note', 'manual', 'operator', 'operator-visual-owner', NULL, 'Romy Navarro',
   'Reproduced only when the archive contains more than one encrypted source file.', NULL, '2026-07-14T09:48:00.000Z'),
  ('message-visual-outbound', 204, 'public', 'outbound', 'email', 'operator', 'operator-visual-owner', NULL, 'Romy Navarro',
   'Thanks for the focused log. Please retry with “Include source files” turned off and tell us whether the export completes. Your original data will not be changed.', 'accepted', '2026-07-14T10:22:00.000Z')
ON CONFLICT(id) DO UPDATE SET
  body_text = excluded.body_text,
  delivery_state = excluded.delivery_state,
  created_at = excluded.created_at;

INSERT INTO stored_files
  (id, storage_key, filename, content_type, size, sha256, source_created_at, created_at)
VALUES
  ('file-visual-log', 'visual/case-204/export-window.log', 'export-window.log', 'text/plain', 18432,
   '9b9f4f51fce44546ca1f6f0a613cbc165da9e1a068d5d5ea3784f4b8efbd3437', '2026-07-14T09:09:30.000Z', '2026-07-14T09:10:00.000Z')
ON CONFLICT(id) DO UPDATE SET
  filename = excluded.filename,
  content_type = excluded.content_type,
  size = excluded.size,
  sha256 = excluded.sha256;

INSERT INTO case_attachments
  (id, file_id, case_id, subject_type, subject_id, message_id, visibility, created_at)
VALUES
  ('attachment-visual-log', 'file-visual-log', 204, 'case', 'case-visual-204', 'message-visual-inbound', 'public', '2026-07-14T09:10:00.000Z')
ON CONFLICT(id) DO UPDATE SET
  file_id = excluded.file_id,
  case_id = excluded.case_id,
  message_id = excluded.message_id,
  visibility = excluded.visibility;
