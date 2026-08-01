import { Hono } from 'hono'
import type { Child } from 'hono/jsx'

import type {
  Actor,
  CasePriority,
  CaseStatus,
  CaseWorkspace,
  DeliveryState,
  Helpdesk,
  OutboxState,
  QueueResult,
  ResourceBody,
  SearchResult,
} from '../domain/types'
import type { Communications, ConversationQueue, ConversationWorkspace } from '../communications'
import type { OpsDiagnostics, WorkspaceSettingsPatch, WorkspaceSettingsView } from '../platform/contracts'
import {
  EmptyState,
  Field,
  Notice,
  OpsDocument,
  StatusPill,
  TextAreaField,
  formatBytes,
  formatDate,
  humanize,
} from '../ui/shell'

export type { OpsDiagnostics, WorkspaceSettingsPatch } from '../platform/contracts'

export type OpsDependencies = {
  helpdesk: Helpdesk
  communications?: Communications
  actor: Actor
  settings: WorkspaceSettingsView
  diagnostics(): Promise<OpsDiagnostics>
  verifyOperatorWrite(request: Request): Promise<boolean>
  updateSettings?: (actor: Actor, patch: WorkspaceSettingsPatch) => Promise<void>
  updateOperatorRole?: (actor: Actor, operatorId: string, role: 'admin' | 'agent') => Promise<void>
  queueEmailTest?: (actor: Actor, recipient: string) => Promise<void>
}

const OPS_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: https:",
  "media-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
].join('; ')

const STATUSES: CaseStatus[] = ['open', 'waiting_on_customer', 'on_hold', 'resolved', 'closed']
const PRIORITIES: CasePriority[] = ['low', 'normal', 'high', 'urgent']
const FONT_FAMILIES: WorkspaceSettingsView['fontFamily'][] = ['system', 'humanist', 'geometric', 'rounded']
const DELIVERY_STATES: OutboxState[] = ['queued', 'sending', 'accepted', 'blocked', 'failed', 'indeterminate']

function identity(settings: WorkspaceSettingsView) {
  return { displayName: settings.displayName, logoUrl: settings.logoUrl, homeUrl: settings.homeUrl, locale: settings.locale }
}

