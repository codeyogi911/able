import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'

import type { AttachmentSummary, CustomerCapability, CustomerReceipt, Helpdesk, ResourceBody } from '../domain/types'
import {
  EmptyState,
  Field,
  Notice,
  PortalDocument,
  StatusPill,
  TextAreaField,
  formatBytes,
  formatDate,
} from '../ui/shell'
import { Markdown } from '../ui/markdown'
import type { PortalUploadBatch } from '../platform/files'
import type { WorkspaceSettingsView } from '../platform/contracts'
import { workspaceSupportName } from '../settings'

export type { WorkspaceSettingsView } from '../platform/contracts'

export type PublicArticleSummary = {
  slug: string
  title: string
  excerpt: string
  section: string
}

export type PublicArticle = PublicArticleSummary & {
  bodyMarkdown: string
  updatedAt: string
}

export type PublicKnowledge = {
  home(): Promise<{
    sections: Array<{ id: string; slug: string; name: string; description: string }>
    articles: PublicArticleSummary[]
  }>
  search(query: string): Promise<PublicArticleSummary[]>
  article(slug: string): Promise<PublicArticle | null>
}

export type PortalCategory = { id: string; name: string; description: string }

export type PublicWriteGuard = (input: {
  request: Request
  action: 'intake' | 'recovery' | 'customer_reply'
  turnstileToken: string
}) => Promise<{ ok: true } | { ok: false; message?: string }>

export type PortalDependencies = {
  helpdesk: Helpdesk
  settings: WorkspaceSettingsView
  knowledge: PublicKnowledge
  categories: PortalCategory[]
  verifyPublicWrite: PublicWriteGuard
  storeAttachments(files: File[], requestId: string): Promise<PortalUploadBatch>
  cleanupAttachments(storageKeys: string[]): Promise<void>
  customerResource(capability: CustomerCapability, uri: string): Promise<ResourceBody>
  voiceEnabled?: boolean
  ordersEnabled?: boolean
}

const PORTAL_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: https:",
  "style-src 'self'",
  "font-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  'frame-src https://challenges.cloudflare.com',
  "connect-src 'self' https://challenges.cloudflare.com",
].join('; ')

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/
const CAPABILITY_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/
const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9._~-]{1,160}$/
const CUSTOMER_SESSION_COOKIE = '__Host-able_case'
const CUSTOMER_SESSION_MAX_AGE = 60 * 60 * 24 * 30

const CAPABILITY_BOOTSTRAP_SCRIPT = `(() => {
  'use strict';
  const fragment = window.location.hash.slice(1);
  window.history.replaceState(null, '', '/requests/access');
  const recover = () => window.location.replace('/requests/recover?reason=private-link');
  let token = '';
  try { token = decodeURIComponent(fragment); } catch { return recover(); }
  if (!/^[A-Za-z0-9._~-]{16,512}$/.test(token)) return recover();
  fetch('/requests/session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-able-capability-exchange': '1' },
    body: JSON.stringify({ capability: token }),
  }).then((response) => {
    window.location.replace(response.ok ? '/requests/case' : '/requests/recover?reason=private-link');
  }).catch(recover);
})();`

type FormValues = {
  name?: string
  email?: string
  phone?: string
  subject?: string
  body?: string
  categoryId?: string
}

function clean(value: FormDataEntryValue | null, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function safeHex(value: string, fallback: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback
}

function safeHttpsOrPath(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  if (value.startsWith('/') && !value.startsWith('//')) return value
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' ? parsed.toString() : undefined
  } catch {
    return undefined
  }
}

function safeEmail(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase()
  return normalized && EMAIL_PATTERN.test(normalized) ? normalized : undefined
}

function identity(settings: WorkspaceSettingsView) {
  return {
    displayName: settings.displayName,
    logoUrl: safeHttpsOrPath(settings.logoUrl),
    faviconUrl: safeHttpsOrPath(settings.faviconUrl),
    homeUrl: safeHttpsOrPath(settings.homeUrl),
    locale: settings.locale,
    themeColor: safeHex(settings.canvasColor, '#ffffff'),
  }
}

function rgb(hex: string): [number, number, number] {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)]
}

function luminance(hex: string): number {
  const values = rgb(hex).map((channel) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * values[0]! + 0.7152 * values[1]! + 0.0722 * values[2]!
}

function contrast(first: string, second: string): number {
  const a = luminance(first)
  const b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function hexColor(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
}

function mixColor(first: string, second: string, amount: number): string {
  const from = rgb(first)
  const to = rgb(second)
  return hexColor(
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  )
}

function accessibleAccentText(accent: string, canvas: string, ink: string): string {
  if (contrast(accent, canvas) >= 4.5) return accent
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mixColor(accent, ink, step / 20)
    if (contrast(candidate, canvas) >= 4.5) return candidate
  }
  return ink
}

function accentForeground(accent: string, canvas: string, ink: string): string {
  return [ink, canvas, '#000000', '#ffffff']
    .map((color) => ({ color, score: contrast(color, accent) }))
    .sort((first, second) => second.score - first.score)[0]!.color
}

function footerSurface(accent: string): string {
  const muted = mixColor(accent, '#807786', 0.5)
  if (contrast(muted, '#ffffff') >= 4.5) return muted
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mixColor(muted, '#121212', step / 20)
    if (contrast(candidate, '#ffffff') >= 4.5) return candidate
  }
  return '#121212'
}

