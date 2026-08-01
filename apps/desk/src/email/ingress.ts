import PostalMime, { type Address, type Attachment as ParsedAttachment, type Email as ParsedEmail } from 'postal-mime'
import type { Helpdesk, IntakeRequest } from '../domain/types'

const MAX_ATTACHMENTS = 10
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_BYTES = 25 * 1024 * 1024

function header(email: ParsedEmail, key: string): string {
  return email.headers.find((item) => item.key === key.toLowerCase())?.value.trim() ?? ''
}

function isAutomated(email: ParsedEmail): boolean {
  const autoSubmitted = header(email, 'auto-submitted').toLowerCase()
  const precedence = header(email, 'precedence').toLowerCase()
  return (autoSubmitted !== '' && autoSubmitted !== 'no')
    || ['bulk', 'junk', 'list'].includes(precedence)
    || header(email, 'x-autoreply') !== ''
    || header(email, 'x-autorespond') !== ''
    || header(email, 'x-auto-response-suppress') !== ''
}

function mailbox(address: Address | undefined): { name: string; email: string } | null {
  if (!address || 'group' in address) return null
  const email = address.address.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null
  return { name: address.name.trim() || email.split('@')[0] || 'Customer', email }
}

function plainText(email: ParsedEmail): string {
  if (email.text?.trim()) return email.text.trim().slice(0, 100_000)
  const html = email.html ?? ''
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 100_000)
}

function threadRef(email: ParsedEmail): string | undefined {
  const candidates = [email.subject, email.inReplyTo, email.references].filter(Boolean).join(' ')
  const match = candidates.match(/(?:^|[^A-Z0-9])([A-Z][A-Z0-9]{1,7}-\d+)(?:$|[^A-Z0-9])/i)
  return match?.[1]?.toUpperCase()
}

function messageReferences(...values: Array<string | undefined>): string[] {
  const references = new Set<string>()
  for (const value of values) {
    if (!value) continue
    const bracketed = [...value.matchAll(/<([^<>\s]+)>/g)].flatMap((match) => match[1] ? [match[1]] : [])
    const candidates = bracketed.length > 0 ? bracketed : value.split(/\s+/)
    for (const candidate of candidates) {
      const normalized = candidate.trim().replace(/^<|>$/g, '').toLowerCase()
      if (/^[^<>\s@]+@[^<>\s@]+$/.test(normalized)) references.add(normalized)
    }
  }
  return [...references].slice(0, 20)
}

function safeFilename(value: string | null, index: number): string {
  const clean = (value ?? `attachment-${index + 1}`)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f/\\]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180)
  return clean || `attachment-${index + 1}`
}

function bytes(attachment: ParsedAttachment): Uint8Array {
  if (attachment.content instanceof Uint8Array) return attachment.content
  if (attachment.content instanceof ArrayBuffer) return new Uint8Array(attachment.content)
  return new TextEncoder().encode(attachment.content)
}

async function sha256(input: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', input as BufferSource)
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('')
}

async function storeAttachments(
  bucket: R2Bucket,
  messageId: string,
  attachments: ParsedAttachment[],
): Promise<NonNullable<IntakeRequest['attachments']>> {
  if (attachments.length > MAX_ATTACHMENTS) throw new Error(`Email has more than ${MAX_ATTACHMENTS} attachments`)
  const sizes = attachments.map((attachment) => bytes(attachment).byteLength)
  if (sizes.some((size) => size > MAX_ATTACHMENT_BYTES)) throw new Error('An email attachment exceeds the 10 MB limit')
  if (sizes.reduce((sum, size) => sum + size, 0) > MAX_TOTAL_BYTES) throw new Error('Email attachments exceed the 25 MB combined limit')

  const stored: NonNullable<IntakeRequest['attachments']> = []
  const prefixHash = await sha256(new TextEncoder().encode(messageId))
  for (const [index, attachment] of attachments.entries()) {
    const content = bytes(attachment)
    const digest = await sha256(content)
    // Providers may retry the exact RFC message. Keep attachment identity and
    // storage content-addressed so a Message-ID replay is one canonical intake
    // command and one R2 object instead of a second orphan.
    const identity = await sha256(new TextEncoder().encode(`${prefixHash}:${index}:${digest}`))
    const id = `att_${identity.slice(0, 32)}`
    const filename = safeFilename(attachment.filename, index)
    const storageKey = `email/${prefixHash}/${index}-${digest}`
    const contentType = attachment.mimeType || 'application/octet-stream'
    await bucket.put(storageKey, content, {
      httpMetadata: { contentType, contentDisposition: `attachment; filename="${filename.replaceAll('"', '')}"` },
      customMetadata: { sha256: digest },
    })
    stored.push({ id, filename, contentType, size: content.byteLength, storageKey, sha256: digest })
  }
  return stored
}

export type EmailIngressResult = { accepted: boolean; reason: string; caseRef?: string }

export async function ingestEmail(
  message: ForwardableEmailMessage,
  helpdesk: Helpdesk,
  attachments: R2Bucket,
): Promise<EmailIngressResult> {
  const parsed = await PostalMime.parse(message.raw, { attachmentEncoding: 'arraybuffer', maxNestingDepth: 10, maxHeadersSize: 256 * 1024 })
  if (isAutomated(parsed)) return { accepted: false, reason: 'automated_message_suppressed' }
  const sender = mailbox(parsed.from)
  if (!sender) return { accepted: false, reason: 'invalid_sender' }
  const [messageId] = messageReferences(parsed.messageId || header(parsed, 'message-id'))
  if (!messageId) return { accepted: false, reason: 'missing_message_id' }
  const body = plainText(parsed)
  if (!body) return { accepted: false, reason: 'empty_body' }
  const subject = (parsed.subject?.trim() || 'Support request').slice(0, 300)
  const stored = await storeAttachments(attachments, messageId, parsed.attachments)
  const replyToRef = threadRef(parsed)
  const request: IntakeRequest = {
    name: sender.name,
    email: sender.email,
    subject,
    body,
    attachments: stored,
  }
  if (replyToRef) request.replyToRef = replyToRef
  const replyToMessageIds = messageReferences(parsed.inReplyTo, parsed.references)
  if (replyToMessageIds.length > 0) request.replyToMessageIds = replyToMessageIds
  const receipt = await helpdesk.intake({ kind: 'email', messageId }, request)
  return { accepted: true, reason: receipt.created ? 'case_created' : 'message_recorded', caseRef: receipt.caseRef }
}
