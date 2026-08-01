export type MediaKind = 'image' | 'pdf' | 'video' | 'text' | 'binary'

export type DetectedMedia = {
  kind: MediaKind
  contentType: string
  inlineImage: boolean
}

export type MediaAnalysisInput = {
  filename: string
  contentType: string
  bytes: Uint8Array
}

export type MediaAnalysis = {
  markdown: string
  tokens: number | null
}

export type MediaAnalyzer = {
  processor: string
  version: string
  analyze(input: MediaAnalysisInput): Promise<MediaAnalysis>
}

export type ImagePreview = {
  bytes: Uint8Array
  contentType: 'image/webp'
}

export type ImagePreviewer = {
  processor: string
  version: string
  preview(bytes: Uint8Array): Promise<ImagePreview>
}

const WORKERS_AI_PROCESSOR = 'cloudflare-workers-ai-tomarkdown'
const WORKERS_AI_VERSION = '2026-07-08'

function matches(bytes: Uint8Array, expected: readonly number[], offset = 0): boolean {
  return expected.every((value, index) => bytes[offset + index] === value)
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end))
}

function normalizedDeclaredType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() || 'application/octet-stream'
}

function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.subarray(0, Math.min(bytes.length, 8_192)).includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024)))
    return true
  } catch {
    return false
  }
}

/**
 * Detect only formats whose signatures we can verify cheaply at the Worker
 * boundary. A customer-controlled Content-Type never turns unknown bytes into
 * inline model input.
 */
export function detectMedia(bytes: Uint8Array, declaredContentType: string): DetectedMedia {
  if (matches(bytes, [0xff, 0xd8, 0xff])) {
    return { kind: 'image', contentType: 'image/jpeg', inlineImage: true }
  }
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: 'image', contentType: 'image/png', inlineImage: true }
  }
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') {
    return { kind: 'image', contentType: 'image/gif', inlineImage: true }
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return { kind: 'image', contentType: 'image/webp', inlineImage: true }
  }
  if (ascii(bytes, 0, 5) === '%PDF-') {
    return { kind: 'pdf', contentType: 'application/pdf', inlineImage: false }
  }
  if (matches(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { kind: 'video', contentType: 'video/webm', inlineImage: false }
  }
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12)
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
      return { kind: 'image', contentType: 'image/heic', inlineImage: false }
    }
    return {
      kind: 'video',
      contentType: brand === 'qt  ' ? 'video/quicktime' : 'video/mp4',
      inlineImage: false,
    }
  }

  const declared = normalizedDeclaredType(declaredContentType)
  if (declared.startsWith('text/') && looksLikeText(bytes)) {
    return { kind: 'text', contentType: declared, inlineImage: false }
  }
  return { kind: 'binary', contentType: 'application/octet-stream', inlineImage: false }
}

export function createWorkersAiMediaAnalyzer(ai: Ai): MediaAnalyzer {
  return {
    processor: WORKERS_AI_PROCESSOR,
    version: WORKERS_AI_VERSION,
    async analyze(input) {
      const body = new Uint8Array(input.bytes.byteLength)
      body.set(input.bytes)
      const result = await ai.toMarkdown(
        {
          name: input.filename,
          blob: new Blob([body.buffer], { type: input.contentType }),
        },
        {
          conversionOptions: {
            image: { descriptionLanguage: 'en' },
            pdf: {
              metadata: false,
              images: { convert: true, maxConvertedImages: 12, descriptionLanguage: 'en' },
            },
          },
        },
      )
      if (result.format === 'error') throw new Error('Media conversion failed')
      return { markdown: result.data, tokens: result.tokens }
    },
  }
}

export function createCloudflareImagePreviewer(images: ImagesBinding): ImagePreviewer {
  return {
    processor: 'cloudflare-images-preview',
    version: '1280-webp-v1',
    async preview(bytes) {
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      const stream = new Response(copy.buffer).body
      if (!stream) throw new Error('Image preview input is unavailable')
      const transformed = await images
        .input(stream)
        .transform({ width: 1280, height: 1280, fit: 'scale-down' })
        .output({ format: 'image/webp', quality: 82, anim: false })
      const response = transformed.response()
      if (!response.ok) throw new Error('Image preview conversion failed')
      return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: 'image/webp' }
    },
  }
}

type PendingFile = {
  id: string
  storage_key: string
  filename: string
  content_type: string
  sha256: string
}

export type MediaProcessingResult = {
  processed: number
  ready: number
  originalOnly: number
  failed: number
}

function boundedMarkdown(value: string): string {
  return value.replaceAll('\u0000', '').slice(0, 100_000)
}

/**
 * Process immutable files outside customer and MCP request latency. Claims are
 * durable and stale processing leases are recoverable by the next run.
 */
