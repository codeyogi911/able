import type { Actor } from './domain/types'

export type WorkspaceSettings = {
  displayName: string
  portalTitle: string
  logoUrl: string | null
  faviconUrl: string | null
  homeUrl: string | null
  supportEmail: string | null
  outboundSender: string | null
  casePrefix: string
  locale: string
  timezone: string
  supportHours: Record<string, unknown>
  accentColor: string
  canvasColor: string
  inkColor: string
  fontFamily: string
  portalBaseUrl: string | null
  publicIntakeEnabled: boolean
  emailTestedAt: string | null
  setupCompletedAt: string | null
}

type SettingsRow = {
  display_name: string
  portal_title: string
  logo_url: string | null
  favicon_url: string | null
  home_url: string | null
  support_email: string | null
  outbound_sender: string | null
  case_prefix: string
  locale: string
  timezone: string
  support_hours_json: string
  accent_color: string
  canvas_color: string
  ink_color: string
  font_family: string
  portal_base_url: string | null
  public_intake_enabled: number
  email_tested_at: string | null
  setup_completed_at: string | null
}

export function workspaceSupportName(displayName: string): string {
  const name = displayName.trim()
  return /\bsupport$/i.test(name) ? name : `${name} Support`
}

/**
 * The display name without a trailing "Support", for copy that already says
 * "support" around it (e.g. "the support assistant for {name}"). A workspace
 * actually named just "Support" keeps its name.
 */
export function workspaceShortName(displayName: string): string {
  const name = displayName.trim()
  const stripped = name.replace(/\s+support$/i, '').trim()
  return stripped || name
}

function normalizedEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? ''
  return normalized || null
}

function line(value: string, label: string, maximum: number): string {
  const normalized = value.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!normalized || normalized.length > maximum) throw new Error(`${label} is required and must be ${maximum} characters or fewer`)
  return normalized
}

function optionalUrl(value: string | null, label: string, originOnly = false): string | null {
  if (!value) return null
  if (!originOnly && value.startsWith('/') && !value.startsWith('//')) return value
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || (originOnly && (url.pathname !== '/' || url.search || url.hash))) {
    throw new Error(`${label} must be a valid HTTPS ${originOnly ? 'origin' : 'URL'}`)
  }
  return originOnly ? url.origin : url.toString()
}

