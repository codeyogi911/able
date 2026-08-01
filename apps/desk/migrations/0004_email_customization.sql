CREATE TABLE email_notification_templates (
  notification TEXT PRIMARY KEY CHECK (notification IN (
    'case_received',
    'customer_update_received',
    'agent_reply',
    'case_recovery'
  )),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  subject_template TEXT NOT NULL CHECK (length(subject_template) BETWEEN 1 AND 300),
  body_text_template TEXT NOT NULL CHECK (length(body_text_template) BETWEEN 1 AND 50000),
  body_markdown_template TEXT NOT NULL CHECK (length(body_markdown_template) BETWEEN 1 AND 50000),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO email_notification_templates
  (notification, enabled, subject_template, body_text_template, body_markdown_template)
VALUES
  (
    'case_received',
    1,
    'We received [{{case_ref}}]: {{case_subject}}',
    'Hi {{customer_name}},

We received your request {{case_ref}}.

Open your private case: {{case_link}}

If the link is unavailable, request a fresh link: {{recovery_link}}

— {{workspace_name}} Support',
    'Hi {{customer_name}},

## We received your request

Reference: **{{case_ref}}**

[Open your private case]({{case_link}})

If the link is unavailable, [request a fresh link]({{recovery_link}}).

— {{workspace_name}} Support'
  ),
  (
    'customer_update_received',
    1,
    'Update received [{{case_ref}}]: {{case_subject}}',
    'Hi {{customer_name}},

We added your update to {{case_ref}}.

View your private case: {{case_link}}

Recover the link: {{recovery_link}}

— {{workspace_name}} Support',
    'Hi {{customer_name}},

## Your update was received

We added it to **{{case_ref}}**.

[View your private case]({{case_link}})

[Recover the link]({{recovery_link}})

— {{workspace_name}} Support'
  ),
  (
    'agent_reply',
    1,
    'Re: [{{case_ref}}] {{case_subject}}',
    'Hi {{customer_name}},

{{message_body}}

View your private case: {{case_link}}

Recover the link: {{recovery_link}}

— {{workspace_name}} Support',
    'Hi {{customer_name}},

{{message_body}}

[View your private case]({{case_link}})

[Recover the link]({{recovery_link}})

— {{workspace_name}} Support'
  ),
  (
    'case_recovery',
    1,
    'Private link for {{case_ref}}',
    'Hi {{customer_name}},

Open your private case: {{case_link}}

— {{workspace_name}} Support',
    'Hi {{customer_name}},

## Your fresh private link

[Open your private case]({{case_link}})

— {{workspace_name}} Support'
  );
