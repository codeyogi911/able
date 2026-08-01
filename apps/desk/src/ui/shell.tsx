import type { Child } from 'hono/jsx'

import type { Actor, CasePriority, CaseStatus, DeliveryState, OutboxState } from '../domain/types'

export type IdentityView = {
  displayName: string
  logoUrl?: string | null | undefined
  faviconUrl?: string | null | undefined
  homeUrl?: string | null | undefined
  locale?: string | undefined
  themeColor?: string | undefined
}

type DocumentProps = {
  title: string
  identity: IdentityView
  children: Child
  turnstile?: boolean
  floatingSupport?: boolean | undefined
}

function Brand({ identity }: { identity: IdentityView }) {
  const name = identity.displayName.trim() || 'Morrow Desk'
  const mark = name.slice(0, 2).toUpperCase()
  const logoUrl = safeLink(identity.logoUrl)
  const homeUrl = safeLink(identity.homeUrl)
  const content = (
    <span class="brand-lockup">
      {logoUrl ? (
        <img class="brand-logo" src={logoUrl} alt="" />
      ) : (
        <span class="brand-mark" aria-hidden="true">{mark}</span>
      )}
      <span class="brand-name">{name}</span>
    </span>
  )

  return homeUrl ? <a class="brand-link" href={homeUrl}>{content}</a> : content
}

