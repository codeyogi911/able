import type { DeliveryState } from '../domain/types'

export async function prepareWhatsAppDelivery(
  db: D1Database,
  input: {
    conversationId: string
    recipient: string
    accountId: string
    endpointId: string
    now: Date
  },
): Promise<{ ok: true; recipient: string } | { ok: false; reason: string }> {
  const conversation = await db.prepare(
    `SELECT external_thread_id FROM communication_conversations
     WHERE id = ? AND channel = 'whatsapp' AND account_id = ? AND endpoint_id = ?`,
  ).bind(input.conversationId, input.accountId, input.endpointId).first<{
    external_thread_id: string
  }>()
  const verifiedRecipient = conversation
    ? conversation.external_thread_id.startsWith('+')
      ? conversation.external_thread_id
      : `+${conversation.external_thread_id}`
    : null
  if (!verifiedRecipient || verifiedRecipient !== input.recipient) {
    return { ok: false, reason: 'The WhatsApp recipient no longer matches the verified channel binding' }
  }
  const latest = await db.prepare(
    `SELECT MAX(last_inbound_at) AS last_inbound_at FROM communication_conversations
     WHERE channel = 'whatsapp' AND account_id = ? AND endpoint_id = ? AND external_thread_id = ?`,
  ).bind(input.accountId, input.endpointId, conversation!.external_thread_id).first<{ last_inbound_at: string | null }>()
  const lastInbound = Date.parse(latest?.last_inbound_at ?? '')
  if (!Number.isFinite(lastInbound) || input.now.valueOf() - lastInbound > 24 * 60 * 60 * 1_000) {
    return { ok: false, reason: 'The WhatsApp customer-service window has expired; an approved template is required' }
  }
  return { ok: true, recipient: verifiedRecipient }
}

export function communicationsExpiredDeliveryProjection(db: D1Database, error: string): D1PreparedStatement {
  return db.prepare(
    `UPDATE communication_messages
     SET delivery_state = 'indeterminate'
     WHERE id IN (
       SELECT communication_message_id FROM outbox_rows
       WHERE subject_type = 'conversation' AND state = 'indeterminate'
         AND last_error = ? AND communication_message_id IS NOT NULL
     )`,
  ).bind(error)
}

export function communicationsFinalDeliveryProjection(
  db: D1Database,
  input: {
    outboxId: string
    state: Extract<DeliveryState, 'accepted' | 'blocked' | 'failed'>
    attemptCount: number
    providerMessageId?: string
  },
): D1PreparedStatement {
  const providerMessageId = input.providerMessageId ?? null
  return db.prepare(
    `UPDATE communication_messages
     SET delivery_state = ?, provider_message_id = COALESCE(?, provider_message_id)
     WHERE id = (
       SELECT communication_message_id FROM outbox_rows
       WHERE id = ? AND subject_type = 'conversation' AND state = ? AND attempt_count = ?
         AND (? IS NULL OR provider_message_id = ?)
     )`,
  ).bind(input.state, providerMessageId, input.outboxId, input.state, input.attemptCount, providerMessageId, providerMessageId)
}

/**
 * Meta can report a status after accepting the HTTP send but before the
 * delivery worker has persisted the returned WAMID. Reconcile those durable,
 * initially-unlinked observations in the same finalization batch so a
 * terminal failure cannot disappear behind an `accepted` message.
 */
export function communicationsAcceptedDeliveryReconciliation(
  db: D1Database,
  input: { outboxId: string; providerMessageId?: string },
): D1PreparedStatement[] {
  if (!input.providerMessageId) return []
  const failureError = 'Meta reported a terminal delivery failure after accepting the message'
  return [
    db.prepare(
      `UPDATE communication_provider_delivery_events
       SET conversation_id = (
             SELECT m.conversation_id
             FROM outbox_rows o
             JOIN communication_messages m ON m.id = o.communication_message_id
             WHERE o.id = ? AND o.subject_type = 'conversation'
           ),
           communication_message_id = (
             SELECT m.id
             FROM outbox_rows o
             JOIN communication_messages m ON m.id = o.communication_message_id
             WHERE o.id = ? AND o.subject_type = 'conversation'
           )
       WHERE provider = 'meta_whatsapp' AND provider_message_id = ? AND communication_message_id IS NULL
         AND provider_account_id = (
           SELECT c.account_id
           FROM outbox_rows o
           JOIN communication_messages m ON m.id = o.communication_message_id
           JOIN communication_conversations c ON c.id = m.conversation_id
           WHERE o.id = ? AND o.subject_type = 'conversation'
         )`,
    ).bind(input.outboxId, input.outboxId, input.providerMessageId, input.outboxId),
    db.prepare(
      `INSERT OR IGNORE INTO audit_events
         (id, subject_type, subject_id, actor_kind, event_type, evidence_json, source_created_at, created_at)
       SELECT 'audit_delivery_reconciled_' || e.id, 'conversation', e.conversation_id, 'system',
              'communications.delivery_status_observed',
              json_object('provider', e.provider, 'providerMessageId', e.provider_message_id,
                          'status', e.status, 'payloadHash', e.payload_hash),
              e.occurred_at, CURRENT_TIMESTAMP
       FROM communication_provider_delivery_events e
       WHERE e.provider = 'meta_whatsapp' AND e.provider_message_id = ?
         AND e.communication_message_id = (
           SELECT communication_message_id FROM outbox_rows WHERE id = ? AND subject_type = 'conversation'
         )`,
    ).bind(input.providerMessageId, input.outboxId),
    db.prepare(
      `UPDATE outbox_rows
       SET state = 'blocked', last_error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND state = 'accepted' AND provider_message_id = ?
         AND EXISTS (
           SELECT 1 FROM communication_provider_delivery_events e
           WHERE e.communication_message_id = outbox_rows.communication_message_id AND e.status = 'failed'
         )`,
    ).bind(failureError, input.outboxId, input.providerMessageId),
    db.prepare(
      `UPDATE communication_messages
       SET delivery_state = 'blocked'
       WHERE id = (SELECT communication_message_id FROM outbox_rows WHERE id = ? AND subject_type = 'conversation')
         AND delivery_state = 'accepted'
         AND EXISTS (
           SELECT 1 FROM communication_provider_delivery_events e
           WHERE e.communication_message_id = communication_messages.id AND e.status = 'failed'
         )`,
    ).bind(input.outboxId),
  ]
}

export function communicationsIndeterminateDeliveryProjection(
  db: D1Database,
  input: {
    outboxId: string
    leaseId: string
    attemptCount: number
    providerMessageId?: string
    possiblyCommittedState?: Extract<DeliveryState, 'accepted' | 'blocked' | 'failed'>
  },
): D1PreparedStatement {
  const providerMessageId = input.providerMessageId ?? null
  const possibleState = input.possiblyCommittedState ?? null
  return db.prepare(
    `UPDATE communication_messages
     SET delivery_state = 'indeterminate', provider_message_id = COALESCE(?, provider_message_id)
     WHERE id = (
       SELECT communication_message_id FROM outbox_rows
       WHERE id = ? AND subject_type = 'conversation' AND (
         (state = 'sending' AND lease_id = ?)
         OR (? IS NOT NULL AND state = 'accepted' AND provider_message_id = ?)
         OR (? IN ('failed', 'blocked') AND state = ? AND attempt_count = ?)
       )
     )`,
  ).bind(
    providerMessageId,
    input.outboxId,
    input.leaseId,
    providerMessageId,
    providerMessageId,
    possibleState,
    possibleState,
    input.attemptCount,
  )
}
