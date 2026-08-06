import type { Env } from '../env'
import {
  communicationsExpiredDeliveryProjection,
  communicationsAcceptedDeliveryReconciliation,
  communicationsFinalDeliveryProjection,
  communicationsIndeterminateDeliveryProjection,
  prepareWhatsAppDelivery,
} from '../communications/delivery'
import {
  helpdeskExpiredDeliveryProjection,
  helpdeskFinalDeliveryProjection,
  helpdeskIndeterminateDeliveryProjection,
  prepareHelpdeskDelivery,
} from '../helpdesk/delivery'
import { loadWorkspaceSettings, workspaceSupportName } from '../settings'
import { sendWhatsAppText, WhatsAppApiError } from '../whatsapp/client'

type OutboxRow = {
  id: string
  case_id: number | null
  subject_type: string
  subject_id: string | null
  kind: 'customer_magic_link' | 'public_reply' | 'recovery_link' | 'setup_test' | 'whatsapp_reply'
  recipient: string
  sender: string | null
  subject: string
  body_text: string
  body_html: string
  state: 'queued' | 'sending' | 'accepted' | 'blocked' | 'failed' | 'indeterminate'
  attempt_count: number
}

type FinalizedState = 'accepted' | 'blocked' | 'failed'

const RETRYABLE_REJECTION_CODES = new Set([
  'E_RATE_LIMIT_EXCEEDED',
  'E_DAILY_LIMIT_EXCEEDED',
])

const PERMANENT_REJECTION_CODES = new Set([
  'E_VALIDATION_ERROR',
  'E_FIELD_MISSING',
  'E_TOO_MANY_RECIPIENTS',
  'E_TOO_MANY_ATTACHMENTS',
  'E_SENDER_NOT_VERIFIED',
  'E_RECIPIENT_NOT_ALLOWED',
  'E_RECIPIENT_SUPPRESSED',
  'E_SENDER_DOMAIN_NOT_AVAILABLE',
  'E_CONTENT_TOO_LARGE',
  'E_DELIVERY_FAILED',
  'E_HEADER_NOT_ALLOWED',
  'E_HEADER_USE_API_FIELD',
  'E_HEADER_VALUE_INVALID',
  'E_HEADER_VALUE_TOO_LONG',
  'E_HEADER_NAME_INVALID',
  'E_HEADERS_TOO_LARGE',
  'E_HEADERS_TOO_MANY',
])

class ClaimLostError extends Error {
  constructor() {
    super('The durable delivery claim expired or was lost before persistence completed')
    this.name = 'ClaimLostError'
  }
}

export type DeliveryRun = {
  considered: number
  accepted: number
  failed: number
  blocked: number
  indeterminate: number
}

export type DeliveryDependencies = {
  fetch?: typeof fetch
  now?: () => Date
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 500)
}

function providerErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && /^E_[A-Z0-9_]+$/.test(code) ? code : null
}

function classifyProviderError(error: unknown): 'retryable_rejection' | 'permanent_rejection' | 'indeterminate' {
  const code = providerErrorCode(error)
  if (code && RETRYABLE_REJECTION_CODES.has(code)) return 'retryable_rejection'
  if (code && PERMANENT_REJECTION_CODES.has(code)) return 'permanent_rejection'
  // An internal, undocumented, or untyped failure does not prove that the
  // provider rejected the submission before accepting it. Retrying that
  // outcome could send a duplicate, so it is terminal until a human checks
  // provider logs.
  return 'indeterminate'
}

function retryDelay(attempt: number): number {
  return Math.min(6 * 60 * 60, 30 * 2 ** Math.max(0, attempt - 1))
}

