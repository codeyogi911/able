-- The default notification signature rendered "{{workspace_name}} Support",
-- which doubles the word for workspaces whose display name already ends in
-- "Support" (e.g. "Example Support" became "Example Support Support").
-- The workspace name alone is a correct signature for every display name.
UPDATE email_notification_templates SET
  body_text_template = REPLACE(body_text_template, '— {{workspace_name}} Support', '— {{workspace_name}}'),
  body_markdown_template = REPLACE(body_markdown_template, '— {{workspace_name}} Support', '— {{workspace_name}}'),
  updated_at = CURRENT_TIMESTAMP
WHERE body_text_template LIKE '%— {{workspace_name}} Support%'
   OR body_markdown_template LIKE '%— {{workspace_name}} Support%';
