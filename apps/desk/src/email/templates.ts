import type { Actor } from '../domain/types'
import { safeMarkdown } from '../ui/markdown'

export const EMAIL_NOTIFICATIONS = [
  'case_received',
  'customer_update_received',
  'agent_reply',
  'case_recovery',
] as const

export type EmailNotification = typeof EMAIL_NOTIFICATIONS[number]

export type EmailTemplateVariables = {
  workspace_name: string
  customer_name: string
  case_ref: string
  case_subject: string
  case_link: string
  recovery_link: string
  message_body?: string
}

export type EmailTemplatePatch = {
  enabled?: boolean
  subjectTemplate?: string
  bodyTextTemplate?: string
  bodyMarkdownTemplate?: string
}

export type EmailTemplateView = {
  notification: EmailNotification
  label: string
  enabled: boolean
  subjectTemplate: string
  bodyTextTemplate: string
  bodyMarkdownTemplate: string
  placeholders: string[]
}

export type EmailCustomization = {
  schemaVersion: 'email-customization.v1'
  format: 'markdown'
  templates: EmailTemplateView[]
}

type EmailTemplateRow = {
  notification: EmailNotification
  enabled: number
  subject_template: string
  body_text_template: string
  body_markdown_template: string
}

const PLACEHOLDERS = [
  'workspace_name',
  'customer_name',
  'case_ref',
  'case_subject',
  'message_body',
  'case_link',
  'recovery_link',
] as const

const SUBJECT_PLACEHOLDERS = new Set(['workspace_name', 'customer_name', 'case_ref', 'case_subject'])
const BODY_PLACEHOLDERS = new Set(PLACEHOLDERS)
const TOKEN_PATTERN = /\{\{([^{}]+)\}\}/g

const LABELS: Record<EmailNotification, string> = {
  case_received: 'Case received',
  customer_update_received: 'Customer update received',
  agent_reply: 'Agent reply',
  case_recovery: 'Case recovery',
}