function themeCss(settings: WorkspaceSettingsView): string {
  const fonts: Record<WorkspaceSettingsView['fontFamily'], string> = {
    system: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    humanist: 'Optima, Candara, "Noto Sans", ui-sans-serif, system-ui, sans-serif',
    geometric: 'Avenir, "Avenir Next", Montserrat, ui-sans-serif, system-ui, sans-serif',
    rounded: 'Nunito, "Arial Rounded MT Bold", ui-sans-serif, system-ui, sans-serif',
  }

  const requestedCanvas = safeHex(settings.canvasColor, '#ffffff')
  const requestedInk = safeHex(settings.inkColor, '#121212')
  const canvas = contrast(requestedCanvas, requestedInk) >= 4.5 ? requestedCanvas : '#ffffff'
  const ink = contrast(canvas, requestedInk) >= 4.5 ? requestedInk : '#121212'
  const requestedAccent = safeHex(settings.accentColor, '#c87942')
  const accent = contrast(requestedAccent, canvas) >= 3 && contrast(requestedAccent, ink) >= 3 ? requestedAccent : '#c87942'
  const accentText = accessibleAccentText(accent, canvas, ink)
  const accentInk = accentForeground(accent, canvas, ink)
  const footer = footerSurface(accent)

  return `:root{--accent:${accent};--accent-text:${accentText};--accent-ink:${accentInk};--canvas:${canvas};--ink:${ink};--footer:${footer};--footer-ink:#ffffff;--font:${fonts[settings.fontFamily] ?? fonts.system};}`
}

function pageTitle(page: string, settings: WorkspaceSettingsView): string {
  return `${page} · ${settings.displayName}`
}

/**
 * Home page title. Appends "Support" to the workspace display name unless the
 * name already ends with the word (case-insensitive, word-boundary), so a
 * deployment named "Example Company Support" never renders "… Support Support".
 */
function supportTitle(settings: WorkspaceSettingsView): string {
  return workspaceSupportName(settings.displayName.trim() || 'Able Desk')
}

function Turnstile({ settings, action }: { settings: WorkspaceSettingsView; action: 'intake' | 'recover' | 'reply' }) {
  return settings.turnstileSiteKey ? (
    <div class="turnstile-wrap">
      <div class="cf-turnstile" data-sitekey={settings.turnstileSiteKey} data-action={action} data-theme="light"></div>
      <p class="field-help">The check helps us stop automated spam.</p>
    </div>
  ) : (
    <input type="hidden" name="cf-turnstile-response" value="" />
  )
}

function SearchForm({ query = '', compact = false }: {
  query?: string
  compact?: boolean
}) {
  const inputId = compact ? 'kb-query-compact' : 'kb-query'
  return (
    <form
      class={compact ? 'search-form search-form-compact' : 'search-form'}
      action="/kb"
      method="get"
      role="search"
      data-search-enhance="1"
    >
      <label for={inputId}>Search the knowledge base</label>
      <div class="search-control">
        <svg class="search-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.4-3.4"></path></svg>
        <input
          id={inputId}
          type="search"
          name="q"
          value={query}
          placeholder="Search help articles"
          autocomplete="off"
          maxlength={160}
          required
        />
        <kbd class="search-kbd" aria-hidden="true" hidden>⌘K</kbd>
        <button type="submit">Search</button>
      </div>
    </form>
  )
}

function ArticleList({ articles }: { articles: PublicArticleSummary[] }) {
  return (
    <ol class="article-list">
      {articles.map((article) => (
        <li>
          <a href={`/kb/${encodeURIComponent(article.slug)}`}>
            <span class="article-section">{article.section}</span>
            <strong>{article.title}</strong>
            <span>{article.excerpt || 'Open this article for the full answer.'}</span>
          </a>
        </li>
      ))}
    </ol>
  )
}

function TopicList({ sections, articles }: {
  sections: Array<{ id: string; slug: string; name: string; description: string }>
  articles: PublicArticleSummary[]
}) {
  return (
    <ol class="topic-grid">
      {sections.map((section) => {
        const featured = articles.filter((article) => article.section === section.name).slice(0, 3)
        return (
          <li class="topic-card">
            <h3><a href={`/kb?section=${encodeURIComponent(section.slug)}`}>{section.name}</a></h3>
            {section.description ? <p>{section.description}</p> : null}
            {featured.length > 0 ? (
              <ul>
                {featured.map((article) => <li><a href={`/kb/${encodeURIComponent(article.slug)}`}>{article.title}</a></li>)}
              </ul>
            ) : <p class="topic-empty">Articles are being prepared.</p>}
            <a class="topic-more" href={`/kb?section=${encodeURIComponent(section.slug)}`}>View topic</a>
          </li>
        )
      })}
    </ol>
  )
}