function colorLuminance(hex: string): number {
  const values = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((part) => {
    const value = Number.parseInt(part, 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * values[0]! + 0.7152 * values[1]! + 0.0722 * values[2]!
}

function contrast(first: string, second: string): number {
  const a = colorLuminance(first)
  const b = colorLuminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

export async function loadWorkspaceSettings(db: D1Database): Promise<WorkspaceSettings> {
  const row = await db.prepare(
    `SELECT display_name, portal_title, logo_url, favicon_url, home_url, support_email, outbound_sender,
            case_prefix, locale, timezone, support_hours_json, accent_color, canvas_color,
            ink_color, font_family, portal_base_url, public_intake_enabled, email_tested_at,
            setup_completed_at
     FROM workspace_settings WHERE id = 1`,
  ).first<SettingsRow>()
  if (!row) throw new Error('Morrow Desk baseline migration has not been applied')

  let supportHours: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(row.support_hours_json)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) supportHours = parsed as Record<string, unknown>
  } catch {
    supportHours = {}
  }

  return {
    displayName: row.display_name,
    portalTitle: row.portal_title,
    logoUrl: row.logo_url,
    faviconUrl: row.favicon_url,
    homeUrl: row.home_url,
    supportEmail: row.support_email,
    outboundSender: row.outbound_sender,
    casePrefix: row.case_prefix,
    locale: row.locale,
    timezone: row.timezone,
    supportHours,
    accentColor: row.accent_color,
    canvasColor: row.canvas_color,
    inkColor: row.ink_color,
    fontFamily: row.font_family,
    portalBaseUrl: row.portal_base_url,
    publicIntakeEnabled: row.public_intake_enabled === 1,
    emailTestedAt: row.email_tested_at,
    setupCompletedAt: row.setup_completed_at,
  }
}

export async function updateWorkspaceSettings(
  db: D1Database,
  patch: Partial<Pick<WorkspaceSettings,
    | 'displayName'
    | 'portalTitle'
    | 'logoUrl'
    | 'faviconUrl'
    | 'homeUrl'
    | 'supportEmail'
    | 'outboundSender'
    | 'casePrefix'
    | 'locale'
    | 'timezone'
    | 'supportHours'
    | 'accentColor'
    | 'canvasColor'
    | 'inkColor'
    | 'fontFamily'
    | 'portalBaseUrl'
    | 'publicIntakeEnabled'
  >>,
  actor?: Actor,
): Promise<WorkspaceSettings> {
  const current = await loadWorkspaceSettings(db)
  const next = { ...current, ...patch }
  const supportEmail = normalizedEmail(next.supportEmail)
  const outboundSender = normalizedEmail(next.outboundSender)
  if (supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(supportEmail)) throw new Error('Support email is invalid')
  if (outboundSender && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(outboundSender)) throw new Error('Outbound sender is invalid')
  const displayName = line(next.displayName, 'Display name', 120)
  const portalTitle = line(next.portalTitle, 'Portal title', 180)
  const logoUrl = optionalUrl(next.logoUrl, 'Logo URL')
  const faviconUrl = optionalUrl(next.faviconUrl, 'Favicon URL')
  const homeUrl = optionalUrl(next.homeUrl, 'Home URL')
  const portalBaseUrl = optionalUrl(next.portalBaseUrl, 'Portal base URL', true)
  const casePrefix = next.casePrefix.trim().toUpperCase()
  const locale = next.locale.trim()
  const timezone = next.timezone.trim()
  const accentColor = next.accentColor.toLowerCase()
  const canvasColor = next.canvasColor.toLowerCase()
  const inkColor = next.inkColor.toLowerCase()
  const senderChanged =
    supportEmail !== normalizedEmail(current.supportEmail) ||
    outboundSender !== normalizedEmail(current.outboundSender)
  const emailTestedAt = senderChanged ? null : current.emailTestedAt
  const publicIntakeEnabled = senderChanged ? false : next.publicIntakeEnabled
  if (publicIntakeEnabled && !emailTestedAt) {
    throw new Error('Public intake cannot be enabled until outbound email passes a setup test')
  }
  if (!/^[A-Z][A-Z0-9]{1,7}$/.test(casePrefix)) throw new Error('Case prefix must be 2-8 uppercase letters or digits')
  if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale)) throw new Error('Locale is invalid')
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format(new Date(0))
  } catch {
    throw new Error('Timezone is invalid')
  }
  if (!new Set(['system', 'humanist', 'geometric', 'rounded']).has(next.fontFamily)) throw new Error('Font family is invalid')
  if (!/^#[0-9a-f]{6}$/.test(accentColor) || !/^#[0-9a-f]{6}$/.test(canvasColor) || !/^#[0-9a-f]{6}$/.test(inkColor)) {
    throw new Error('Workspace colors must be six-digit hex values')
  }
  if (contrast(canvasColor, inkColor) < 4.5 || contrast(accentColor, canvasColor) < 3 || contrast(accentColor, inkColor) < 3) {
    throw new Error('Workspace colors do not meet the required contrast ratios')
  }
  const update = db.prepare(
    `UPDATE workspace_settings SET
       display_name = ?, portal_title = ?, logo_url = ?, favicon_url = ?, home_url = ?, support_email = ?,
       outbound_sender = ?, case_prefix = ?, locale = ?, timezone = ?, support_hours_json = ?,
       accent_color = ?, canvas_color = ?, ink_color = ?, font_family = ?, portal_base_url = ?,
       public_intake_enabled = ?, email_tested_at = ?,
       setup_completed_at = CASE WHEN ? = 1 THEN COALESCE(setup_completed_at, CURRENT_TIMESTAMP) ELSE setup_completed_at END,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = 1`,
  ).bind(
    displayName, portalTitle, logoUrl, faviconUrl, homeUrl,
    supportEmail, outboundSender,
    casePrefix, locale, timezone,
    JSON.stringify(next.supportHours), accentColor, canvasColor, inkColor,
    next.fontFamily, portalBaseUrl, publicIntakeEnabled ? 1 : 0, emailTestedAt, publicIntakeEnabled ? 1 : 0,
  )
  if (actor) {
    await db.batch([
      update,
      db.prepare(
        `INSERT INTO audit_events
           (id, actor_id, actor_kind, event_type, subject_type, subject_id, evidence_json)
         VALUES (?, ?, 'operator', 'workspace.settings_updated', 'workspace', '1', ?)`,
      ).bind(
        crypto.randomUUID(),
        actor.id,
        JSON.stringify({ changed: Object.keys(patch).sort(), emailValidationReset: senderChanged }),
      ),
    ])
  } else {
    await update.run()
  }
  return loadWorkspaceSettings(db)
}