function safeLink(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  if (value.startsWith('/') && !value.startsWith('//')) return value
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function safeLocale(value: string | undefined): string {
  return value && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(value) ? value : 'en'
}

export function PortalDocument({ title, identity, children, turnstile = false, floatingSupport = false }: DocumentProps) {
  const faviconUrl = safeLink(identity.faviconUrl)
  const themeColor = identity.themeColor && /^#[0-9a-f]{6}$/i.test(identity.themeColor) ? identity.themeColor : '#ffffff'
  return (
    <html lang={safeLocale(identity.locale)}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="color-scheme" content="light" />
        <meta name="theme-color" content={themeColor} />
        <title>{title}</title>
        {faviconUrl ? <link rel="icon" href={faviconUrl} /> : null}
        <link rel="stylesheet" href="/workspace-theme.css" />
        <link rel="stylesheet" href="/morrow.css" />
        {turnstile ? <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script> : null}
        <script src="/portal-search.js" defer></script>
      </head>
      <body>
        <a class="skip-link" href="#main">Skip to content</a>
        <header class="site-header">
          <div class="header-inner">
            <Brand identity={identity} />
            <nav class="site-nav" aria-label="Support navigation">
              <a href="/kb">Knowledge</a>
              <a href="/requests/new">Open a request</a>
              <a href="/requests/recover">Find a request</a>
            </nav>
          </div>
        </header>
        <main id="main">{children}</main>
        {floatingSupport ? <a class="floating-support" href="/">Chat with support</a> : null}
        <footer class="site-footer">
          <div class="footer-inner">
            <Brand identity={identity} />
            <span>Customer support, without an account.</span>
          </div>
        </footer>
      </body>
    </html>
  )
}

export function OpsDocument({ title, identity, actor, active, children }: Omit<DocumentProps, 'turnstile'> & { actor: Actor; active: 'queue' | 'conversations' | 'outbox' | 'status' | 'settings'; children: Child }) {
  return (
    <html lang={safeLocale(identity.locale)}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="color-scheme" content="dark" />
        <meta name="theme-color" content="#1d1d1b" />
        <title>{title}</title>
        <link rel="stylesheet" href="/workspace-theme.css" />
        <link rel="stylesheet" href="/ops.css" />
      </head>
      <body>
        <a class="skip-link" href="#ops-main">Skip to console</a>
        <div class="ops-shell">
          <aside class="ops-sidebar">
            <Brand identity={identity} />
            <div class="console-label">Recovery console</div>
            <nav class="ops-nav" aria-label="Operator console">
              <a aria-current={active === 'queue' ? 'page' : undefined} href="/ops">Queue</a>
              <a aria-current={active === 'conversations' ? 'page' : undefined} href="/ops/conversations">Inbox</a>
              <a aria-current={active === 'outbox' ? 'page' : undefined} href="/ops/outbox">Outbox</a>
              <a aria-current={active === 'status' ? 'page' : undefined} href="/ops/status">Status</a>
              <a aria-current={active === 'settings' ? 'page' : undefined} href="/ops/settings">Settings</a>
            </nav>
            <div class="operator-identity">
              <strong>{actor.name}</strong>
              <span>{actor.email}</span>
              <span class="role-label">{actor.role}</span>
            </div>
          </aside>
          <main id="ops-main" class="ops-main">{children}</main>
        </div>
      </body>
    </html>
  )
}

export function Notice({ tone = 'info', title, children }: { tone?: 'info' | 'success' | 'warning' | 'error'; title: string; children?: Child | undefined }) {
  return (
    <div class={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <strong>{title}</strong>
      {children ? <div>{children}</div> : null}
    </div>
  )
}

export function EmptyState({ eyebrow, title, children, action }: { eyebrow: string; title: string; children: Child; action?: Child | undefined }) {
  return (
    <section class="empty-state">
      <p class="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      <div class="empty-copy">{children}</div>
      {action ? <div class="empty-action">{action}</div> : null}
    </section>
  )
}

export function Field({ label, name, type = 'text', value, placeholder, helper, required = false, autocomplete, inputmode, minLength, maxLength }: {
  label: string
  name: string
  type?: string
  value?: string | undefined
  placeholder?: string | undefined
  helper?: string | undefined
  required?: boolean
  autocomplete?: string | undefined
  inputmode?: 'none' | 'text' | 'decimal' | 'numeric' | 'tel' | 'search' | 'email' | 'url' | undefined
  minLength?: number | undefined
  maxLength?: number | undefined
}) {
  const describedBy = helper ? `${name}-help` : undefined
  return (
    <div class="field">
      <label for={name}>{label}</label>
      <input
        id={name}
        name={name}
        type={type}
        value={value}
        placeholder={placeholder}
        required={required}
        autocomplete={autocomplete}
        inputmode={inputmode}
        minlength={minLength}
        maxlength={maxLength}
        aria-describedby={describedBy}
      />
      {helper ? <p class="field-help" id={describedBy}>{helper}</p> : null}
    </div>
  )
}

export function TextAreaField({ label, name, value, placeholder, helper, required = false, rows = 6, maxLength }: {
  label: string
  name: string
  value?: string | undefined
  placeholder?: string | undefined
  helper?: string | undefined
  required?: boolean
  rows?: number
  maxLength?: number | undefined
}) {
  const describedBy = helper ? `${name}-help` : undefined
  return (
    <div class="field">
      <label for={name}>{label}</label>
      <textarea id={name} name={name} placeholder={placeholder} required={required} rows={rows} maxlength={maxLength} aria-describedby={describedBy}>{value}</textarea>
      {helper ? <p class="field-help" id={describedBy}>{helper}</p> : null}
    </div>
  )
}

export function StatusPill({ value }: { value: CaseStatus | CasePriority | DeliveryState | OutboxState | 'unassigned' | 'ready' | 'blocked' | 'needs_attention' | 'handled' | 'delivery_problem' | 'support' | 'sales' }) {
  return <span class={`status-pill status-${value.replaceAll('_', '-')}`}>{humanize(value)}</span>
}

export function humanize(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function formatDate(value: string | null | undefined, locale = 'en', timezone?: string | undefined): string {
  if (!value) return 'Not yet'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timezone ? { timeZone: timezone } : {}),
  }
  try {
    return new Intl.DateTimeFormat(locale, options).format(date)
  } catch {
    return new Intl.DateTimeFormat('en', { ...options, timeZone: 'UTC' }).format(date)
  }
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`
}
