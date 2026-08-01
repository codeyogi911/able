import type { DeliveryState } from '../domain/types'
import {
  CUSTOMER_CAPABILITY_PLACEHOLDER,
  ENCODED_CUSTOMER_CAPABILITY_PLACEHOLDER,
  materializeCustomerCapability,
} from './capabilities'

export type HelpdeskDeliveryEnvelope = {
  subjectType: string
  subjectId: string | null
  subject: string
  bodyText: string
  bodyHtml: string
}

export type PreparedHelpdeskDelivery =
  | { ok: true; subject: string; bodyText: string; bodyHtml: string; redactAfterSubmission: boolean }
  | { ok: false; reason: string; redactAfterSubmission: boolean }

type CapabilityRow = {
  public_id: string
  ref: string
  customer_capability_nonce: string
}

const CASE_REF_PLACEHOLDER = '{{case_ref}}'
const ENCODED_CASE_REF_PLACEHOLDER = encodeURIComponent(CASE_REF_PLACEHOLDER)

/**
 * Materialize Helpdesk-owned delivery templates without exposing case storage
 * or capability coordinates to the provider-delivery loop.
 */
export async function prepareHelpdeskDelivery(
  db: D1Database,
  capabilitySecret: string | undefined,
  envelope: HelpdeskDeliveryEnvelope,
): Promise<PreparedHelpdeskDelivery> {
  const hasCapabilityTemplate = envelope.bodyText.includes(CUSTOMER_CAPABILITY_PLACEHOLDER)
    || envelope.bodyHtml.includes(CUSTOMER_CAPABILITY_PLACEHOLDER)
    || envelope.bodyHtml.includes(ENCODED_CUSTOMER_CAPABILITY_PLACEHOLDER)
  const hasCaseRefTemplate = envelope.subject.includes(CASE_REF_PLACEHOLDER)
    || envelope.bodyText.includes(CASE_REF_PLACEHOLDER)
    || envelope.bodyHtml.includes(CASE_REF_PLACEHOLDER)
    || envelope.bodyHtml.includes(ENCODED_CASE_REF_PLACEHOLDER)
  if (!hasCapabilityTemplate && !hasCaseRefTemplate) {
    return {
      ok: true,
      subject: envelope.subject,
      bodyText: envelope.bodyText,
      bodyHtml: envelope.bodyHtml,
      redactAfterSubmission: false,
    }
  }
  if (envelope.subjectType !== 'case' || !envelope.subjectId) {
    return { ok: false, reason: 'Customer email template subject was not found', redactAfterSubmission: false }
  }
  if (hasCapabilityTemplate && (!capabilitySecret || capabilitySecret.length < 32)) {
    return { ok: false, reason: 'Customer capability delivery is not configured', redactAfterSubmission: false }
  }
  const row = await db.prepare(
    `SELECT public_id, ref, customer_capability_nonce
     FROM cases WHERE public_id = ?`,
  ).bind(envelope.subjectId).first<CapabilityRow>()
  if (!row) {
    return { ok: false, reason: 'Customer capability delivery subject was not found', redactAfterSubmission: false }
  }
  const materializeRef = (value: string) => value
    .replaceAll(CASE_REF_PLACEHOLDER, row.ref)
    .replaceAll(ENCODED_CASE_REF_PLACEHOLDER, encodeURIComponent(row.ref))
  const subject = materializeRef(envelope.subject)
  let bodyText = materializeRef(envelope.bodyText)
  let bodyHtml = materializeRef(envelope.bodyHtml)
  if (hasCapabilityTemplate) {
    const input = { secret: capabilitySecret!, casePublicId: row.public_id, nonce: row.customer_capability_nonce }
    bodyText = await materializeCustomerCapability(bodyText, input)
    bodyHtml = await materializeCustomerCapability(bodyHtml, input)
  }
  return {
    ok: true,
    subject,
    bodyText,
    bodyHtml,
    redactAfterSubmission: hasCapabilityTemplate,
  }
}

/** Project an expired generic outbox claim into its Helpdesk message. */
export function helpdeskExpiredDeliveryProjection(db: D1Database, error: string): D1PreparedStatement {
  return db.prepare(
    `UPDATE messages
     SET delivery_state = 'indeterminate'
     WHERE id IN (
       SELECT message_id FROM outbox_rows
       WHERE subject_type = 'case' AND state = 'indeterminate'
         AND last_error = ? AND message_id IS NOT NULL
     )`,
  ).bind(error)
}

export type HelpdeskFinalDeliveryProjection = {
  outboxId: string
  state: Extract<DeliveryState, 'accepted' | 'blocked' | 'failed'>
  attemptCount: number
  providerMessageId?: string
}

/**
 * Build the Helpdesk side of the same D1 batch that finalizes an outbox claim.
 * The state/attempt guard prevents a stale worker from projecting its result.
 */
export function helpdeskFinalDeliveryProjection(
  db: D1Database,
  input: HelpdeskFinalDeliveryProjection,
): D1PreparedStatement {
  const providerMessageId = input.providerMessageId ?? null
  return db.prepare(
    `UPDATE messages
     SET delivery_state = ?, provider_message_id = COALESCE(?, provider_message_id)
     WHERE id = (
       SELECT message_id FROM outbox_rows
       WHERE id = ? AND subject_type = 'case' AND state = ? AND attempt_count = ?
         AND (? IS NULL OR provider_message_id = ?)
     )`,
  ).bind(
    input.state,
    providerMessageId,
    input.outboxId,
    input.state,
    input.attemptCount,
    providerMessageId,
    providerMessageId,
  )
}

export type HelpdeskIndeterminateDeliveryProjection = {
  outboxId: string
  leaseId: string
  attemptCount: number
  providerMessageId?: string
  possiblyCommittedState?: Extract<DeliveryState, 'accepted' | 'blocked' | 'failed'>
}

/** Project an uncertain generic outbox attempt without exposing message SQL. */
export function helpdeskIndeterminateDeliveryProjection(
  db: D1Database,
  input: HelpdeskIndeterminateDeliveryProjection,
): D1PreparedStatement {
  const providerMessageId = input.providerMessageId ?? null
  const possibleState = input.possiblyCommittedState ?? null
  return db.prepare(
    `UPDATE messages
     SET delivery_state = 'indeterminate',
         provider_message_id = COALESCE(?, provider_message_id)
     WHERE id = (
       SELECT message_id FROM outbox_rows
       WHERE id = ? AND subject_type = 'case' AND (
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
