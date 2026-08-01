import type { Env } from './env'
import type { OutboxState } from './domain/types'
import { loadHelpdeskQueueDiagnostics } from './helpdesk/read-models'
import { loadWorkspaceSettings } from './settings'
import { normalizeOperatorHostname } from './security/operator-host'

export type OperationalDiagnostics = {
  healthy: boolean
  generatedAt: string
  access: { configured: boolean; issuerPinned: boolean; ownerConfigured: boolean }
  setup: { completed: boolean; emailTested: boolean; publicIntakeEnabled: boolean; blockers: string[] }
  queue: { actionable: number; unassigned: number; oldestAgeSeconds: number | null }
  delivery: Record<OutboxState, number>
}

export async function getDiagnostics(env: Env): Promise<OperationalDiagnostics> {
  const settings = await loadWorkspaceSettings(env.DB)
  const [queue, deliveryRows] = await Promise.all([
    loadHelpdeskQueueDiagnostics(env.DB),
    env.DB.prepare(`SELECT state, COUNT(*) AS value FROM outbox_rows GROUP BY state`).all<{ state: keyof OperationalDiagnostics['delivery']; value: number }>(),
  ])
  const delivery: OperationalDiagnostics['delivery'] = { queued: 0, sending: 0, accepted: 0, blocked: 0, failed: 0, indeterminate: 0 }
  for (const row of deliveryRows.results) delivery[row.state] = row.value

  const blockers: string[] = []
  if (!normalizeOperatorHostname(env.MORROW_OPERATOR_HOSTNAME)) blockers.push('Operator hostname is not configured')
  if (!env.CF_ACCESS_AUD) blockers.push('Cloudflare Access audience is not configured')
  if (!env.CF_ACCESS_TEAM_DOMAIN) blockers.push('Cloudflare Access issuer is not configured')
  if (!env.MORROW_OWNER_EMAIL) blockers.push('Owner email is not configured')
  if (!settings.portalBaseUrl) blockers.push('Portal base URL is not configured')
  if (!settings.supportEmail || !settings.outboundSender) blockers.push('Support and outbound sender addresses are incomplete')
  if (!settings.emailTestedAt) blockers.push('Outbound email has not passed the setup test')
  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY) blockers.push('Turnstile is not configured')
  if (!env.CUSTOMER_CAPABILITY_SECRET || env.CUSTOMER_CAPABILITY_SECRET.length < 32) {
    blockers.push('Customer capability signing key is not configured')
  }

  return {
    healthy: blockers.length === 0 && delivery.indeterminate === 0,
    generatedAt: new Date().toISOString(),
    access: {
      configured: Boolean(normalizeOperatorHostname(env.MORROW_OPERATOR_HOSTNAME) && env.CF_ACCESS_AUD && env.CF_ACCESS_TEAM_DOMAIN),
      issuerPinned: Boolean(env.CF_ACCESS_TEAM_DOMAIN),
      ownerConfigured: Boolean(env.MORROW_OWNER_EMAIL),
    },
    setup: {
      completed: Boolean(settings.setupCompletedAt),
      emailTested: Boolean(settings.emailTestedAt),
      publicIntakeEnabled: settings.publicIntakeEnabled,
      blockers,
    },
    queue,
    delivery,
  }
}
