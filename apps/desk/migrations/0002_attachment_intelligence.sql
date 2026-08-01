-- Cached, derived evidence for agent inspection. The immutable original stays
-- in R2 and stored_files remains the source of truth.
CREATE TABLE file_intelligence (
  file_id TEXT PRIMARY KEY REFERENCES stored_files(id) ON DELETE CASCADE,
  source_sha256 TEXT NOT NULL,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'pdf', 'video', 'text', 'binary')),
  detected_content_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'ready', 'original_only', 'failed')),
  analysis_markdown TEXT,
  processor TEXT NOT NULL,
  processor_version TEXT NOT NULL,
  token_count INTEGER CHECK (token_count IS NULL OR token_count >= 0),
  preview_storage_key TEXT UNIQUE,
  preview_content_type TEXT,
  preview_size INTEGER CHECK (preview_size IS NULL OR preview_size >= 0),
  error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX file_intelligence_status_idx ON file_intelligence(status, media_kind, updated_at);