function ProblemPage({ settings, title, message, status = 400, backHref = '/' }: {
  settings: WorkspaceSettingsView
  title: string
  message: string
  status?: number
  backHref?: string
}) {
  return {
    status,
    body: (
      <PortalDocument title={pageTitle(title, settings)} identity={identity(settings)}>
        <section class="page-frame narrow-frame problem-page">
          <p class="eyebrow">Please check your request</p>
          <h1>{title}</h1>
          <p>{message}</p>
          <a class="button button-secondary" href={backHref}>Go back</a>
        </section>
      </PortalDocument>
    ),
  }
}

function RequestForm({ settings, categories, suggestions, values = {}, error }: {
  settings: WorkspaceSettingsView
  categories: PortalCategory[]
  suggestions: PublicArticleSummary[]
  values?: FormValues
  error?: string
}) {
  const intakeReady = settings.publicIntakeEnabled && settings.emailReady
  const requestId = crypto.randomUUID()
  return (
    <PortalDocument title={pageTitle('Open a request', settings)} identity={identity(settings)} turnstile={Boolean(settings.turnstileSiteKey)}>
      <section class="request-layout page-frame">
        <div class="request-intro reveal">
          <p class="eyebrow">Customer support</p>
          <h1>Tell us what happened.</h1>
          <p>Share the useful detail once. Your private link will keep the complete conversation together—no account or password needed.</p>
          <div class="privacy-note">
            <strong>Your link is the key.</strong>
            <span>Anyone with it can read the request, so keep it private.</span>
          </div>
          <form class="suggestion-search" action="/requests/new" method="get" role="search">
            <label for="suggestion-query">Check for a quick answer first</label>
            <div class="search-control">
              <input id="suggestion-query" type="search" name="q" placeholder="A few words about the problem" maxlength={160} />
              <button class="button-secondary" type="submit">Find answers</button>
            </div>
          </form>
          {suggestions.length > 0 ? (
            <div class="suggestions" aria-labelledby="suggestions-title">
              <h2 id="suggestions-title">These may solve it now</h2>
              <ArticleList articles={suggestions.slice(0, 3)} />
            </div>
          ) : null}
        </div>
        <div class="request-form-wrap reveal reveal-late">
          {!intakeReady ? (
            <Notice tone="warning" title="New requests are temporarily paused">
              Magic-link email must pass its delivery test before this form can open a request.
              {safeEmail(settings.supportEmail) ? <> You can email <a href={`mailto:${safeEmail(settings.supportEmail)}`}>{safeEmail(settings.supportEmail)}</a>.</> : null}
            </Notice>
          ) : null}
          {error ? <Notice tone="error" title="We could not open this request">{error}</Notice> : null}
          <form class="stacked-form" action="/requests" method="post" enctype="multipart/form-data" aria-label="Open a support request">
            <input type="hidden" name="request_id" value={requestId} />
            <div class="form-pair">
              <Field label="Your name" name="name" value={values.name} autocomplete="name" required maxLength={120} />
              <Field label="Email" name="email" type="email" value={values.email} autocomplete="email" inputmode="email" helper="We send your private case link here." required maxLength={254} />
            </div>
            <Field label="Phone (optional)" name="phone" type="tel" value={values.phone} autocomplete="tel" inputmode="tel" maxLength={40} />
            {categories.length > 0 ? (
              <div class="field">
                <label for="category_id">What is this about?</label>
                <select id="category_id" name="category_id">
                  <option value="">Choose a category</option>
                  {categories.map((category) => <option value={category.id} selected={values.categoryId === category.id}>{category.name}</option>)}
                </select>
                <p class="field-help">Choosing the closest category helps the right person find it.</p>
              </div>
            ) : null}
            <Field label="Subject" name="subject" value={values.subject} placeholder="A short description of the problem" required minLength={4} maxLength={200} />
            <TextAreaField label="What happened?" name="body" value={values.body} placeholder="Include what you expected, what happened, and any useful reference." helper="Do not include passwords, card numbers, or other secrets." required rows={8} maxLength={10000} />
            <div class="field">
              <label for="attachments">Attachments (optional)</label>
              <input id="attachments" name="attachments" type="file" multiple accept="image/*,.pdf,.txt,.log" />
              <p class="field-help">Up to 4 files, 10 MB each and 20 MB total. Images, PDF, text, and logs are accepted.</p>
            </div>
            <Turnstile settings={settings} action="intake" />
            <button type="submit" disabled={!intakeReady}>Open my request</button>
          </form>
        </div>
      </section>
    </PortalDocument>
  )
}

