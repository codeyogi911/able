import type { OutboxState } from '../domain/types'

export type PortalBranding = {
  displayName: string
  portalTitle: string
  logoUrl: string | null
  faviconUrl: string | null
  homeUrl: string | null
  accentColor: string
  canvasColor: string
  inkColor: string
  fontFamily: 'system' | 'humanist' | 'geometric' | 'rounded'
}

export type WorkspaceSettingsView = PortalBranding & {
  supportEmail?: string | null
  outboundSender: string | null
  portalBaseUrl: string | null
  casePrefix: string
  locale: string
  timezone: string
  publicIntakeEnabled: boolean
  emailReady: boolean
  recoveryEmailEnabled?: boolean
  turnstileSiteKey?: string | null
}

export type WorkspaceSettingsPatch = PortalBranding & {
  supportEmail: string | null
  outboundSender: string | null
  portalBaseUrl: string | null
  casePrefix: string
  locale: string
  timezone: string
  publicIntakeEnabled: boolean
}

export type PortalCustomization = PortalBranding & {
  schemaVersion: 'portal-customization.v1'
  customCssSupported: false
}

export type PortalCustomizationPatch = Partial<PortalBranding>

export type OpsDiagnostics = {
  setup: {
    accessReady: boolean
    securityReady: boolean
    emailReady: boolean
    intakeEnabled: boolean
    lastEmailTestAt: string | null
  }
  outbox: Array<{
    id: string
    caseRef?: string | null
    kind: string
    recipient: string
    state: OutboxState
    attempts: number
    nextAttemptAt: string
    lastError?: string | null
    updatedAt: string
  }>
  operators: Array<{
    id: string
    name: string
    email: string
    role: 'admin' | 'agent'
    active: boolean
  }>
}
