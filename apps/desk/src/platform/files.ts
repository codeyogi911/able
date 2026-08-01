import type { IntakeRequest } from '../domain/types'

export type StagedAttachment = NonNullable<IntakeRequest['attachments']>[number]

export type PortalUploadBatch = {
  attachments: StagedAttachment[]
  /** R2 keys created by this attempt. Existing deterministic objects are omitted. */
  createdStorageKeys: string[]
}

const SAFE_INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'])

function safeFilename(value: string, index: number): string {
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f/\\]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || `attachment-${index + 1}`
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function sha256(value: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', value as BufferSource)))
}

/**
 * Stage portal uploads under keys derived from the public form request ID and
 * file content. A browser retry therefore describes the exact same intake
 * command and reuses the same R2 objects instead of creating orphans.
 */
export async function storePortalFiles(
  bucket: R2Bucket,
  files: File[],
  requestId: string,
): Promise<PortalUploadBatch> {
  const stored: StagedAttachment[] = []
  const createdStorageKeys: string[] = []
  const requestDigest = await sha256(new TextEncoder().encode(`morrow:portal-upload:v1:${requestId}`))
  try {
    for (const [index, file] of files.entries()) {
      const content = new Uint8Array(await file.arrayBuffer())
      const digest = await sha256(content)
      const attachmentDigest = await sha256(new TextEncoder().encode(`${requestDigest}:${index}:${digest}`))
      const id = `att_${attachmentDigest.slice(0, 40)}`
      const filename = safeFilename(file.name, index)
      const contentType = SAFE_INLINE_TYPES.has(file.type) ? file.type : 'application/octet-stream'
      const storageKey = `portal/staged/${requestDigest.slice(0, 32)}/${index}-${digest}`
      const existing = await bucket.head(storageKey)
      if (!existing || existing.size !== content.byteLength || existing.customMetadata?.sha256 !== digest) {
        await bucket.put(storageKey, content, {
          httpMetadata: {
            contentType,
            contentDisposition: `attachment; filename="${filename.replaceAll('"', '')}"`,
          },
          customMetadata: { sha256: digest },
        })
        if (!existing) createdStorageKeys.push(storageKey)
      }
      stored.push({ id, filename, contentType, size: content.byteLength, storageKey, sha256: digest })
    }
  } catch (error) {
    if (createdStorageKeys.length > 0) await bucket.delete(createdStorageKeys)
    throw error
  }
  return { attachments: stored, createdStorageKeys }
}

/**
 * Remove only uploads that are still unreferenced after a failed intake. The
 * D1 check makes cleanup safe when the caller lost the acknowledgement after
 * the atomic intake batch had already committed.
 */
export async function cleanupPortalFiles(
  db: D1Database,
  bucket: R2Bucket,
  storageKeys: string[],
): Promise<void> {
  const keys = [...new Set(storageKeys)]
  if (keys.length === 0) return
  const placeholders = keys.map(() => '?').join(', ')
  const referenced = await db
    .prepare(`SELECT storage_key FROM stored_files WHERE storage_key IN (${placeholders})`)
    .bind(...keys)
    .all<{ storage_key: string }>()
  const retained = new Set(referenced.results.map((row) => row.storage_key))
  const removable = keys.filter((key) => !retained.has(key))
  if (removable.length > 0) await bucket.delete(removable)
}
