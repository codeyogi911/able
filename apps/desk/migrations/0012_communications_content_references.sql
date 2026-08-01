-- Preserve a bounded, typed provider reference for media and other non-text
-- messages. Media bytes remain with the provider until a dedicated retrieval
-- adapter is installed.
ALTER TABLE communication_messages
ADD COLUMN content_json TEXT;