function clean(value: FormDataEntryValue | null, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

type QueueView = QueueResult | SearchResult

function isQueue(value: CaseWorkspace | QueueResult | SearchResult): value is QueueView {
  return value.kind === 'queue' || value.kind === 'search'
}

function isCase(value: CaseWorkspace | QueueResult | SearchResult): value is CaseWorkspace {
  return value.kind === 'case'
}

function queueAge(openedAt: string): string {
  const started = new Date(openedAt).getTime()
  if (!Number.isFinite(started)) return 'Unknown age'
  const minutes = Math.max(0, Math.floor((Date.now() - started) / 60000))
  if (minutes < 60) return `${minutes}m old`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h old`
  return `${Math.floor(hours / 24)}d old`
}

function safeResourceUri(value: string): boolean {
  return /^morrow:\/\/(attachments|articles)\/[A-Za-z0-9._~-]{1,180}$/.test(value)
}

function videoAttachmentUrl(resourceUri: string): string {
  return `/ops/video?uri=${encodeURIComponent(resourceUri)}`
}

function isVideoAttachment(contentType: string): boolean {
  return contentType.toLowerCase().startsWith('video/')
}

function resourceResponse(
  c: { body(body: BodyInit | null, status?: number, headers?: Record<string, string>): Response },
  resource: ResourceBody,
  disposition: 'attachment' | 'inline' = 'attachment',
) {
  const headers: Record<string, string> = {
    'content-type': resource.contentType || 'application/octet-stream',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  }
  if (resource.filename) {
    const filename = resource.filename.replace(/[\r\n"\\]/g, '_').slice(0, 180)
    headers['content-disposition'] = `${disposition}; filename="${filename}"`
  }
  return c.body(resource.body as BodyInit, 200, headers)
}

function OpsHeading({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: Child }) {
  return (
    <header class="ops-heading">
      <div><p class="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>
      {actions ? <div class="ops-heading-actions">{actions}</div> : null}
    </header>
  )
}

function QueueList({ queue, locale, timezone }: { queue: QueueView; locale: string; timezone: string }) {
  if (queue.cases.length === 0) {
    return <EmptyState eyebrow="Queue clear" title="No cases match this view.">Change the filter or wait for the next customer message.</EmptyState>
  }
  return (
    <div class="queue-list">
      <div class="queue-columns" aria-hidden="true"><span>Case</span><span>Customer</span><span>Owner</span><span>Age</span></div>
      {queue.cases.map((item) => (
        <a class="queue-row" href={`/ops/cases/${encodeURIComponent(item.ref)}`}>
          <span class="queue-subject"><strong>{item.subject}</strong><small>{item.ref} · updated {formatDate(item.updatedAt, locale, timezone)}</small></span>
          <span><strong>{item.customer.name}</strong><small>{item.customer.email ?? item.customer.phone ?? 'No contact point'}</small></span>
          <span>{item.assignee ? <><strong>{item.assignee.name}</strong><small>Assigned</small></> : <><StatusPill value="unassigned" /><small>Claims on first action</small></>}</span>
          <span class="queue-age"><strong>{queueAge(item.openedAt)}</strong><span class="row-pills"><StatusPill value={item.priority} /><StatusPill value={item.status} /></span></span>
        </a>
      ))}
    </div>
  )
}

function ConversationList({ queue, locale, timezone }: { queue: ConversationQueue; locale: string; timezone: string }) {
  if (queue.conversations.length === 0) {
    return <EmptyState eyebrow="Inbox clear" title="No conversations need recovery.">New WhatsApp messages and delivery problems will appear here.</EmptyState>
  }
  return (
    <div class="conversation-list">
      <div class="conversation-columns" aria-hidden="true"><span>Contact</span><span>Latest message</span><span>Routing</span><span>Waiting since</span></div>
      {queue.conversations.map((conversation) => (
        <a class="conversation-row" href={`/ops/conversations/${encodeURIComponent(conversation.id)}`}>
          <span><strong>{conversation.contact.name}</strong><small>{conversation.contact.address.value} · {humanize(conversation.channel)}</small></span>
          <span class="conversation-preview"><strong>{conversation.latestInboundBody}</strong><small>{conversation.messageCount} {conversation.messageCount === 1 ? 'message' : 'messages'}</small></span>
          <span><StatusPill value={conversation.attention} /><small>{conversation.routeTargets.length > 0 ? conversation.routeTargets.map(humanize).join(' + ') : 'Unclassified'}</small></span>
          <span><strong>{queueAge(conversation.lastInboundAt)}</strong><small>{formatDate(conversation.lastInboundAt, locale, timezone)}</small></span>
        </a>
      ))}
    </div>
  )
}

function ConversationView({ conversation, settings }: { conversation: ConversationWorkspace; settings: WorkspaceSettingsView }) {
  return (
    <>
      <OpsHeading
        eyebrow={`${humanize(conversation.channel)} conversation`}
        title={conversation.contact.name}
        description={`${conversation.contact.address.value} · last inbound ${formatDate(conversation.lastInboundAt, settings.locale, settings.timezone)}`}
        actions={<StatusPill value={conversation.attention} />}
      />
      <Notice tone="info" title="Read-only recovery view">Use an MCP-connected agent to classify, route, and reply. This console preserves visibility when the agent path is unavailable.</Notice>
      <div class="case-console-grid conversation-console-grid">
        <section class="ops-thread" aria-labelledby="conversation-thread-title">
          <div class="section-bar"><h2 id="conversation-thread-title">Messages</h2><span>{conversation.messages.length} events</span></div>
          {conversation.messages.length > 0 ? conversation.messages.map((message) => (
            <article class="ops-thread-entry visibility-public">
              <header>
                <div><strong>{message.author}</strong><span>{humanize(message.direction)}</span></div>
                <time datetime={message.occurredAt}>{formatDate(message.occurredAt, settings.locale, settings.timezone)}</time>
              </header>
              <div class="ops-message-body">{message.body}</div>
              {message.delivery ? <footer><StatusPill value={message.delivery} /><span>Provider delivery state</span></footer> : null}
            </article>
          )) : <EmptyState eyebrow="Conversation history" title="No messages are available.">Wait for the provider to deliver message evidence.</EmptyState>}
        </section>
        <aside class="case-actions">
          <section class="conversation-routing">
            <div class="section-bar"><h2>Business routing</h2><span>{conversation.routes.length || 'None'}</span></div>
            {conversation.routes.length > 0 ? (
              <div class="route-list">
                {conversation.routes.map((route) => (
                  <div class="route-row">
                    <div><StatusPill value={route.target} /><strong>{humanize(route.entityType)}</strong></div>
                    <span class="mono">{route.entityId}</span>
                    <small>Routed {formatDate(route.createdAt, settings.locale, settings.timezone)}</small>
                  </div>
                ))}
              </div>
            ) : <p class="recovery-copy">No Desk case or CRM lead has been created. Ask your connected agent to classify this conversation as support, sales, or both.</p>}
          </section>
          <section class="case-facts">
            <h2>Conversation facts</h2>
            <dl>
              <div><dt>Channel</dt><dd>{humanize(conversation.channel)}</dd></div>
              <div><dt>Contact</dt><dd>{conversation.contact.address.value}</dd></div>
              <div><dt>Attention</dt><dd>{humanize(conversation.attention)}</dd></div>
              {conversation.resolution ? <div><dt>Final disposition</dt><dd>{humanize(conversation.resolution.disposition)} — {conversation.resolution.reason}</dd></div> : null}
              <div><dt>Routes</dt><dd>{conversation.routes.length}</dd></div>
              <div><dt>Conversation ID</dt><dd class="mono">{conversation.id}</dd></div>
              <div><dt>Revision</dt><dd class="mono">{conversation.revision}</dd></div>
            </dl>
          </section>
        </aside>
      </div>
    </>
  )
}

function CaseView({ item, settings, notice }: { item: CaseWorkspace; settings: WorkspaceSettingsView; notice?: string | undefined }) {
  return (
    <>
      <OpsHeading
        eyebrow={`Case ${item.ref}`}
        title={item.subject}
        description={`${item.customer.name} · ${item.customer.email ?? item.customer.phone ?? 'No contact point'} · opened ${formatDate(item.openedAt, settings.locale, settings.timezone)}`}
        actions={<><StatusPill value={item.priority} /><StatusPill value={item.status} /></>}
      />
      {notice ? <Notice tone="success" title={notice} /> : null}
      {item.deliveryWarnings.length > 0 ? <Notice tone="warning" title="Delivery warning">{item.deliveryWarnings.join(' ')}</Notice> : null}
      <div class="case-console-grid">
        <section class="ops-thread" aria-labelledby="thread-title">
          <div class="section-bar"><h2 id="thread-title">Conversation</h2><span>{item.thread.length} events</span></div>
          {item.thread.length > 0 ? item.thread.map((entry) => (
            <article class={`ops-thread-entry visibility-${entry.visibility}`}>
              <header>
                <div><strong>{entry.author}</strong><span>{entry.visibility === 'internal' ? 'Private note' : humanize(entry.direction)}</span></div>
                <time datetime={entry.createdAt}>{formatDate(entry.createdAt, settings.locale, settings.timezone)}</time>
              </header>
              <div class="ops-message-body">{entry.body}</div>
              {entry.attachments.length > 0 ? (
                <ul class="ops-attachments">
                  {entry.attachments.map((attachment) => (
                    <li>
                      {isVideoAttachment(attachment.contentType) ? <video controls preload="metadata" src={videoAttachmentUrl(attachment.resourceUri)}>Your browser cannot play this video.</video> : null}
                      <a href={isVideoAttachment(attachment.contentType) ? videoAttachmentUrl(attachment.resourceUri) : `/ops/resource?uri=${encodeURIComponent(attachment.resourceUri)}`}><span>{attachment.filename}</span><small>{formatBytes(attachment.size)}</small></a>
                    </li>
                  ))}
                </ul>
              ) : null}
              {entry.delivery ? <footer><StatusPill value={entry.delivery} /><span>{entry.delivery === 'accepted' ? 'Provider accepted; inbox delivery is not proven.' : 'Delivery state'}</span></footer> : null}
            </article>
          )) : <EmptyState eyebrow="Case history" title="No messages in this case.">Use a private note to record what you learn, or send a customer reply.</EmptyState>}
        </section>
        <aside class="case-actions">
          <section class="action-block action-primary">
            <div class="section-bar"><h2>Emergency reply</h2><span>Public</span></div>
            {item.status === 'closed' ? (
              <Notice tone="warning" title="Closed case">Change the status before attempting a public reply.</Notice>
            ) : (
              <form class="ops-form" action={`/ops/cases/${encodeURIComponent(item.ref)}/reply`} method="post">
                <input type="hidden" name="revision" value={item.revision} />
                <TextAreaField label="Customer reply" name="body" helper="Sending defaults the case to waiting on customer. Email starts as queued." required rows={7} maxLength={10000} />
                <button type="submit">Queue public reply</button>
              </form>
            )}
          </section>
          <section class="action-block">
            <div class="section-bar"><h2>Private note</h2><span>Internal</span></div>
            <form class="ops-form" action={`/ops/cases/${encodeURIComponent(item.ref)}/note`} method="post">
              <input type="hidden" name="revision" value={item.revision} />
              <TextAreaField label="Note" name="body" helper="Customers never see private notes." required rows={5} maxLength={10000} />
              <button class="button-secondary" type="submit">Add private note</button>
            </form>
          </section>
          <section class="action-block">
            <div class="section-bar"><h2>Case state</h2><span>Revision protected</span></div>
            <form class="ops-form" action={`/ops/cases/${encodeURIComponent(item.ref)}/manage`} method="post">
              <input type="hidden" name="revision" value={item.revision} />
              <div class="field"><label for="status">Status</label><select id="status" name="status">{STATUSES.map((status) => <option value={status} selected={status === item.status}>{humanize(status)}</option>)}</select></div>
              <div class="field"><label for="priority">Priority</label><select id="priority" name="priority">{PRIORITIES.map((priority) => <option value={priority} selected={priority === item.priority}>{humanize(priority)}</option>)}</select></div>
              <button class="button-secondary" type="submit">Update state</button>
            </form>
          </section>
          <section class="case-facts">
            <h2>Case facts</h2>
            <dl>
              <div><dt>Channel</dt><dd>{humanize(item.channel)}</dd></div>
              <div><dt>Assignee</dt><dd>{item.assignee?.name ?? 'Unassigned'}</dd></div>
              <div><dt>Category</dt><dd>{item.category?.name ?? 'None'}</dd></div>
              <div><dt>Customer history</dt><dd>{item.customer.caseCount} cases</dd></div>
              <div><dt>Revision</dt><dd class="mono">{item.revision}</dd></div>
            </dl>
          </section>
        </aside>
      </div>
    </>
  )
}

async function operatorWriteAllowed(deps: OpsDependencies, request: Request): Promise<boolean> {
  const origin = request.headers.get('origin')
  if (!origin || origin !== new URL(request.url).origin) return false
  return deps.verifyOperatorWrite(request)
}

export function createOpsRoutes(deps: OpsDependencies): Hono {
  const app = new Hono()
  const { actor, helpdesk, settings } = deps

  app.use('*', async (c, next) => {
    await next()
    c.header('Content-Security-Policy', OPS_CSP)
    c.header('Cache-Control', 'private, no-store')
    c.header('Referrer-Policy', 'same-origin')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('X-Frame-Options', 'DENY')
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  })

  app.get('/', async (c) => {
    const statusValue = c.req.query('status')
    const status = statusValue && STATUSES.includes(statusValue as CaseStatus) ? statusValue as CaseStatus : undefined
    const result = await helpdesk.work(actor, { kind: 'queue', ...(status ? { status } : {}), assignee: 'any', limit: 100 })
    if (!isQueue(result)) throw new Error('Queue selector returned a non-queue view')
    return c.html(
      <OpsDocument title={`Queue · ${settings.displayName}`} identity={identity(settings)} actor={actor} active="queue">
        <OpsHeading eyebrow="Recovery console" title="Work queue" description="The smallest human surface for seeing cases, recovering delivery, and acting when MCP is unavailable." actions={<a class="button" href="/ops/status">Check system status</a>} />
        <form class="filter-bar" method="get" action="/ops">
          <label for="queue-status">Case status</label>
          <select id="queue-status" name="status">
            <option value="">All active states</option>
            {STATUSES.map((item) => <option value={item} selected={item === status}>{humanize(item)}</option>)}
          </select>
          <button class="button-secondary" type="submit">Apply filter</button>
        </form>
        <QueueList queue={result} locale={settings.locale} timezone={settings.timezone} />
      </OpsDocument>,
    )
  })

  app.get('/cases/:ref', async (c) => {
    const result = await helpdesk.work(actor, { kind: 'case', ref: c.req.param('ref') })
    if (!isCase(result)) return c.notFound()
    const notice = c.req.query('notice')?.slice(0, 100)
    return c.html(
      <OpsDocument title={`${result.ref} · ${settings.displayName}`} identity={identity(settings)} actor={actor} active="queue">
        <CaseView item={result} settings={settings} notice={notice} />
      </OpsDocument>,
    )
  })

  app.get('/conversations', async (c) => {
    if (!deps.communications) return c.notFound()
    const queue = await deps.communications.work(actor, { kind: 'queue', limit: 100 })
    return c.html(
      <OpsDocument title={`Conversations · ${settings.displayName}`} identity={identity(settings)} actor={actor} active="conversations">
        <OpsHeading eyebrow="Channel recovery" title="Conversations" description="WhatsApp conversations that still need classification, routing, or delivery recovery. Normal work remains agent-first." />
        <ConversationList queue={queue} locale={settings.locale} timezone={settings.timezone} />
      </OpsDocument>,
    )
  })

  app.get('/conversations/:id', async (c) => {
    if (!deps.communications) return c.notFound()
    const conversation = await deps.communications.work(actor, { kind: 'conversation', id: c.req.param('id') })
    if (!conversation) return c.notFound()
    return c.html(
      <OpsDocument title={`${conversation.contact.name} · ${settings.displayName}`} identity={identity(settings)} actor={actor} active="conversations">
        <ConversationView conversation={conversation} settings={settings} />
      </OpsDocument>,
    )
  })

  app.post('/cases/:ref/reply', async (c) => {
    if (!await operatorWriteAllowed(deps, c.req.raw)) return c.text('Operator write rejected.', 403)
    const form = await c.req.formData()
    const revision = clean(form.get('revision'), 256)
    const body = clean(form.get('body'), 10000)
    if (!revision || body.length < 2) return c.text('Revision and reply are required.', 400)
    await helpdesk.act(actor, { kind: 'reply', ref: c.req.param('ref'), revision, body })
    return c.redirect(`/ops/cases/${encodeURIComponent(c.req.param('ref'))}?notice=${encodeURIComponent('Public reply queued')}`, 303)
  })

  app.post('/cases/:ref/note', async (c) => {
    if (!await operatorWriteAllowed(deps, c.req.raw)) return c.text('Operator write rejected.', 403)
    const form = await c.req.formData()
    const revision = clean(form.get('revision'), 256)
    const body = clean(form.get('body'), 10000)
    if (!revision || body.length < 2) return c.text('Revision and note are required.', 400)
    await helpdesk.act(actor, { kind: 'note', ref: c.req.param('ref'), revision, body })
    return c.redirect(`/ops/cases/${encodeURIComponent(c.req.param('ref'))}?notice=${encodeURIComponent('Private note added')}`, 303)
  })

  app.post('/cases/:ref/manage', async (c) => {
    if (!await operatorWriteAllowed(deps, c.req.raw)) return c.text('Operator write rejected.', 403)
    const form = await c.req.formData()
    const revision = clean(form.get('revision'), 256)
    const status = clean(form.get('status'), 40) as CaseStatus
    const priority = clean(form.get('priority'), 40) as CasePriority
    if (!revision || !STATUSES.includes(status) || !PRIORITIES.includes(priority)) return c.text('Valid revision, status, and priority are required.', 400)
    await helpdesk.act(actor, { kind: 'manage', ref: c.req.param('ref'), revision, status, priority })
    return c.redirect(`/ops/cases/${encodeURIComponent(c.req.param('ref'))}?notice=${encodeURIComponent('Case state updated')}`, 303)
  })

  app.get('/resource', async (c) => {
    const uri = c.req.query('uri') ?? ''
    if (!safeResourceUri(uri)) return c.notFound()
    try {
      return resourceResponse(c, await helpdesk.resource(actor, uri))
    } catch {
      return c.notFound()
    }
  })

  app.get('/video', async (c) => {
    const uri = c.req.query('uri') ?? ''
    if (!safeResourceUri(uri) || !uri.startsWith('morrow://attachments/')) return c.notFound()
    try {
      const resource = await helpdesk.resource(actor, uri)
      if (!isVideoAttachment(resource.contentType)) return c.notFound()
      return resourceResponse(c, resource, 'inline')
    } catch {
      return c.notFound()
    }
  })

  app.get('/outbox', async (c) => {
    const snapshot = await deps.diagnostics()
    return c.html(
      <OpsDocument title={`Outbox · ${settings.displayName}`} identity={identity(settings)} actor={actor} active="outbox">
        <OpsHeading eyebrow="Delivery evidence" title="Outbox" description="Queued is local intent. Accepted is provider acceptance. Neither means a message reached an inbox." />
        {snapshot.outbox.length > 0 ? (
          <div class="outbox-table">
            <div class="outbox-columns" aria-hidden="true"><span>Message</span><span>Recipient</span><span>Attempts</span><span>State</span></div>
            {snapshot.outbox.map((row) => (
              <article class="outbox-row">
                <div><strong>{humanize(row.kind)}</strong><span>{row.caseRef ? <a href={`/ops/cases/${encodeURIComponent(row.caseRef)}`}>{row.caseRef}</a> : row.id}</span></div>
                <div><strong>{row.recipient}</strong><span>Next: {formatDate(row.nextAttemptAt, settings.locale, settings.timezone)}</span></div>
                <div><strong class="mono">{row.attempts}</strong><span>Updated {formatDate(row.updatedAt, settings.locale, settings.timezone)}</span></div>
                <div><StatusPill value={row.state} />{row.lastError ? <span class="outbox-error">{row.lastError}</span> : null}</div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState eyebrow="Outbox clear" title="No delivery operations are waiting.">New public replies and magic links appear here until their provider state settles.</EmptyState>
        )}
      </OpsDocument>,
    )
  })

  app.get('/status', async (c) => {
    const snapshot = await deps.diagnostics()
    const ready = snapshot.setup.accessReady && snapshot.setup.securityReady && snapshot.setup.emailReady
    return c.html(
      <OpsDocument title={`Status · ${settings.displayName}`} identity={identity(settings)} actor={actor} active="status">
        <OpsHeading eyebrow="Operational diagnostics" title={ready ? 'Core services are ready.' : 'Setup needs attention.'} description="These checks gate operator access, magic-link delivery, and public intake." />
        <div class="status-ledger">
          <section><div><h2>Cloudflare Access</h2><p>MCP and this console fail closed without a verified issuer and audience.</p></div><StatusPill value={snapshot.setup.accessReady ? 'ready' : 'blocked'} /></section>
          <section><div><h2>Portal security</h2><p>Public writes require Turnstile and customer capability configuration.</p></div><StatusPill value={snapshot.setup.securityReady ? 'ready' : 'blocked'} /></section>
          <section><div><h2>Outbound email</h2><p>Public intake stays off until an arbitrary-recipient setup test passes.</p><small>Last test: {formatDate(snapshot.setup.lastEmailTestAt, settings.locale, settings.timezone)}</small></div><StatusPill value={snapshot.setup.emailReady ? 'ready' : 'blocked'} /></section>
          <section><div><h2>Public intake</h2><p>The request form depends on outbound magic-link delivery.</p></div><StatusPill value={snapshot.setup.intakeEnabled ? 'ready' : 'blocked'} /></section>
        </div>
        <Notice tone="info" title="What this does not prove">A provider-accepted message is not proof that a customer received or read it. Use the outbox state and customer follow-up as separate evidence.</Notice>
      </OpsDocument>,
    )
  })

  app.get('/settings', async (c) => {
    const snapshot = await deps.diagnostics()
    const canEdit = actor.role === 'admin' && Boolean(deps.updateSettings)
    return c.html(
      <OpsDocument title={`Settings · ${settings.displayName}`} identity={identity(settings)} actor={actor} active="settings">
        <OpsHeading eyebrow="Workspace configuration" title="Settings" description="Brand and operating values stay in private deployment data, not repository source." />
        {actor.role !== 'admin' ? <Notice tone="warning" title="Admin access required">Agents can inspect these values but cannot change them.</Notice> : null}
        <div class="settings-grid">
          <form class="ops-form settings-form" action="/ops/settings" method="post">
            <fieldset disabled={!canEdit}>
              <legend>Portal identity</legend>
              <Field label="Display name" name="display_name" value={settings.displayName} required maxLength={120} />
              <Field label="Portal title" name="portal_title" value={settings.portalTitle} required maxLength={180} />
              <Field label="Brand icon or logo URL (optional)" name="logo_url" value={settings.logoUrl ?? ''} inputmode="url" helper="Shown in the support header and footer. Use a compact square or horizontal mark." maxLength={500} />
              <Field label="Favicon URL (optional)" name="favicon_url" value={settings.faviconUrl ?? ''} inputmode="url" helper="Shown in the browser tab. HTTPS and same-site paths are supported." maxLength={500} />
              <Field label="Home URL (optional)" name="home_url" value={settings.homeUrl ?? ''} inputmode="url" maxLength={500} />
              <Field label="Support email (optional)" name="support_email" type="email" value={settings.supportEmail ?? ''} inputmode="email" maxLength={254} />
              <Field label="Outbound sender (optional)" name="outbound_sender" type="email" value={settings.outboundSender ?? ''} inputmode="email" helper="Email Service must verify this sender before a delivery test can pass." maxLength={254} />
              <Field label="Public portal URL (optional)" name="portal_base_url" value={settings.portalBaseUrl ?? ''} inputmode="url" placeholder="https://support.example.com" helper="Magic links use this canonical HTTPS origin." maxLength={500} />
              <div class="form-pair">
                <Field label="Case prefix" name="case_prefix" value={settings.casePrefix} required minLength={2} maxLength={8} />
                <Field label="Locale" name="locale" value={settings.locale} required maxLength={20} />
              </div>
              <Field label="Timezone" name="timezone" value={settings.timezone} placeholder="UTC" helper="Use an IANA timezone such as Asia/Singapore or America/Chicago." required maxLength={64} />
            </fieldset>
            <fieldset disabled={!canEdit}>
              <legend>Theme guardrails</legend>
              <p class="fieldset-help">V1 accepts a brand accent, neutral canvas and ink, and a fixed font family. The portal derives accessible text colors from the palette. Custom CSS and scripts stay disabled so an agent cannot introduce unsafe page code.</p>
              <div class="form-triple">
                <Field label="Accent" name="accent_color" value={settings.accentColor} required maxLength={7} />
                <Field label="Canvas" name="canvas_color" value={settings.canvasColor} required maxLength={7} />
                <Field label="Ink" name="ink_color" value={settings.inkColor} required maxLength={7} />
              </div>
              <div class="field"><label for="font_family">Font family</label><select id="font_family" name="font_family">{FONT_FAMILIES.map((font) => <option value={font} selected={font === settings.fontFamily}>{humanize(font)}</option>)}</select></div>
            </fieldset>
            <fieldset disabled={!canEdit || !snapshot.setup.emailReady || !snapshot.setup.securityReady}>
              <legend>Public intake</legend>
              <label class="check-field" for="public_intake_enabled"><input id="public_intake_enabled" type="checkbox" name="public_intake_enabled" value="1" checked={settings.publicIntakeEnabled} /><span><strong>Accept new public requests</strong><small>Available only after outbound email passes its setup test.</small></span></label>
            </fieldset>
            <button type="submit" disabled={!canEdit}>Save workspace settings</button>
          </form>
          <section class="operator-list">
            <div class="email-test-block">
              <div class="section-bar"><h2>Outbound setup test</h2><span>{snapshot.setup.emailReady ? 'Passed' : 'Required'}</span></div>
              <p>Queue a real message to an address you can inspect. Public intake remains disabled until the provider accepts it.</p>
              <form class="ops-form" action="/ops/settings/email-test" method="post">
                <Field label="Test recipient" name="recipient" type="email" value={actor.email} inputmode="email" required maxLength={254} />
                <button class="button-secondary" type="submit" disabled={actor.role !== 'admin' || !deps.queueEmailTest || !settings.outboundSender || !settings.portalBaseUrl}>Queue email test</button>
              </form>
            </div>
            <div class="section-bar"><h2>Operators</h2><span>{snapshot.operators.length}</span></div>
            {snapshot.operators.map((operator) => (
              <div class="operator-row">
                <div><strong>{operator.name}</strong><span>{operator.email}</span><small>{operator.active ? 'Active' : 'Inactive'}</small></div>
                {actor.role === 'admin' && deps.updateOperatorRole && operator.id !== actor.id ? (
                  <form action="/ops/operators/role" method="post">
                    <input type="hidden" name="operator_id" value={operator.id} />
                    <select aria-label={`Role for ${operator.name}`} name="role"><option value="agent" selected={operator.role === 'agent'}>Agent</option><option value="admin" selected={operator.role === 'admin'}>Admin</option></select>
                    <button class="button-secondary" type="submit">Update</button>
                  </form>
                ) : <StatusPill value="ready" />}
              </div>
            ))}
          </section>
        </div>
      </OpsDocument>,
    )
  })

  app.post('/settings', async (c) => {
    if (actor.role !== 'admin' || !deps.updateSettings) return c.text('Admin access required.', 403)
    if (!await operatorWriteAllowed(deps, c.req.raw)) return c.text('Operator write rejected.', 403)
    const form = await c.req.formData()
    const displayName = clean(form.get('display_name'), 120)
    const portalTitle = clean(form.get('portal_title'), 180)
    const casePrefix = clean(form.get('case_prefix'), 8).toUpperCase()
    const locale = clean(form.get('locale'), 20)
    const timezone = clean(form.get('timezone'), 64)
    const accentColor = clean(form.get('accent_color'), 7).toLowerCase()
    const canvasColor = clean(form.get('canvas_color'), 7).toLowerCase()
    const inkColor = clean(form.get('ink_color'), 7).toLowerCase()
    const fontFamily = clean(form.get('font_family'), 20) as WorkspaceSettingsView['fontFamily']
    const logoUrl = clean(form.get('logo_url'), 500)
    const faviconUrl = clean(form.get('favicon_url'), 500)
    const homeUrl = clean(form.get('home_url'), 500)
    const supportEmail = clean(form.get('support_email'), 254).toLowerCase()
    const outboundSender = clean(form.get('outbound_sender'), 254).toLowerCase()
    const portalBaseUrl = clean(form.get('portal_base_url'), 500)
    const snapshot = await deps.diagnostics()
    try {
      await deps.updateSettings(actor, {
        displayName,
        portalTitle,
        logoUrl: logoUrl || null,
        faviconUrl: faviconUrl || null,
        homeUrl: homeUrl || null,
        supportEmail: supportEmail || null,
        outboundSender: outboundSender || null,
        portalBaseUrl: portalBaseUrl || null,
        casePrefix,
        locale,
        timezone,
        accentColor,
        canvasColor,
        inkColor,
        fontFamily,
        publicIntakeEnabled: snapshot.setup.emailReady && snapshot.setup.securityReady && form.get('public_intake_enabled') === '1',
      })
    } catch {
      return c.text('Settings failed validation.', 400)
    }
    return c.redirect('/ops/settings?notice=saved', 303)
  })

  app.post('/settings/email-test', async (c) => {
    if (actor.role !== 'admin' || !deps.queueEmailTest) return c.text('Admin access required.', 403)
    if (!await operatorWriteAllowed(deps, c.req.raw)) return c.text('Operator write rejected.', 403)
    if (!settings.outboundSender || !settings.portalBaseUrl) return c.text('Configure an outbound sender and public portal URL first.', 409)
    const form = await c.req.formData()
    const recipient = clean(form.get('recipient'), 254).toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) return c.text('Valid test recipient required.', 400)
    await deps.queueEmailTest(actor, recipient)
    return c.redirect('/ops/outbox', 303)
  })

  app.post('/operators/role', async (c) => {
    if (actor.role !== 'admin' || !deps.updateOperatorRole) return c.text('Admin access required.', 403)
    if (!await operatorWriteAllowed(deps, c.req.raw)) return c.text('Operator write rejected.', 403)
    const form = await c.req.formData()
    const operatorId = clean(form.get('operator_id'), 160)
    const role = clean(form.get('role'), 10)
    if (!operatorId || (role !== 'agent' && role !== 'admin')) return c.text('Valid operator and role required.', 400)
    await deps.updateOperatorRole(actor, operatorId, role)
    return c.redirect('/ops/settings?notice=role-updated', 303)
  })

  app.onError((error, c) => {
    void error
    return c.html(
      <OpsDocument title={`Console error · ${settings.displayName}`} identity={identity(settings)} actor={actor} active="status">
        <OpsHeading eyebrow="Operation stopped" title="The console could not complete that action." description="Refresh the case before retrying. A stale revision is never overwritten." />
        <Notice tone="error" title="No blind retry">Return to the queue, reopen the latest case workspace, and act from its current revision.</Notice>
        <a class="button" href="/ops">Return to queue</a>
      </OpsDocument>,
      500,
    )
  })

  return app
}
