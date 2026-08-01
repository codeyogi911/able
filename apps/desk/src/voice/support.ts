import type { HelpdeskImplementation } from '../helpdesk'
import type { CaseRef, DeliveryState } from '../domain/types'
import type { VoiceContact } from './contact'

const TICKET_WINDOW_MS = 15 * 60_000
const TICKET_LIMIT = 3
const encoder = new TextEncoder()

export type VoiceTicketCapacity = 'claimed' | 'replayed' | 'limited'

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function claimVoiceTicketCapacity(
  db: D1Database,
  email: string,
  requestId: string,
  now = Date.now(),
): Promise<VoiceTicketCapacity> {
  const [subjectHash, requestHash] = await Promise.all([
    sha256(`morrow.voice-ticket.subject.v1\0${email.trim().toLowerCase()}`),
    sha256(`morrow.voice-ticket.request.v1\0${requestId}`),
  ])
  const id = `voice_ticket_${crypto.randomUUID()}`
  const cutoff = now - TICKET_WINDOW_MS
  const inserted = await db.prepare(
    `INSERT INTO voice_ticket_events (id, subject_hash, request_hash, created_at_ms)
     SELECT ?, ?, ?, ?
     WHERE (
       SELECT COUNT(*) FROM voice_ticket_events
       WHERE subject_hash = ? AND created_at_ms > ?
     ) < ?
     ON CONFLICT(request_hash) DO NOTHING
     RETURNING id`,
  ).bind(id, subjectHash, requestHash, now, subjectHash, cutoff, TICKET_LIMIT).first<{ id: string }>()
  if (inserted) return 'claimed'

  const replay = await db.prepare(
    'SELECT id FROM voice_ticket_events WHERE request_hash = ?',
  ).bind(requestHash).first<{ id: string }>()
  return replay ? 'replayed' : 'limited'
}

export async function openVoiceSupportCase(
  helpdesk: HelpdeskImplementation,
  contact: VoiceContact,
  input: { subject: string; body: string; requestId?: string },
): Promise<{ ref: CaseRef; created: boolean; delivery: DeliveryState | null }> {
  const receipt = await helpdesk.intake(
    { kind: 'voice', requestId: input.requestId ?? `voice-${crypto.randomUUID()}` },
    {
      name: contact.name,
      email: contact.email,
      subject: input.subject,
      body: input.body,
    },
  )
  return { ref: receipt.caseRef, created: receipt.created, delivery: receipt.delivery }
}