async function claimRow(db: D1Database, row: OutboxRow, leaseId: string): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE outbox_rows
     SET state = 'sending', lease_id = ?, lease_expires_at = datetime('now', '+2 minutes'),
         attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND state IN ('queued', 'failed')
       AND next_attempt_at <= CURRENT_TIMESTAMP
       AND (lease_expires_at IS NULL OR lease_expires_at < CURRENT_TIMESTAMP)`,
  ).bind(leaseId, row.id).run()
  return (result.meta.changes ?? 0) === 1
}

async function reconcileExpiredClaims(db: D1Database): Promise<void> {
  const error = 'Delivery claim expired; provider acceptance is unknown and this message will not be retried'
  await db.batch([
    db.prepare(
      `UPDATE outbox_rows
       SET state = 'indeterminate', last_error = ?, lease_id = NULL, lease_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE state = 'sending' AND lease_expires_at <= CURRENT_TIMESTAMP`,
    ).bind(error),
    helpdeskExpiredDeliveryProjection(db, error),
    communicationsExpiredDeliveryProjection(db, error),
  ])
}

async function finalizeClaim(
  db: D1Database,
  row: OutboxRow,
  leaseId: string,
  state: FinalizedState,
  values: {
    providerMessageId?: string
    error?: string
    retrySeconds?: number
    scrubBody?: boolean
  } = {},
): Promise<void> {
  const nextAttempt = values.retrySeconds === undefined
    ? null
    : new Date(Date.now() + values.retrySeconds * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `UPDATE outbox_rows
       SET state = ?, provider_message_id = COALESCE(?, provider_message_id), last_error = ?,
           next_attempt_at = COALESCE(?, next_attempt_at), lease_id = NULL, lease_expires_at = NULL,
           body_text = CASE WHEN ? = 1 THEN '[redacted after provider acceptance]' ELSE body_text END,
           body_html = CASE WHEN ? = 1 THEN '<p>[redacted after provider acceptance]</p>' ELSE body_html END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND state = 'sending' AND lease_id = ?
         AND lease_expires_at > CURRENT_TIMESTAMP`,
    ).bind(
      state,
      values.providerMessageId ?? null,
      values.error ?? null,
      nextAttempt,
      values.scrubBody ? 1 : 0,
      values.scrubBody ? 1 : 0,
      row.id,
      leaseId,
    ),
  ]
  statements.push(
    helpdeskFinalDeliveryProjection(db, {
      outboxId: row.id,
      state,
      attemptCount: row.attempt_count + 1,
      ...(values.providerMessageId === undefined ? {} : { providerMessageId: values.providerMessageId }),
    }),
    communicationsFinalDeliveryProjection(db, {
      outboxId: row.id,
      state,
      attemptCount: row.attempt_count + 1,
      ...(values.providerMessageId === undefined ? {} : { providerMessageId: values.providerMessageId }),
    }),
  )
  if (state === 'accepted') {
    statements.push(...communicationsAcceptedDeliveryReconciliation(db, {
      outboxId: row.id,
      ...(values.providerMessageId === undefined ? {} : { providerMessageId: values.providerMessageId }),
    }))
  }
  const results = await db.batch(statements)
  const outboxResult = results[0]
  if ((outboxResult?.meta.changes ?? 0) !== 1) throw new ClaimLostError()
}

async function forceIndeterminate(
  db: D1Database,
  row: OutboxRow,
  leaseId: string,
  values: {
    error: string
    providerMessageId?: string
    scrubBody?: boolean
    possiblyCommittedState?: FinalizedState
  },
): Promise<void> {
  const attemptCount = row.attempt_count + 1
  const providerMessageId = values.providerMessageId ?? null
  const possibleState = values.possiblyCommittedState ?? null
  const statements: D1PreparedStatement[] = [
    helpdeskIndeterminateDeliveryProjection(db, {
      outboxId: row.id,
      leaseId,
      attemptCount,
      ...(values.providerMessageId === undefined ? {} : { providerMessageId: values.providerMessageId }),
      ...(values.possiblyCommittedState === undefined ? {} : { possiblyCommittedState: values.possiblyCommittedState }),
    }),
    communicationsIndeterminateDeliveryProjection(db, {
      outboxId: row.id,
      leaseId,
      attemptCount,
      ...(values.providerMessageId === undefined ? {} : { providerMessageId: values.providerMessageId }),
      ...(values.possiblyCommittedState === undefined ? {} : { possiblyCommittedState: values.possiblyCommittedState }),
    }),
    db.prepare(
      `UPDATE outbox_rows
       SET state = 'indeterminate', provider_message_id = COALESCE(?, provider_message_id),
           last_error = ?, lease_id = NULL, lease_expires_at = NULL,
           body_text = CASE WHEN ? = 1 THEN '[redacted after provider acceptance]' ELSE body_text END,
           body_html = CASE WHEN ? = 1 THEN '<p>[redacted after provider acceptance]</p>' ELSE body_html END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND (
         (state = 'sending' AND lease_id = ?)
         OR (? IS NOT NULL AND state = 'accepted' AND provider_message_id = ?)
         OR (? IN ('failed', 'blocked') AND state = ? AND attempt_count = ?)
       )`,
    ).bind(
      providerMessageId,
      values.error,
      values.scrubBody ? 1 : 0,
      values.scrubBody ? 1 : 0,
      row.id,
      leaseId,
      providerMessageId,
      providerMessageId,
      possibleState,
      possibleState,
      attemptCount,
    ),
  ]
  await db.batch(statements)
}

async function finalizeOrMakeIndeterminate(
  db: D1Database,
  row: OutboxRow,
  leaseId: string,
  state: FinalizedState,
  values: {
    providerMessageId?: string
    error?: string
    retrySeconds?: number
    scrubBody?: boolean
  },
): Promise<boolean> {
  try {
    await finalizeClaim(db, row, leaseId, state, values)
    return true
  } catch (error) {
    try {
      await forceIndeterminate(db, row, leaseId, {
        possiblyCommittedState: state,
        error: `Delivery outcome could not be persisted safely: ${cleanError(error)}`,
        ...(values.providerMessageId === undefined ? {} : { providerMessageId: values.providerMessageId }),
        ...(values.scrubBody === undefined ? {} : { scrubBody: values.scrubBody }),
      })
    } catch {
      // A row left in `sending` is deliberately not eligible for retry. A
      // later run converts the expired claim to `indeterminate`.
    }
    return false
  }
}

export async function deliverOutbox(env: Env, limit = 25, dependencies: DeliveryDependencies = {}): Promise<DeliveryRun> {
  await reconcileExpiredClaims(env.DB)
  const rows = await env.DB.prepare(
    `SELECT outbox.id, outbox.case_id, outbox.subject_type, outbox.subject_id, outbox.kind, outbox.recipient,
            outbox.sender, outbox.subject, outbox.body_text, outbox.body_html,
            outbox.state, outbox.attempt_count
     FROM outbox_rows outbox
     WHERE outbox.state IN ('queued', 'failed') AND outbox.next_attempt_at <= CURRENT_TIMESTAMP
       AND outbox.attempt_count < 5
       AND (outbox.lease_expires_at IS NULL OR outbox.lease_expires_at < CURRENT_TIMESTAMP)
     ORDER BY outbox.created_at ASC LIMIT ?`,
  ).bind(Math.max(1, Math.min(100, limit))).all<OutboxRow>()
  const run: DeliveryRun = { considered: rows.results.length, accepted: 0, failed: 0, blocked: 0, indeterminate: 0 }
  const settings = await loadWorkspaceSettings(env.DB)

  for (const row of rows.results) {
    const leaseId = crypto.randomUUID()
    if (!(await claimRow(env.DB, row, leaseId))) continue
    if (row.kind === 'whatsapp_reply') {
      if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_WABA_ID || row.subject_type !== 'conversation' || !row.subject_id) {
        const finalized = await finalizeOrMakeIndeterminate(env.DB, row, leaseId, 'blocked', {
          error: 'Outbound WhatsApp is not configured',
        })
        if (finalized) run.blocked += 1
        else run.indeterminate += 1
        continue
      }
      const prepared = await prepareWhatsAppDelivery(env.DB, {
        conversationId: row.subject_id,
        recipient: row.recipient,
        accountId: env.WHATSAPP_WABA_ID,
        endpointId: env.WHATSAPP_PHONE_NUMBER_ID,
        now: (dependencies.now ?? (() => new Date()))(),
      })
      if (!prepared.ok) {
        const finalized = await finalizeOrMakeIndeterminate(env.DB, row, leaseId, 'blocked', {
          error: prepared.reason,
        })
        if (finalized) run.blocked += 1
        else run.indeterminate += 1
        continue
      }
      try {
        const response = await sendWhatsAppText(
          { accessToken: env.WHATSAPP_ACCESS_TOKEN, phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID },
          prepared.recipient,
          row.body_text,
          dependencies.fetch,
        )
        const finalized = await finalizeOrMakeIndeterminate(env.DB, row, leaseId, 'accepted', {
          providerMessageId: response.messageId,
          scrubBody: true,
        })
        if (finalized) run.accepted += 1
        else run.indeterminate += 1
      } catch (error) {
        if (error instanceof WhatsAppApiError) {
          const attempts = row.attempt_count + 1
          const state = error.retryable && attempts < 5 ? 'failed' : 'blocked'
          const finalized = await finalizeOrMakeIndeterminate(env.DB, row, leaseId, state, {
            error: error.evidence(),
            ...(state === 'failed' ? { retrySeconds: retryDelay(attempts) } : {}),
          })
          if (finalized) run[state] += 1
          else run.indeterminate += 1
        } else {
          try {
            await forceIndeterminate(env.DB, row, leaseId, {
              error: `Provider submission outcome is unknown: ${cleanError(error)}`,
              scrubBody: true,
            })
          } catch {
            // The sending lease remains ineligible for automatic retry.
          }
          run.indeterminate += 1
        }
      }
      continue
    }
    const sender = row.sender ?? settings.outboundSender
    if (!sender || !settings.supportEmail || !env.EMAIL) {
      const finalized = await finalizeOrMakeIndeterminate(env.DB, row, leaseId, 'blocked', {
        error: 'Outbound email is not configured',
      })
      if (finalized) run.blocked += 1
      else run.indeterminate += 1
      continue
    }

    const prepared = await prepareHelpdeskDelivery(env.DB, env.CUSTOMER_CAPABILITY_SECRET, {
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      subject: row.subject,
      bodyText: row.body_text,
      bodyHtml: row.body_html,
    })
    if (!prepared.ok) {
      const finalized = await finalizeOrMakeIndeterminate(env.DB, row, leaseId, 'blocked', {
        error: prepared.reason,
      })
      if (finalized) run.blocked += 1
      else run.indeterminate += 1
      continue
    }

    let response: EmailSendResult
    try {
      response = await env.EMAIL.send({
        from: { email: sender, name: workspaceSupportName(settings.displayName) },
        to: row.recipient,
        replyTo: settings.supportEmail,
        subject: prepared.subject,
        text: prepared.bodyText,
        html: prepared.bodyHtml,
        headers: {
          'X-Able-Outbox-ID': row.id,
          Organization: settings.displayName,
          'Auto-Submitted': 'auto-generated',
        },
      })
    } catch (error) {
      const classification = classifyProviderError(error)
      const attempts = row.attempt_count + 1
      if (classification === 'indeterminate') {
        try {
          await forceIndeterminate(env.DB, row, leaseId, {
            error: `Provider submission outcome is unknown: ${cleanError(error)}`,
            scrubBody: prepared.redactAfterSubmission,
          })
        } catch {
          // The durable sending claim remains ineligible for retry and will be
          // reconciled to indeterminate after its lease expires.
        }
        run.indeterminate += 1
      } else if (classification === 'permanent_rejection' || attempts >= 5) {
        const finalized = await finalizeOrMakeIndeterminate(env.DB, row, leaseId, 'blocked', {
          error: cleanError(error),
        })
        if (finalized) run.blocked += 1
        else run.indeterminate += 1
      } else {
        const finalized = await finalizeOrMakeIndeterminate(env.DB, row, leaseId, 'failed', {
          error: cleanError(error),
          retrySeconds: retryDelay(attempts),
        })
        if (finalized) run.failed += 1
        else run.indeterminate += 1
      }
      continue
    }

    const finalized = await finalizeOrMakeIndeterminate(env.DB, row, leaseId, 'accepted', {
      providerMessageId: response.messageId,
      scrubBody: prepared.redactAfterSubmission,
    })
    if (finalized) {
      if (row.kind === 'setup_test') {
        try {
          await env.DB.prepare(
            `UPDATE workspace_settings
             SET email_tested_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = 1`,
          ).run()
        } catch {
          // Delivery acceptance is already durable and must not be downgraded
          // or retried because a separate readiness flag failed to persist.
        }
      }
      run.accepted += 1
    } else {
      run.indeterminate += 1
    }
  }
  return run
}

export async function queueSetupTest(db: D1Database, recipient: string): Promise<string> {
  const settings = await loadWorkspaceSettings(db)
  if (!settings.outboundSender || !settings.supportEmail) throw new Error('Configure support and outbound sender addresses first')
  const id = crypto.randomUUID()
  const text = `This message confirms that ${settings.displayName} can submit outbound support email to the provider.`
  const html = `<!doctype html><html lang="en"><body><p>${escapeHtml(text)}</p></body></html>`
  await db.prepare(
    `INSERT INTO outbox_rows
       (id, case_id, subject_type, subject_id, kind, recipient, sender, subject, body_text, body_html, state)
     VALUES (?, NULL, 'workspace', '1', 'setup_test', ?, ?, ?, ?, ?, 'queued')`,
  ).bind(id, recipient.trim().toLowerCase(), settings.outboundSender, `${settings.displayName} outbound email test`, text, html).run()
  return id
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}