function AttachmentLinks({ attachments }: { attachments: AttachmentSummary[] }) {
  if (attachments.length === 0) return null
  return (
    <ul class="attachment-list" aria-label="Attachments">
      {attachments.map((attachment) => (
        <li>
          <a href={`/requests/attachments/${encodeURIComponent(attachment.id)}`} target="_blank" rel="noreferrer">
            <span>{attachment.filename}</span>
            <small>{formatBytes(attachment.size)}</small>
          </a>
        </li>
      ))}
    </ul>
  )
}

function capabilityValid(token: string): boolean {
  return CAPABILITY_PATTERN.test(token)
}

function exchangeRequestIsSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin || origin !== new URL(request.url).origin) return false
  const fetchSite = request.headers.get('sec-fetch-site')
  return !fetchSite || fetchSite === 'same-origin'
}

function contentDisposition(filename: string | undefined): string | undefined {
  if (!filename) return undefined
  const safe = filename.replace(/[\r\n"\\]/g, '_').slice(0, 180)
  return `attachment; filename="${safe}"`
}

function resourceResponse(c: { body(body: BodyInit | null, status?: number, headers?: Record<string, string>): Response }, resource: ResourceBody) {
  const headers: Record<string, string> = {
    'content-type': resource.contentType || 'application/octet-stream',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  }
  const disposition = contentDisposition(resource.filename)
  if (disposition) headers['content-disposition'] = disposition
  return c.body(resource.body as BodyInit, 200, headers)
}

export function createPortalRoutes(deps: PortalDependencies): Hono {
  const app = new Hono()
  const { helpdesk, settings, knowledge } = deps

  app.use('*', async (c, next) => {
    await next()
    c.header('Content-Security-Policy', PORTAL_CSP)
    c.header('Referrer-Policy', 'no-referrer')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('X-Frame-Options', 'DENY')
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
    if (c.req.path.startsWith('/requests')) c.header('Cache-Control', 'private, no-store')
  })

  app.get('/workspace-theme.css', (c) => c.body(themeCss(settings), 200, {
    'content-type': 'text/css; charset=utf-8',
    'cache-control': 'no-store',
  }))

  app.get('/', async (c) => {
    const content = await knowledge.home()
    return c.html(
      <PortalDocument title={supportTitle(settings)} identity={identity(settings)} floatingSupport={deps.voiceEnabled}>
        <section class="home-hero page-frame reveal">
          <h1>{settings.portalTitle}</h1>
          <p class="lede">Find quick answers, explore practical guides, or talk to the support team.</p>
          <SearchForm />
          {content.articles.length > 0 ? (
            <nav class="search-suggestions" aria-label="Popular articles">
              <span class="search-suggestions-label">Popular:</span>
              {content.articles.slice(0, 3).map((article) => (
                <a class="suggestion-chip" href={`/kb/${encodeURIComponent(article.slug)}`}>{article.title}</a>
              ))}
            </nav>
          ) : null}
        </section>
        <section class="knowledge-preview page-frame" aria-labelledby="topics-title">
          <div class="section-heading">
            <h2 id="topics-title">Browse by topic</h2>
            <a class="text-link" href="/kb">Browse all knowledge</a>
          </div>
          {content.sections.length > 0 ? (
            <TopicList sections={content.sections} articles={content.articles} />
          ) : (
            <EmptyState eyebrow="Knowledge base" title="Articles are being prepared." action={<a class="button" href="/requests/new">Open a request</a>}>
              You can still open a request. Published answers will appear here as soon as they are ready.
            </EmptyState>
          )}
        </section>
        <aside class="support-band page-frame reveal reveal-late" aria-label="Contact support">
          <h2>Still need help?</h2>
          <div class="support-cards">
            {deps.voiceEnabled ? (
              <div class="action-card">
                <h3>Chat with support</h3>
                <p>
                  {deps.ordersEnabled
                    ? 'Ask our assistant anything — instant answers from the help articles, order lookups, and tickets when you need the team.'
                    : 'Ask our assistant anything — instant answers from the help articles and tickets when you need the team.'}
                </p>
                <a class="text-link" href="/">Chat with support</a>
              </div>
            ) : null}
            <div class="action-card">
              <h3>Open a request</h3>
              <p>Send the detail once. A private link keeps the whole conversation together—no account needed.</p>
              <a class="text-link" href="/requests/new">Open a request</a>
            </div>
            <div class="action-card">
              <h3>Find a request</h3>
              <p>Lost your private link? Ask for a fresh one with your email and case reference.</p>
              <a class="text-link" href="/requests/recover">Find a request</a>
            </div>
          </div>
        </aside>
      </PortalDocument>,
    )
  })

  app.get('/kb/search.json', async (c) => {
    const query = (c.req.query('q') ?? '').trim().slice(0, 160)
    const articles = query.length >= 2 ? await knowledge.search(query) : []
    return c.json(
      {
        results: articles.slice(0, 8).map((article) => ({
          slug: article.slug,
          title: article.title,
          excerpt: article.excerpt,
          section: article.section,
          url: `/kb/${encodeURIComponent(article.slug)}`,
        })),
      },
      200,
      { 'cache-control': 'private, no-store' },
    )
  })

  app.get('/kb', async (c) => {
    const query = (c.req.query('q') ?? '').trim().slice(0, 160)
    const section = (c.req.query('section') ?? '').trim().slice(0, 100)
    const home = !query || section ? await knowledge.home() : null
    let articles = query ? await knowledge.search(query) : (home?.articles ?? [])
    if (section) {
      const selectedSection = home?.sections.find((candidate) => candidate.slug.toLowerCase() === section.toLowerCase())
      articles = selectedSection ? articles.filter((article) => article.section === selectedSection.name) : []
    }

    return c.html(
      <PortalDocument title={pageTitle(query ? `Search: ${query}` : 'Knowledge', settings)} identity={identity(settings)} floatingSupport={deps.voiceEnabled}>
        <section class="kb-layout page-frame">
          <header class="kb-heading reveal">
            <p class="eyebrow">Knowledge base</p>
            <h1>{query ? 'Search results' : 'Start with a known answer.'}</h1>
            <SearchForm query={query} compact />
          </header>
          <div class="kb-results reveal reveal-late">
            {query ? <p class="result-count">{articles.length} {articles.length === 1 ? 'answer' : 'answers'} for “{query}”</p> : null}
            {articles.length > 0 ? (
              <ArticleList articles={articles} />
            ) : (
              <EmptyState eyebrow="No close match" title="Try fewer, more concrete words." action={<a class="button" href="/requests/new">Open a request</a>}>
                Search for the product, action, or error you can see. If nothing fits, send the team the detail once.
              </EmptyState>
            )}
          </div>
        </section>
      </PortalDocument>,
    )
  })

  app.get('/kb/:slug', async (c) => {
    const article = await knowledge.article(c.req.param('slug'))
    if (!article) {
      const problem = ProblemPage({ settings, title: 'Article not found', message: 'This article may have moved or is no longer published.', status: 404, backHref: '/kb' })
      return c.html(problem.body, problem.status as 404)
    }
    return c.html(
      <PortalDocument title={pageTitle(article.title, settings)} identity={identity(settings)} floatingSupport={deps.voiceEnabled}>
        <article class="article-page page-frame">
          <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/kb">Knowledge</a><span>{article.section}</span></nav>
          <header>
            <p class="eyebrow">{article.section}</p>
            <h1>{article.title}</h1>
            {article.excerpt ? <p class="lede">{article.excerpt}</p> : null}
            <p class="article-updated">Updated {formatDate(article.updatedAt, settings.locale, settings.timezone)}</p>
          </header>
          <Markdown body={article.bodyMarkdown} />
          <aside class="article-next">
            <div><strong>Still need help?</strong><span>Start a private request and link this article in your message.</span></div>
            <a class="button" href="/requests/new">Open a request</a>
          </aside>
        </article>
      </PortalDocument>,
    )
  })

  app.get('/requests/new', async (c) => {
    const query = (c.req.query('q') ?? '').trim().slice(0, 160)
    const suggestions = query ? await knowledge.search(query) : []
    return c.html(<RequestForm settings={settings} categories={deps.categories} suggestions={suggestions} />)
  })

  app.post('/requests', async (c) => {
    if (!settings.publicIntakeEnabled || !settings.emailReady) {
      return c.html(<RequestForm settings={settings} categories={deps.categories} suggestions={[]} />, 503)
    }

    const declaredLength = Number(c.req.header('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > 21 * 1024 * 1024) {
      return c.html(<RequestForm settings={settings} categories={deps.categories} suggestions={[]} error="The upload is larger than the 20 MB request limit." />, 413)
    }

    const form = await c.req.formData()
    const values: FormValues = {
      name: clean(form.get('name'), 120),
      email: clean(form.get('email'), 254).toLowerCase(),
      phone: clean(form.get('phone'), 40),
      subject: clean(form.get('subject'), 200),
      body: clean(form.get('body'), 10000),
      categoryId: clean(form.get('category_id'), 100),
    }
    const requestId = clean(form.get('request_id'), 128)
    const turnstileToken = clean(form.get('cf-turnstile-response'), 4096)
    const suggestions = values.subject ? await knowledge.search(`${values.subject} ${values.body ?? ''}`.slice(0, 160)) : []

    if (!values.name || values.name.length < 2 || !values.email || !EMAIL_PATTERN.test(values.email) || !values.subject || values.subject.length < 4 || !values.body || values.body.length < 8 || !REQUEST_ID_PATTERN.test(requestId)) {
      return c.html(<RequestForm settings={settings} categories={deps.categories} suggestions={suggestions} values={values} error="Check your name, email, subject, and description, then try again." />, 400)
    }

    if (values.categoryId && !deps.categories.some((category) => category.id === values.categoryId)) {
      return c.html(<RequestForm settings={settings} categories={deps.categories} suggestions={suggestions} values={values} error="Choose one of the available categories." />, 400)
    }

    const guard = await deps.verifyPublicWrite({ request: c.req.raw, action: 'intake', turnstileToken })
    if (!guard.ok) {
      return c.html(<RequestForm settings={settings} categories={deps.categories} suggestions={suggestions} values={values} error={guard.message ?? 'Complete the anti-spam check and try again.'} />, 400)
    }

    const files = form.getAll('attachments').filter((entry): entry is File => typeof entry !== 'string' && entry.size > 0)
    if (files.length > 4 || files.some((file) => file.size > 10 * 1024 * 1024) || files.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) {
      return c.html(<RequestForm settings={settings} categories={deps.categories} suggestions={suggestions} values={values} error="Use no more than 4 files, keep each under 10 MB, and keep the total under 20 MB." />, 413)
    }
    const staged = files.length > 0
      ? await deps.storeAttachments(files, requestId)
      : { attachments: [], createdStorageKeys: [] }
    let receipt: CustomerReceipt
    try {
      receipt = await helpdesk.intake(
        { kind: 'portal', requestId },
        {
          name: values.name,
          email: values.email,
          ...(values.phone ? { phone: values.phone } : {}),
          subject: values.subject,
          body: values.body,
          ...(values.categoryId ? { categoryId: values.categoryId } : {}),
          ...(staged.attachments.length > 0 ? { attachments: staged.attachments } : {}),
        },
      )
    } catch (error) {
      try {
        await deps.cleanupAttachments(staged.createdStorageKeys)
      } catch {
        // Keep the intake error. Cleanup is conservative and can be retried by
        // the operator after checking that no committed attachment references it.
      }
      throw error
    }

    return c.html(
      <PortalDocument title={pageTitle('Request received', settings)} identity={identity(settings)}>
        <section class="page-frame narrow-frame receipt-page">
          <p class="eyebrow">Request {receipt.caseRef}</p>
          <h1>We have the detail.</h1>
          <p>{receipt.delivery
            ? 'A private case link is queued for your email. Provider acceptance is not the same as inbox delivery, so keep this page until the message arrives.'
            : settings.recoveryEmailEnabled !== false
              ? 'Email notification is disabled for this event. Keep your case reference and use the recovery form if you need a private link.'
              : 'Email notifications are disabled for this event. Keep your case reference and contact support if you need a private link.'}</p>
          {receipt.delivery ? <div class="receipt-status"><StatusPill value={receipt.delivery} /><span>Email state</span></div> : null}
          <a class="text-link" href="/">Return to help centre</a>
        </section>
      </PortalDocument>,
      201,
    )
  })

  app.get('/requests/recover', (c) => {
    const prefilledRef = clean(c.req.query('ref') ?? null, 40).toUpperCase()
    const recoveryReady = settings.emailReady && settings.recoveryEmailEnabled !== false
    return c.html(
      <PortalDocument title={pageTitle('Find a request', settings)} identity={identity(settings)} turnstile={Boolean(settings.turnstileSiteKey)}>
        <section class="page-frame recovery-layout">
          <div>
            <p class="eyebrow">Lost-link recovery</p>
            <h1>Ask for a fresh private link.</h1>
            <p class="lede">Use the email from your request and its case reference. We give the same answer whether or not the details match.</p>
          </div>
          <form class="stacked-form recovery-form" action="/requests/recover" method="post">
            {!recoveryReady ? <Notice tone="warning" title="Recovery email is temporarily paused">A fresh link cannot be sent while recovery notifications or outbound delivery are disabled.</Notice> : null}
            <input type="hidden" name="request_id" value={crypto.randomUUID()} />
            <Field label="Email" name="email" type="email" autocomplete="email" inputmode="email" required maxLength={254} />
            <Field label="Case reference" name="ref" value={prefilledRef || undefined} placeholder={`${settings.casePrefix}-42`} helper="You can find this in the original confirmation email." required maxLength={40} />
            <Turnstile settings={settings} action="recover" />
            <button type="submit" disabled={!recoveryReady}>Send a fresh link</button>
          </form>
        </section>
      </PortalDocument>,
    )
  })

  app.post('/requests/recover', async (c) => {
    if (!settings.emailReady || settings.recoveryEmailEnabled === false) {
      const problem = ProblemPage({ settings, title: 'Recovery email is temporarily paused', message: 'A fresh link cannot be sent while recovery notifications or outbound delivery are disabled. Try again later.', status: 503, backHref: '/' })
      return c.html(problem.body, 503)
    }
    const form = await c.req.formData()
    const email = clean(form.get('email'), 254).toLowerCase()
    const ref = clean(form.get('ref'), 40).toUpperCase()
    const requestId = clean(form.get('request_id'), 128)
    const turnstileToken = clean(form.get('cf-turnstile-response'), 4096)

    if (!EMAIL_PATTERN.test(email) || !ref || !REQUEST_ID_PATTERN.test(requestId)) {
      const problem = ProblemPage({ settings, title: 'Check the recovery details', message: 'Enter a valid email, case reference, and submit the form again.', status: 400, backHref: '/requests/recover' })
      return c.html(problem.body, 400)
    }
    const guard = await deps.verifyPublicWrite({ request: c.req.raw, action: 'recovery', turnstileToken })
    if (!guard.ok) {
      const problem = ProblemPage({ settings, title: 'Complete the security check', message: guard.message ?? 'Complete the anti-spam check and try again.', status: 400, backHref: '/requests/recover' })
      return c.html(problem.body, 400)
    }

    try {
      await helpdesk.customer({ token: '' }, { kind: 'recover', email, ref, requestId })
    } catch {
      // Recovery is deliberately non-enumerating, including transient lookup failures.
    }

    return c.html(
      <PortalDocument title={pageTitle('Check your email', settings)} identity={identity(settings)}>
        <section class="page-frame narrow-frame receipt-page">
          <p class="eyebrow">Recovery requested</p>
          <h1>Check your email.</h1>
          <p>If those details match a request, a fresh private link will be sent. For privacy, we cannot confirm a match on this page.</p>
          <a class="button button-secondary" href="/">Return to help centre</a>
        </section>
      </PortalDocument>,
      202,
    )
  })

  app.get('/requests/capability-bootstrap.js', (c) => c.body(CAPABILITY_BOOTSTRAP_SCRIPT, 200, {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'public, max-age=86400',
  }))

  app.get('/requests/access', (c) => c.html(
    <PortalDocument title={pageTitle('Opening private request', settings)} identity={identity(settings)}>
      <section class="page-frame narrow-frame receipt-page" aria-live="polite">
        <p class="eyebrow">Private request</p>
        <h1>Opening your conversation…</h1>
        <p>The private key is removed from the address before it is exchanged for a locked browser session.</p>
        <noscript><p>JavaScript is required to open this private link safely. You can request a fresh link below.</p></noscript>
        <a class="text-link" href="/requests/recover">Request a fresh link</a>
        <script src="/requests/capability-bootstrap.js" defer></script>
      </section>
    </PortalDocument>,
  ))

  app.post('/requests/session', async (c) => {
    const request = c.req.raw
    if (
      !exchangeRequestIsSameOrigin(request)
      || request.headers.get('x-able-capability-exchange') !== '1'
      || !request.headers.get('content-type')?.toLowerCase().startsWith('application/json')
    ) {
      return c.body(null, 400)
    }
    const declaredLength = Number(request.headers.get('content-length') ?? '0')
    if (Number.isFinite(declaredLength) && declaredLength > 1_024) return c.body(null, 413)
    const raw = await request.text()
    if (raw.length > 1_024) return c.body(null, 413)
    let token = ''
    try {
      const parsed = JSON.parse(raw) as { capability?: unknown }
      token = typeof parsed.capability === 'string' ? parsed.capability : ''
    } catch {
      return c.body(null, 400)
    }
    if (!capabilityValid(token)) return c.body(null, 404)
    const result = await helpdesk.customer({ token }, { kind: 'view' })
    if (!result.case) return c.body(null, 404)
    setCookie(c, CUSTOMER_SESSION_COOKIE, token, {
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
      maxAge: CUSTOMER_SESSION_MAX_AGE,
    })
    return c.body(null, 204)
  })

  app.get('/requests/attachments/:attachmentId', async (c) => {
    const token = getCookie(c, CUSTOMER_SESSION_COOKIE) ?? ''
    const attachmentId = c.req.param('attachmentId')
    if (!capabilityValid(token) || !ATTACHMENT_ID_PATTERN.test(attachmentId)) return c.notFound()
    try {
      const resource = await deps.customerResource({ token }, `able://attachments/${attachmentId}`)
      return resourceResponse(c, resource)
    } catch {
      return c.notFound()
    }
  })

  app.get('/requests/case', async (c) => {
    const token = getCookie(c, CUSTOMER_SESSION_COOKIE) ?? ''
    if (!capabilityValid(token)) {
      const problem = ProblemPage({ settings, title: 'Private link unavailable', message: 'This link is incomplete, expired, or no longer available. Request a fresh link to continue.', status: 404, backHref: '/requests/recover' })
      return c.html(problem.body, 404)
    }
    const result = await helpdesk.customer({ token }, { kind: 'view' })
    if (!result.case) {
      deleteCookie(c, CUSTOMER_SESSION_COOKIE, { path: '/', secure: true })
      const problem = ProblemPage({ settings, title: 'Private link unavailable', message: 'This link is incomplete, expired, or no longer available. Request a fresh link to continue.', status: 404, backHref: '/requests/recover' })
      return c.html(problem.body, 404)
    }
    const item = result.case
    const publicThread = item.thread.filter((entry) => entry.visibility === 'public')

    return c.html(
      <PortalDocument title={pageTitle(item.ref, settings)} identity={identity(settings)} turnstile={Boolean(settings.turnstileSiteKey)}>
        <section class="case-page page-frame">
          <header class="case-header">
            <div>
              <p class="eyebrow">Request {item.ref}</p>
              <h1>{item.subject}</h1>
              <p>Opened {formatDate(item.openedAt, settings.locale, settings.timezone)}</p>
            </div>
            <div class="case-state"><StatusPill value={item.status} /><StatusPill value={item.priority} /></div>
          </header>
          {item.deliveryWarnings.length > 0 ? <Notice tone="warning" title="Delivery needs attention">{item.deliveryWarnings.join(' ')}</Notice> : null}
          <div class="thread" aria-label="Case conversation">
            {publicThread.length > 0 ? publicThread.map((message) => (
              <article class={`thread-entry thread-${message.direction}`}>
                <header><strong>{message.author}</strong><time datetime={message.createdAt}>{formatDate(message.createdAt, settings.locale, settings.timezone)}</time></header>
                <div class="message-body">{message.body}</div>
                <AttachmentLinks attachments={message.attachments} />
                {message.delivery ? <div class="message-delivery"><StatusPill value={message.delivery} /></div> : null}
              </article>
            )) : (
              <EmptyState eyebrow="Conversation" title="No public messages yet.">The support team will add replies here.</EmptyState>
            )}
          </div>
          {item.status === 'closed' ? (
            <Notice tone="info" title="This request is closed">Closed requests cannot receive new replies. Open a new request if you need more help.</Notice>
          ) : (
            <form class="stacked-form customer-reply" action="/requests/case" method="post">
              <input type="hidden" name="request_id" value={crypto.randomUUID()} />
              <TextAreaField label="Add a reply" name="body" placeholder="Write the detail the support team needs next." required rows={6} maxLength={10000} />
              <Turnstile settings={settings} action="reply" />
              <button type="submit">Send reply</button>
            </form>
          )}
        </section>
      </PortalDocument>,
    )
  })

  app.post('/requests/case', async (c) => {
    const token = getCookie(c, CUSTOMER_SESSION_COOKIE) ?? ''
    if (!capabilityValid(token)) return c.notFound()
    const form = await c.req.formData()
    const body = clean(form.get('body'), 10000)
    const requestId = clean(form.get('request_id'), 128)
    const turnstileToken = clean(form.get('cf-turnstile-response'), 4096)
    if (body.length < 2 || !REQUEST_ID_PATTERN.test(requestId)) {
      const problem = ProblemPage({ settings, title: 'Reply not sent', message: 'Write a reply and try again.', status: 400, backHref: '/requests/case' })
      return c.html(problem.body, 400)
    }
    const guard = await deps.verifyPublicWrite({ request: c.req.raw, action: 'customer_reply', turnstileToken })
    if (!guard.ok) {
      const problem = ProblemPage({ settings, title: 'Reply not sent', message: guard.message ?? 'Complete the anti-spam check and try again.', status: 400, backHref: '/requests/case' })
      return c.html(problem.body, 400)
    }
    const result = await helpdesk.customer({ token }, { kind: 'reply', body, requestId })
    if (!result.accepted) {
      const problem = ProblemPage({ settings, title: 'Reply not accepted', message: 'This request may be closed or the private link may have expired.', status: 409, backHref: '/requests/recover' })
      return c.html(problem.body, 409)
    }
    return c.html(
      <PortalDocument title={pageTitle('Reply received', settings)} identity={identity(settings)}>
        <section class="page-frame narrow-frame receipt-page">
          <p class="eyebrow">Reply received</p>
          <h1>Your message is in the conversation.</h1>
          <p>You can close this page. Use the same private link to return when the team replies.</p>
        </section>
      </PortalDocument>,
      202,
    )
  })

  app.get('/portal/en/home', (c) => c.redirect('/', 308))
  app.get('/portal/en/kb', (c) => c.redirect('/kb', 308))
  app.get('/portal/en/newticket', (c) => c.redirect('/requests/new', 308))
  app.get('/portal/en/myarea', (c) => c.redirect('/requests/recover', 308))
  app.get('/portal/:locale/kb/articles/:slug', (c) => c.redirect(`/kb/${encodeURIComponent(c.req.param('slug'))}`, 308))

  app.onError((error, c) => {
    const problem = ProblemPage({ settings, title: 'Something went wrong', message: 'The support page could not complete that request. Try again in a moment.', status: 500 })
    void error
    return c.html(problem.body, 500)
  })

  return app
}
