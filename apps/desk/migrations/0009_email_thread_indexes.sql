-- RFC Message-ID matching keeps normal email replies on their original case.
-- These indexes preserve lookup cost as the desk accumulates mail history.
CREATE INDEX messages_provider_message_id_idx
ON messages(provider_message_id)
WHERE provider_message_id IS NOT NULL;

CREATE INDEX outbox_rows_provider_message_id_idx
ON outbox_rows(provider_message_id)
WHERE provider_message_id IS NOT NULL;
