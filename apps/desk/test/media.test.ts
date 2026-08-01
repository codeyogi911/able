import { env } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import {
  detectMedia,
  processPendingMediaIntelligence,
  type MediaAnalyzer,
  type ImagePreviewer,
} from '../src/platform/media'

describe('attachment media intelligence', () => {
  it('uses verified signatures instead of customer-controlled MIME declarations', () => {
    expect(detectMedia(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), 'application/octet-stream')).toEqual({
      kind: 'image',
      contentType: 'image/jpeg',
      inlineImage: true,
    })
    expect(detectMedia(new TextEncoder().encode('<svg><script>unsafe()</script></svg>'), 'image/svg+xml')).toEqual({
      kind: 'binary',
      contentType: 'application/octet-stream',
      inlineImage: false,
    })
    expect(detectMedia(new TextEncoder().encode('%PDF-1.7'), 'image/png')).toEqual({
      kind: 'pdf',
      contentType: 'application/pdf',
      inlineImage: false,
    })
    expect(detectMedia(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]), 'text/plain')).toEqual({
      kind: 'video',
      contentType: 'video/mp4',
      inlineImage: false,
    })
    expect(detectMedia(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]), 'application/octet-stream')).toEqual({
      kind: 'image',
      contentType: 'image/heic',
      inlineImage: false,
    })
  })

  it('processes and caches image evidence exactly once', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
    await env.ATTACHMENTS.put('media/leak.png', bytes)
    await env.DB.prepare(
      `INSERT INTO stored_files (id, storage_key, filename, content_type, size, sha256)
       VALUES ('file_image', 'media/leak.png', 'leak.png', 'application/octet-stream', ?, 'image-sha')`,
    ).bind(bytes.byteLength).run()
    const analyze = vi.fn(async () => ({ markdown: 'Water is visible below the group head.', tokens: 9 }))
    const analyzer: MediaAnalyzer = { processor: 'fake-vision', version: '2026-07', analyze }
    const preview = vi.fn(async () => ({ bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]), contentType: 'image/webp' as const }))
    const previewer: ImagePreviewer = { processor: 'fake-images', version: 'preview-v1', preview }

    await expect(processPendingMediaIntelligence(env.DB, env.ATTACHMENTS, analyzer, previewer)).resolves.toEqual({
      processed: 1,
      ready: 1,
      originalOnly: 0,
      failed: 0,
    })
    await expect(processPendingMediaIntelligence(env.DB, env.ATTACHMENTS, analyzer, previewer)).resolves.toEqual({
      processed: 0,
      ready: 0,
      originalOnly: 0,
      failed: 0,
    })
    expect(analyze).toHaveBeenCalledOnce()
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({
      filename: 'leak.png.preview.webp',
      contentType: 'image/webp',
      bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
    }))
    expect(preview).toHaveBeenCalledOnce()
    const derived = await env.ATTACHMENTS.get('derived/image-sha/preview-v1/file_image/preview.webp')
    expect(derived?.httpMetadata?.contentType).toBe('image/webp')
    expect(new Uint8Array(await derived!.arrayBuffer())).toEqual(new Uint8Array([0x52, 0x49, 0x46, 0x46]))
    await expect(env.DB.prepare(
      `SELECT media_kind, detected_content_type, status, analysis_markdown,
              processor, processor_version, token_count, preview_storage_key,
              preview_content_type, preview_size, attempt_count, error_code
       FROM file_intelligence WHERE file_id = 'file_image'`,
    ).first()).resolves.toEqual({
      media_kind: 'image',
      detected_content_type: 'image/png',
      status: 'ready',
      analysis_markdown: 'Water is visible below the group head.',
      processor: 'fake-vision',
      processor_version: '2026-07',
      token_count: 9,
      preview_storage_key: 'derived/image-sha/preview-v1/file_image/preview.webp',
      preview_content_type: 'image/webp',
      preview_size: 4,
      attempt_count: 1,
      error_code: null,
    })
  })

  it('processes duplicate image bytes without colliding preview records', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02])
    await env.ATTACHMENTS.put('media/first.png', bytes)
    await env.ATTACHMENTS.put('media/second.png', bytes)
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO stored_files (id, storage_key, filename, content_type, size, sha256)
         VALUES ('file_duplicate_a', 'media/first.png', 'first.png', 'image/png', ?, 'duplicate-sha')`,
      ).bind(bytes.byteLength),
      env.DB.prepare(
        `INSERT INTO stored_files (id, storage_key, filename, content_type, size, sha256)
         VALUES ('file_duplicate_b', 'media/second.png', 'second.png', 'image/png', ?, 'duplicate-sha')`,
      ).bind(bytes.byteLength),
    ])
    const analyzer: MediaAnalyzer = {
      processor: 'fake-vision',
      version: '2026-07',
      analyze: vi.fn(async () => ({ markdown: 'The image contains a equipment router.', tokens: 8 })),
    }
    const previewer: ImagePreviewer = {
      processor: 'fake-images',
      version: 'preview-v1',
      preview: vi.fn(async () => ({ bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]), contentType: 'image/webp' as const })),
    }

    await expect(processPendingMediaIntelligence(env.DB, env.ATTACHMENTS, analyzer, previewer, 20)).resolves.toEqual({
      processed: 2,
      ready: 2,
      originalOnly: 0,
      failed: 0,
    })
    const rows = await env.DB.prepare(
      `SELECT file_id, status, preview_storage_key, error_code
       FROM file_intelligence ORDER BY file_id`,
    ).all()
    expect(rows.results).toEqual([
      {
        file_id: 'file_duplicate_a',
        status: 'ready',
        preview_storage_key: 'derived/duplicate-sha/preview-v1/file_duplicate_a/preview.webp',
        error_code: null,
      },
      {
        file_id: 'file_duplicate_b',
        status: 'ready',
        preview_storage_key: 'derived/duplicate-sha/preview-v1/file_duplicate_b/preview.webp',
        error_code: null,
      },
    ])
  })

  it('extracts UTF-8 deterministically and leaves video as original-only evidence', async () => {
    const text = new TextEncoder().encode('Customer diagnostic log')
    const video = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
    await env.ATTACHMENTS.put('media/log.txt', text)
    await env.ATTACHMENTS.put('media/clip.mp4', video)
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO stored_files (id, storage_key, filename, content_type, size, sha256)
         VALUES ('file_text', 'media/log.txt', 'log.txt', 'text/plain', ?, 'text-sha')`,
      ).bind(text.byteLength),
      env.DB.prepare(
        `INSERT INTO stored_files (id, storage_key, filename, content_type, size, sha256)
         VALUES ('file_video', 'media/clip.mp4', 'clip.mp4', 'video/mp4', ?, 'video-sha')`,
      ).bind(video.byteLength),
    ])

    await expect(processPendingMediaIntelligence(env.DB, env.ATTACHMENTS, undefined)).resolves.toEqual({
      processed: 2,
      ready: 1,
      originalOnly: 1,
      failed: 0,
    })
    const rows = await env.DB.prepare(
      'SELECT file_id, media_kind, status, analysis_markdown FROM file_intelligence ORDER BY file_id',
    ).all()
    expect(rows.results).toEqual([
      { file_id: 'file_text', media_kind: 'text', status: 'ready', analysis_markdown: 'Customer diagnostic log' },
      { file_id: 'file_video', media_kind: 'video', status: 'original_only', analysis_markdown: null },
    ])
  })
})
