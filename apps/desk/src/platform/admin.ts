import type { Actor } from '../domain/types'
import type { Env } from '../env'
import { loadHelpdeskSubjectReferences } from '../helpdesk/read-models'
import { loadWorkspaceSettings } from '../settings'
import type { OpsDiagnostics } from './contracts'
import { normalizeOperatorHostname } from '../security/operator-host'

type OutboxViewRow = {
  id: string
  subject_type: string
  subject_id: string | null
  kind: OpsDiagnostics['outbox'][number]['kind']
  recipient: string
  state: OpsDiagnostics['outbox'][number]['state']
  attempt_count: number
  next_attempt_at: string | null
  last_error: string | null
  updated_at: string
}

export async function loadOpsDiagnostics(env: Env): Promise<OpsDiagnostics> {
  const [settings, outbox, operators] = await Promise.all([
    loadWorkspaceSettings(env.DB),
    env.DB.prepare(
      `SELECT outbox.id, outbox.subject_type, outbox.subject_id, outbox.kind, outbox.recipient, outbox.state,
              outbox.attempt_count, outbox.next_attempt_at, outbox.last_error, outbox.updated_at
       FROM outbox_rows outbox
       ORDER BY outbox.created_at DESC LIMIT 100`,
    ).all<OutboxViewRow>(),
    env.DB.prepare(
      `SELECT id, name, email, role, active FROM operators ORDER BY active DESC, name ASC`,
    ).all<{ id: string; name: string; email: string; role: 'admin' | 'agent'; active: number }>(),
  ])
  const subjectReferences = await loadHelpdeskSubjectReferences(
    env.DB,
    outbox.results.map((row) => ({ subjectType: row.subject_type, subjectId: row.subject_id })),
  )
  return {
    setup: {
      accessReady: Boolean(normalizeOperatorHostname(env.MORROW_OPERATOR_HOSTNAME) && env.CF_ACCESS_AUD && env.CF_ACCESS_TEAM_DOMAIN),
      securityReady: Boolean(
        env.TURNSTILE_SECRET_KEY
        && env.TURNSTILE_SITE_KEY
        && env.CUSTOMER_CAPABILITY_SECRET
        && env.CUSTOMER_CAPABILITY_SECRET.length >= 32
      ),
      emailReady: Boolean(settings.emailTestedAt),
      intakeEnabled: settings.publicIntakeEnabled,
      lastEmailTestAt: settings.emailTestedAt,
    },
    outbox: outbox.results.map((row, index) => ({
      id: row.id,
      caseRef: subjectReferences[index] ?? null,
      kind: row.kind,
      recipient: row.recipient,
      state: row.state,
      attempts: row.attempt_count,
      nextAttemptAt: row.next_attempt_at ?? row.updated_at,
      lastError: row.last_error,
      updatedAt: row.updated_at,
    })),
    operators: operators.results.map((operator) => ({ ...operator, active: operator.active === 1 })),
  }
}

export async function updateOperatorRole(
  env: Env,
  actor: Actor,
  operatorId: string,
  role: 'admin' | 'agent',
): Promise<void> {
  if (actor.role !== 'admin') throw new Error('Admin access required')
  if (operatorId === actor.id) throw new Error('Administrators cannot change their own role')
  const operator = await env.DB.prepare(
    `SELECT id, email, role, active FROM operators WHERE id = ?`,
  ).bind(operatorId).first<{ id: string; email: string; role: 'admin' | 'agent'; active: number }>()
  if (!operator || operator.active !== 1) throw new Error('Active operator not found')
  if (env.MORROW_OWNER_EMAIL && operator.email.toLowerCase() === env.MORROW_OWNER_EMAIL.trim().toLowerCase() && role !== 'admin') {
    throw new Error('The configured owner must remain an administrator')
  }
  if (operator.role === 'admin' && role === 'agent') {
    const count = await env.DB.prepare(`SELECT COUNT(*) AS value FROM operators WHERE role = 'admin' AND active = 1`).first<{ value: number }>()
    if ((count?.value ?? 0) <= 1) throw new Error('At least one active administrator is required')
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE operators SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(role, operatorId),
    env.DB.prepare(
      `INSERT INTO audit_events
         (id, actor_id, actor_kind, event_type, subject_type, subject_id, evidence_json)
       VALUES (?, ?, 'operator', 'operator.role_updated', 'operator', ?, ?)`,
    ).bind(crypto.randomUUID(), actor.id, operatorId, JSON.stringify({ from: operator.role, to: role })),
  ])
}

export function operatorWriteIsSameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin')
  if (!origin) return false
  try {
    if (new URL(origin).origin !== new URL(request.url).origin) return false
  } catch {
    return false
  }
  const site = request.headers.get('Sec-Fetch-Site')
  return !site || site === 'same-origin' || site === 'none'
}