function cleanTemplate(value: string, label: string, maximum: number, lineOnly = false): string {
  const normalized = lineOnly
    ? value.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
    : value.replaceAll('\u0000', '').trim()
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${label} is required and must be ${maximum} characters or fewer`)
  }
  return normalized
}

function validatePlaceholders(template: string, allowed: ReadonlySet<string>): void {
  const matched = [...template.matchAll(TOKEN_PATTERN)]
  for (const token of matched) {
    const name = token[1] ?? ''
    if (!/^[a-z][a-z0-9_]*$/.test(name) || !allowed.has(name)) {
      throw new Error(`Unknown email placeholder: {{${name}}}`)
    }
  }
  const remainder = template.replace(TOKEN_PATTERN, '')
  if (remainder.includes('{{') || remainder.includes('}}')) {
    throw new Error('Email placeholders must use the exact {{placeholder_name}} form')
  }
}

function normalizePatch(patch: EmailTemplatePatch): EmailTemplatePatch {
  const normalized: EmailTemplatePatch = {}
  if (patch.enabled !== undefined) normalized.enabled = patch.enabled
  if (patch.subjectTemplate !== undefined) {
    const subjectTemplate = cleanTemplate(patch.subjectTemplate, 'Email subject template', 300, true)
    validatePlaceholders(subjectTemplate, SUBJECT_PLACEHOLDERS)
    normalized.subjectTemplate = subjectTemplate
  }
  if (patch.bodyTextTemplate !== undefined) {
    const bodyTextTemplate = cleanTemplate(patch.bodyTextTemplate, 'Email plain-text template', 50_000)
    validatePlaceholders(bodyTextTemplate, BODY_PLACEHOLDERS)
    normalized.bodyTextTemplate = bodyTextTemplate
  }
  if (patch.bodyMarkdownTemplate !== undefined) {
    const bodyMarkdownTemplate = cleanTemplate(patch.bodyMarkdownTemplate, 'Email Markdown template', 50_000)
    validatePlaceholders(bodyMarkdownTemplate, BODY_PLACEHOLDERS)
    normalized.bodyMarkdownTemplate = bodyMarkdownTemplate
  }
  return normalized
}

function view(row: EmailTemplateRow): EmailTemplateView {
  return {
    notification: row.notification,
    label: LABELS[row.notification],
    enabled: row.enabled === 1,
    subjectTemplate: row.subject_template,
    bodyTextTemplate: row.body_text_template,
    bodyMarkdownTemplate: row.body_markdown_template,
    placeholders: [...PLACEHOLDERS],
  }
}

export async function loadEmailCustomization(db: D1Database): Promise<EmailCustomization> {
  const result = await db.prepare(
    `SELECT notification, enabled, subject_template, body_text_template, body_markdown_template
     FROM email_notification_templates
     ORDER BY CASE notification
       WHEN 'case_received' THEN 1
       WHEN 'customer_update_received' THEN 2
       WHEN 'agent_reply' THEN 3
       WHEN 'case_recovery' THEN 4
       ELSE 5 END`,
  ).all<EmailTemplateRow>()
  if (result.results.length !== EMAIL_NOTIFICATIONS.length) {
    throw new Error('Morrow Desk email customization migration has not been applied')
  }
  return {
    schemaVersion: 'email-customization.v1',
    format: 'markdown',
    templates: result.results.map(view),
  }
}

export async function updateEmailCustomization(
  db: D1Database,
  notification: EmailNotification,
  patch: EmailTemplatePatch,
  actor: Actor,
): Promise<EmailCustomization> {
  if (!EMAIL_NOTIFICATIONS.includes(notification)) throw new Error('Email notification type is invalid')
  const normalized = normalizePatch(patch)
  const changed = Object.keys(normalized).sort()
  if (changed.length === 0) throw new Error('Provide at least one email notification field to update')
  const current = (await loadEmailCustomization(db)).templates.find((template) => template.notification === notification)
  if (!current) throw new Error('Email notification template was not found')
  const next = { ...current, ...normalized }
  await db.batch([
    db.prepare(
      `UPDATE email_notification_templates SET
         enabled = ?, subject_template = ?, body_text_template = ?, body_markdown_template = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE notification = ?`,
    ).bind(
      next.enabled ? 1 : 0,
      next.subjectTemplate,
      next.bodyTextTemplate,
      next.bodyMarkdownTemplate,
      notification,
    ),
    db.prepare(
      `INSERT INTO audit_events
         (id, actor_id, actor_kind, event_type, subject_type, subject_id, evidence_json)
       VALUES (?, ?, 'operator', 'workspace.email_customized', 'email_notification', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      actor.id,
      notification,
      JSON.stringify({ changed }),
    ),
  ])
  return loadEmailCustomization(db)
}

function escapeMarkdownText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/([\\`*_[\]{}()#+\-.!|>])/g, '\\$1')
}

function renderTemplate(template: string, variables: EmailTemplateVariables, markdown: boolean): string {
  return template.replace(TOKEN_PATTERN, (_token, name: string) => {
    const raw = variables[name as keyof EmailTemplateVariables] ?? ''
    const value = String(raw)
    if (!markdown || name === 'case_link' || name === 'recovery_link') return value
    return escapeMarkdownText(value)
  })
}

export async function prepareEmailNotification(
  db: D1Database,
  notification: EmailNotification,
  variables: EmailTemplateVariables,
): Promise<{ subject: string; bodyText: string; bodyHtml: string } | null> {
  const template = (await loadEmailCustomization(db)).templates.find((item) => item.notification === notification)
  if (!template) throw new Error('Email notification template was not found')
  if (!template.enabled) return null
  const subject = cleanTemplate(renderTemplate(template.subjectTemplate, variables, false), 'Rendered email subject', 300, true)
  const bodyText = cleanTemplate(renderTemplate(template.bodyTextTemplate, variables, false), 'Rendered email body', 50_000)
  const markdown = cleanTemplate(renderTemplate(template.bodyMarkdownTemplate, variables, true), 'Rendered email Markdown', 50_000)
  return { subject, bodyText, bodyHtml: safeMarkdown(markdown) }
}