export async function processPendingMediaIntelligence(
  db: D1Database,
  bucket: R2Bucket,
  analyzer: MediaAnalyzer | undefined,
  previewer: ImagePreviewer | undefined = undefined,
  limit = 4,
): Promise<MediaProcessingResult> {
  const rows = await db.prepare(
    `SELECT file.id, file.storage_key, file.filename, file.content_type, file.sha256
     FROM stored_files file
     LEFT JOIN file_intelligence intelligence ON intelligence.file_id = file.id
     WHERE intelligence.file_id IS NULL
        OR intelligence.status = 'pending'
        OR (intelligence.status = 'failed' AND intelligence.error_code = 'analysis_failed'
          AND intelligence.attempt_count < 3)
        OR (intelligence.status = 'processing' AND intelligence.updated_at < datetime('now', '-10 minutes'))
     ORDER BY file.created_at ASC, file.id ASC
     LIMIT ?`,
  ).bind(Math.max(1, Math.min(limit, 20))).all<PendingFile>()
  const result: MediaProcessingResult = { processed: 0, ready: 0, originalOnly: 0, failed: 0 }

  for (const file of rows.results) {
    const object = await bucket.get(file.storage_key)
    if (!object) {
      await db.prepare(
        `INSERT INTO file_intelligence
           (file_id, source_sha256, media_kind, detected_content_type, status,
            processor, processor_version, error_code, attempt_count)
         VALUES (?, ?, 'binary', 'application/octet-stream', 'failed',
                 'morrow-original-inspection', '1', 'object_missing', 1)
         ON CONFLICT(file_id) DO UPDATE SET status = 'failed', error_code = 'object_missing',
           attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP`,
      ).bind(file.id, file.sha256).run()
      result.processed += 1
      result.failed += 1
      continue
    }

    const bytes = new Uint8Array(await object.arrayBuffer())
    const detected = detectMedia(bytes, file.content_type)
    const usesAi = (detected.kind === 'image' || detected.kind === 'pdf') && analyzer
    const processor = usesAi ? analyzer.processor : detected.kind === 'text' ? 'morrow-utf8-extractor' : 'morrow-original-inspection'
    const version = usesAi ? analyzer.version : '1'
    await db.prepare(
      `INSERT INTO file_intelligence
         (file_id, source_sha256, media_kind, detected_content_type, status,
          processor, processor_version, attempt_count)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, 0)
       ON CONFLICT(file_id) DO NOTHING`,
    ).bind(file.id, file.sha256, detected.kind, detected.contentType, processor, version).run()
    const claim = await db.prepare(
      `UPDATE file_intelligence
       SET status = 'processing', source_sha256 = ?, media_kind = ?, detected_content_type = ?,
           processor = ?, processor_version = ?, error_code = NULL,
           attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP
       WHERE file_id = ? AND (status = 'pending'
          OR (status = 'failed' AND error_code = 'analysis_failed' AND attempt_count < 3)
          OR (status = 'processing' AND updated_at < datetime('now', '-10 minutes')))`,
    ).bind(file.sha256, detected.kind, detected.contentType, processor, version, file.id).run()
    if ((claim.meta.changes ?? 0) === 0) continue

    let previewStorageKey: string | null = null
    let previewContentType: string | null = null
    let previewSize: number | null = null
    try {
      let status: 'ready' | 'original_only' = 'original_only'
      let markdown: string | null = null
      let tokenCount: number | null = null
      let analysisBytes: Uint8Array = bytes
      let analysisContentType = detected.contentType
      let analysisFilename = file.filename
      if (detected.kind === 'image' && previewer) {
        const preview = await previewer.preview(bytes)
        previewStorageKey = `derived/${file.sha256}/${previewer.version}/${file.id}/preview.webp`
        await bucket.put(previewStorageKey, preview.bytes, {
          httpMetadata: { contentType: preview.contentType, contentDisposition: 'inline' },
          customMetadata: { sourceSha256: file.sha256, processor: previewer.processor, processorVersion: previewer.version },
        })
        previewContentType = preview.contentType
        previewSize = preview.bytes.byteLength
        analysisBytes = preview.bytes
        analysisContentType = preview.contentType
        analysisFilename = `${file.filename}.preview.webp`
      }
      if (detected.kind === 'text') {
        status = 'ready'
        markdown = boundedMarkdown(new TextDecoder().decode(bytes))
      } else if (usesAi) {
        const analysis = await analyzer.analyze({
          filename: analysisFilename,
          contentType: analysisContentType,
          bytes: analysisBytes,
        })
        status = 'ready'
        markdown = boundedMarkdown(analysis.markdown)
        tokenCount = analysis.tokens
      }
      await db.prepare(
        `UPDATE file_intelligence
         SET status = ?, analysis_markdown = ?, token_count = ?,
             preview_storage_key = ?, preview_content_type = ?, preview_size = ?, error_code = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE file_id = ? AND status = 'processing'`,
      ).bind(status, markdown, tokenCount, previewStorageKey, previewContentType, previewSize, file.id).run()
      result.processed += 1
      if (status === 'ready') result.ready += 1
      else result.originalOnly += 1
    } catch {
      try {
        await db.prepare(
          `UPDATE file_intelligence
           SET status = 'failed', analysis_markdown = NULL, token_count = NULL,
               preview_storage_key = ?, preview_content_type = ?, preview_size = ?,
               error_code = 'analysis_failed', updated_at = CURRENT_TIMESTAMP
           WHERE file_id = ? AND status = 'processing'`,
        ).bind(previewStorageKey, previewContentType, previewSize, file.id).run()
      } catch {
        // A failure record must never be blocked by optional derived evidence.
        await db.prepare(
          `UPDATE file_intelligence
           SET status = 'failed', analysis_markdown = NULL, token_count = NULL,
               preview_storage_key = NULL, preview_content_type = NULL, preview_size = NULL,
               error_code = 'analysis_failed', updated_at = CURRENT_TIMESTAMP
           WHERE file_id = ? AND status = 'processing'`,
        ).bind(file.id).run()
      }
      result.processed += 1
      result.failed += 1
    }
  }
  return result
}
