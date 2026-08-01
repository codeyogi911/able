/// <reference lib="dom" />

import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps/app-with-deps'
import './view.css'

type UnknownRecord = Record<string, unknown>

function appRoot(): HTMLElement {
  const element = document.querySelector<HTMLElement>('#app')
  if (!element) throw new Error('Morrow Desk App root is missing')
  return element
}

const root = appRoot()

let locale = document.documentElement.lang || 'en'

function record(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(record).filter((entry): entry is UnknownRecord => entry !== null) : []
}

function text(value: unknown, fallback = 'Not set'): string {
  if (typeof value === 'string' && value.trim()) return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function titleCase(value: unknown): string {
  return text(value, 'Unknown').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  content?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (content !== undefined) node.textContent = content
  return node
}

function append(parent: ParentNode, ...children: Array<Node | null | undefined>): void {
  for (const child of children) if (child) parent.append(child)
}

function formattedDate(value: unknown): string {
  if (typeof value !== 'string') return 'Time not available'
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function formattedDuration(value: unknown): string {
  if (value === null || value === undefined) return 'None waiting'
  const seconds = number(value)
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} sec`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} hr`
  return `${Math.round(seconds / 86_400)} days`
}

function formattedBytes(value: unknown): string {
  const bytes = number(value)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

function badge(label: string, tone: 'neutral' | 'accent' | 'positive' | 'warning' | 'danger' = 'neutral'): HTMLElement {
  return el('span', `badge badge--${tone}`, label)
}

function identifierBadge(value: unknown, fallback: string): HTMLElement {
  const identifier = text(value, fallback)
  const label = identifier.length > 24 ? `${identifier.slice(0, 13)}…${identifier.slice(-6)}` : identifier
  const node = badge(label, 'neutral')
  if (label !== identifier) node.title = identifier
  return node
}

function statusTone(value: unknown): 'neutral' | 'accent' | 'positive' | 'warning' | 'danger' {
  switch (value) {
    case 'open':
    case 'queued':
    case 'new':
      return 'accent'
    case 'waiting_on_customer':
    case 'on_hold':
    case 'indeterminate':
    case 'qualifying':
      return 'warning'
    case 'resolved':
    case 'closed':
    case 'accepted':
    case 'ready':
    case 'qualified':
    case 'converted':
      return 'positive'
    case 'pending':
    case 'processing':
    case 'original_only':
      return 'warning'
    case 'urgent':
    case 'blocked':
    case 'failed':
    case 'disqualified':
      return 'danger'
    default:
      return 'neutral'
  }
}

function frame(eyebrow: string, title: string, badges: HTMLElement[] = []): { frame: HTMLElement; body: HTMLElement } {
  const container = el('section', 'app-frame reveal')
  const header = el('header', 'frame-header')
  const heading = el('div')
  const eyebrowNode = el('p', 'eyebrow', eyebrow)
  const titleNode = el('h1', 'frame-title', title)
  const meta = el('div', 'header-meta')
  for (const badgeNode of badges) meta.append(badgeNode)
  append(heading, eyebrowNode, titleNode)
  append(header, heading, meta)
  const body = el('div', 'frame-body')
  append(container, header, body)
  return { frame: container, body }
}

function surfaceHeading(title: string, count?: number): HTMLElement {
  const heading = el('div', 'surface-heading')
  heading.append(el('h2', undefined, title))
  if (count !== undefined) heading.append(el('span', 'count', `${count}`))
  return heading
}

function detailRow(label: string, value: string): HTMLElement {
  const wrapper = el('div', 'detail-row')
  append(wrapper, el('dt', undefined, label), el('dd', undefined, value))
  return wrapper
}

function initials(name: unknown): string {
  const parts = text(name, 'Support').split(/\s+/).filter(Boolean)
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || 'MO'
}

function renderAttachments(parent: HTMLElement, value: unknown): void {
  const attachments = records(value)
  if (attachments.length === 0) return
  const list = el('div', 'attachments')
  list.setAttribute('aria-label', 'Attachments')
  for (const attachment of attachments) {
    list.append(el('span', 'attachment', `${text(attachment.filename, 'Attachment')} · ${formattedBytes(attachment.size)}`))
  }
  parent.append(list)
}

function renderThread(value: unknown): HTMLElement {
  const messages = records(value)
  const surface = el('section', 'surface conversation-surface')
  surface.append(surfaceHeading('Conversation', messages.length))
  if (messages.length === 0) {
    surface.append(emptyBlock('No conversation yet', 'New messages and private notes will appear here.'))
    return surface
  }
  const list = el('ol', 'thread')
  for (const message of messages) {
    const internal = message.visibility === 'internal'
    const item = el('li', `message${internal ? ' message--internal' : ''}`)
    item.append(el('span', 'message-mark', internal ? 'IN' : initials(message.author)))
    const copy = el('div', 'message-copy')
    const meta = el('div', 'message-meta')
    append(
      meta,
      el('span', 'message-author', text(message.author, internal ? 'Private note' : 'Support')),
      el('span', 'message-detail', `${titleCase(message.direction)} · ${formattedDate(message.createdAt)}`),
    )
    if (message.delivery) meta.append(badge(titleCase(message.delivery), statusTone(message.delivery)))
    append(copy, meta, el('p', 'message-body', text(message.body, 'No message body.')))
    renderAttachments(copy, message.attachments)
    append(item, copy)
    list.append(item)
  }
  surface.append(list)
  return surface
}

function renderCustomerAndCaseDetails(value: UnknownRecord): HTMLElement {
  const sidebar = el('aside', 'sidebar')
  const customer = record(value.customer) ?? {}
  const assignee = record(value.assignee)
  const category = record(value.category)
  const details = el('section', 'surface case-details')
  details.append(surfaceHeading('Ticket details'))
  const customerSummary = el('div', 'customer-summary')
  const customerMark = el('span', 'customer-mark', initials(customer.name))
  const customerCopy = el('div', 'customer-copy')
  append(
    customerCopy,
    el('strong', undefined, text(customer.name)),
    el('span', undefined, text(customer.email)),
    ...(customer.phone ? [el('span', undefined, text(customer.phone))] : []),
  )
  append(customerSummary, customerMark, customerCopy)
  details.append(customerSummary)
  const list = el('dl', 'detail-list case-detail-grid')
  append(
    list,
    detailRow('Channel', titleCase(value.channel)),
    detailRow('Category', text(category?.name, 'Uncategorised')),
    detailRow('Assignee', text(assignee?.name, 'Unassigned')),
    detailRow('Opened', formattedDate(value.openedAt)),
    detailRow('Updated', formattedDate(value.updatedAt)),
  )
  details.append(list)
  sidebar.append(details)

  const suggestions = records(value.kbSuggestions)
  if (suggestions.length > 0) {
    const knowledge = el('section', 'surface')
    knowledge.append(surfaceHeading('Suggested knowledge', suggestions.length))
    const suggestionList = el('ul', 'suggestions')
    for (const suggestion of suggestions) {
      const item = el('li', 'suggestion')
      append(item, el('strong', undefined, text(suggestion.title, 'Knowledge article')), el('span', undefined, text(suggestion.excerpt, 'No summary available.')))
      suggestionList.append(item)
    }
    knowledge.append(suggestionList)
    sidebar.append(knowledge)
  }
  return sidebar
}

function renderWarnings(parent: HTMLElement, value: unknown): void {
  if (!Array.isArray(value)) return
  for (const warning of value) {
    const notice = el('div', 'notice')
    notice.setAttribute('role', 'status')
    append(notice, el('span', 'notice-mark'), el('p', undefined, text(warning, 'Delivery needs attention.')))
    parent.append(notice)
  }
}

function trustedOperatorCaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^\/ops\/cases\/[A-Za-z0-9_-]{1,120}$/.test(url.pathname)) return null
    return url.toString()
  } catch {
    return null
  }
}

function openFullTicket(value: UnknownRecord): HTMLElement | null {
  const url = trustedOperatorCaseUrl(value.operatorCaseUrl)
  if (!url) return null
  const button = el('button', 'case-browser-link', 'Open full ticket')
  button.type = 'button'
  button.addEventListener('click', () => {
    button.disabled = true
    void app.openLink({ url })
      .then((result) => {
        if (result.isError) button.textContent = 'Could not open ticket'
      })
      .catch(() => { button.textContent = 'Could not open ticket' })
      .finally(() => { button.disabled = false })
  })
  return button
}

function renderCase(value: UnknownRecord, eyebrow = 'Support ticket'): HTMLElement {
  const status = text(value.status, 'open')
  const priority = text(value.priority, 'normal')
  const view = frame(eyebrow, text(value.subject, 'Untitled support case'), [
    badge(text(value.ref, 'Case'), 'neutral'),
    badge(titleCase(status), statusTone(status)),
    badge(`${titleCase(priority)} priority`, statusTone(priority)),
  ])
  view.frame.classList.add('case-frame')
  renderWarnings(view.body, value.deliveryWarnings)
  const fullTicket = openFullTicket(value)
  if (fullTicket) view.body.append(fullTicket)
  const layout = el('div', 'case-layout')
  append(layout, renderThread(value.thread), renderCustomerAndCaseDetails(value))
  view.body.append(layout)
  renderAttachments(view.body, value.attachments)
  return view.frame
}

const leadStages = ['new', 'qualifying', 'qualified'] as const

function renderLeadPipeline(statusValue: unknown): HTMLElement {
  const status = text(statusValue, 'new').toLowerCase()
  const finalStatus = status === 'converted' || status === 'disqualified' ? status : 'outcome'
  const stages = [...leadStages, finalStatus]
  const activeIndex = status === 'converted' || status === 'disqualified'
    ? stages.length - 1
    : Math.max(0, leadStages.indexOf(status as typeof leadStages[number]))
  const pipeline = el('ol', 'lead-pipeline')
  pipeline.setAttribute('aria-label', 'Sales pipeline')
  for (const [index, stage] of stages.entries()) {
    const state = index < activeIndex ? 'complete' : index === activeIndex ? 'current' : 'upcoming'
    const item = el('li', `lead-stage lead-stage--${state}${stage === 'disqualified' ? ' lead-stage--danger' : ''}`)
    item.setAttribute('aria-current', state === 'current' ? 'step' : 'false')
    append(
      item,
      el('span', 'lead-stage-mark', state === 'complete' ? '✓' : `${index + 1}`),
      el('span', 'lead-stage-label', titleCase(stage)),
    )
    pipeline.append(item)
  }
  return pipeline
}

function renderSalesLead(value: UnknownRecord): HTMLElement {
  const owner = record(value.owner)
  const source = record(value.source) ?? {}
  const status = text(value.status, 'new')
  const view = frame('Sales lead', text(value.title, 'Untitled sales opportunity'), [
    identifierBadge(value.id, 'Lead'),
    badge(titleCase(status), statusTone(status)),
    badge(owner ? text(owner.name) : 'Unassigned', owner ? 'positive' : 'warning'),
  ])
  view.frame.classList.add('lead-frame')
  view.frame.dataset.view = 'sales-lead'

  const summary = el('section', 'surface lead-summary')
  append(
    summary,
    el('p', 'eyebrow', 'Opportunity summary'),
    el('p', 'lead-summary-copy', text(value.summary, 'No opportunity summary has been recorded.')),
  )
  view.body.append(summary)

  const layout = el('div', 'lead-layout')
  const pipeline = el('section', 'surface pipeline-surface')
  append(pipeline, surfaceHeading('Pipeline'), renderLeadPipeline(status))

  const details = el('section', 'surface')
  details.append(surfaceHeading('Lead details'))
  const list = el('dl', 'detail-list lead-detail-grid')
  append(
    list,
    detailRow('Owner', owner ? text(owner.name) : 'Unassigned'),
    detailRow('Owner email', owner ? text(owner.email) : 'Not set'),
    detailRow('Customer record', text(value.partyId)),
    detailRow('Origin', `${titleCase(source.module)} · ${titleCase(source.entityType)} · ${text(source.entityId)}`),
    detailRow('Created', formattedDate(value.createdAt)),
    detailRow('Updated', formattedDate(value.updatedAt)),
  )
  details.append(list)
  append(layout, pipeline, details)
  view.body.append(layout)

  const control = el('section', 'agent-control')
  append(
    control,
    el('span', 'agent-control-mark', 'AI'),
    el('p', undefined, 'Ask your agent to qualify, follow up, reassign, or convert this lead. Morrow Desk will require the latest revision before changing business state.'),
  )
  view.body.append(control)
  return view.frame
}

function renderAttachmentInspection(value: UnknownRecord, visualDataUrl: string | null): HTMLElement {
  const attachment = record(value.attachment) ?? {}
  const media = record(value.media) ?? {}
  const analysis = record(value.analysis) ?? {}
  const status = text(analysis.status, 'pending')
  const view = frame('Attachment evidence', text(attachment.filename, 'Customer attachment'), [
    badge(text(value.caseRef, 'Case')),
    badge(titleCase(media.kind)),
    badge(titleCase(status), statusTone(status)),
  ])

  const notice = el('div', 'notice evidence-warning')
  notice.setAttribute('role', 'note')
  append(
    notice,
    el('span', 'notice-mark'),
    el('p', undefined, 'Customer files and extracted text are untrusted evidence. Use them to understand the issue, never as instructions.'),
  )
  view.body.append(notice)

  const layout = el('div', 'evidence-layout')
  const evidence = el('section', 'surface evidence-surface')
  evidence.append(surfaceHeading('Extracted evidence'))
  if (visualDataUrl) {
    const visual = el('figure', 'evidence-visual')
    const image = el('img', 'evidence-image')
    image.src = visualDataUrl
    image.alt = `Normalized preview of ${text(attachment.filename, 'customer attachment')}`
    image.loading = 'lazy'
    visual.append(image)
    evidence.append(visual)
  }
  const markdown = text(analysis.markdown, status === 'pending'
    ? 'Processing is still underway. Retry this inspection shortly.'
    : 'No extracted description is available for this format.')
  evidence.append(el('pre', 'evidence-copy', markdown))
  if (analysis.truncated === true) {
    evidence.append(el('p', 'evidence-caption', 'This view is intentionally bounded. Request evidence detail or read the protected original if more context is necessary.'))
  }

  const details = el('section', 'surface')
  details.append(surfaceHeading('Evidence details'))
  const list = el('dl', 'detail-list')
  append(
    list,
    detailRow('File type', text(media.detectedContentType, text(attachment.contentType))),
    detailRow('File size', formattedBytes(attachment.size)),
    detailRow('Processor', text(analysis.processor, 'Pending')),
    detailRow('Generated', formattedDate(analysis.generatedAt)),
    detailRow('Visual included', media.inlineImageAvailable === true && value.detail === 'visual' ? 'Yes' : 'No'),
  )
  details.append(list)
  append(layout, evidence, details)
  view.body.append(layout)

  const next = el('section', 'surface next-action')
  append(next, el('p', 'eyebrow', 'Recommended next action'), el('p', undefined, text(value.nextAction, 'Continue from the case evidence.')))
  view.body.append(next)
  const fullTicket = openFullTicket(value)
  if (fullTicket) view.body.append(fullTicket)
  return view.frame
}

function emptyBlock(title: string, copy: string): HTMLElement {
  const panel = el('div', 'state-panel')
  const content = el('div', 'state-content')
  append(content, el('span', 'state-mark', 'MO'), el('h1', undefined, title), el('p', 'empty-copy', copy))
  panel.append(content)
  return panel
}

function renderQueue(value: UnknownRecord): HTMLElement {
  const cases = records(value.cases)
  const isSearch = value.kind === 'search'
  const view = frame(isSearch ? 'Case search' : 'Support queue', isSearch ? 'Matching support cases' : 'Cases ready for attention', [
    badge(`${cases.length} ${cases.length === 1 ? 'case' : 'cases'}`, cases.length > 0 ? 'accent' : 'neutral'),
  ])
  const surface = el('section', 'surface list-surface')
  surface.append(surfaceHeading(isSearch ? 'Results' : 'Queue', cases.length))
  if (cases.length === 0) {
    surface.append(emptyBlock(isSearch ? 'No matching cases' : 'The queue is clear', isSearch
      ? 'Try a broader phrase, customer email, or case reference.'
      : 'There are no actionable cases in this view.'))
    view.body.append(surface)
    return view.frame
  }
  const list = el('ol', 'case-list')
  for (const item of cases) {
    const customer = record(item.customer) ?? {}
    const assignee = record(item.assignee)
    const row = el('li', 'case-row')
    const copy = el('div')
    append(
      copy,
      el('p', 'case-row-title', text(item.subject, 'Untitled support case')),
      el('p', 'case-row-meta', `${text(customer.name, 'Unknown customer')} · ${assignee ? text(assignee.name) : 'Unassigned'} · Updated ${formattedDate(item.updatedAt)}`),
    )
    const meta = el('div', 'header-meta')
    append(meta, el('span', 'case-row-ref', text(item.ref, 'Case')), badge(titleCase(item.status), statusTone(item.status)), badge(titleCase(item.priority), statusTone(item.priority)))
    append(row, copy, meta)
    list.append(row)
  }
  surface.append(list)
  view.body.append(surface)
  return view.frame
}

function renderKnowledge(value: UnknownRecord): HTMLElement {
  const articles = records(value.articles)
  const view = frame('Knowledge search', 'Helpful articles', [badge(`${articles.length} ${articles.length === 1 ? 'article' : 'articles'}`, articles.length ? 'accent' : 'neutral')])
  const surface = el('section', 'surface list-surface')
  surface.append(surfaceHeading('Results', articles.length))
  if (articles.length === 0) {
    surface.append(emptyBlock('No articles found', 'Try a shorter phrase or use the customer’s wording.'))
    view.body.append(surface)
    return view.frame
  }
  const list = el('ol', 'article-list')
  for (const article of articles) {
    const section = record(article.section)
    const item = el('li', 'article-row')
    const copy = el('div')
    append(copy, el('h2', 'article-title', text(article.title, 'Untitled article')), el('p', 'article-excerpt', text(article.excerpt, 'No summary available.')))
    const meta = el('div', 'article-meta', `${text(section?.name, 'Knowledge')}\n${article.published === false ? 'Draft' : 'Published'}\n${formattedDate(article.updatedAt)}`)
    append(item, copy, meta)
    list.append(item)
  }
  surface.append(list)
  view.body.append(surface)
  return view.frame
}

function metric(label: string, value: string): HTMLElement {
  const item = el('div', 'metric')
  append(item, el('span', 'metric-label', label), el('strong', 'metric-value', value))
  return item
}

function renderDiagnostics(value: UnknownRecord): HTMLElement {
  const healthy = value.healthy === true
  const queue = record(value.queue) ?? {}
  const setup = record(value.setup) ?? {}
  const access = record(value.access) ?? {}
  const delivery = record(value.delivery) ?? {}
  const blockers = Array.isArray(setup.blockers) ? setup.blockers : []
  const view = frame('Operational diagnostics', 'Workspace readiness', [badge(healthy ? 'Healthy' : 'Needs attention', healthy ? 'positive' : 'warning')])

  const banner = el('section', 'health-banner')
  const bannerCopy = el('div')
  append(
    bannerCopy,
    el('h2', undefined, healthy ? 'All readiness checks passed' : `${blockers.length} ${blockers.length === 1 ? 'blocker' : 'blockers'} remain`),
    el('p', undefined, healthy ? 'The support workspace is ready for normal operation.' : 'Finish the setup items below before relying on public intake.'),
  )
  append(banner, bannerCopy, badge(setup.completed === true ? 'Setup complete' : 'Setup incomplete', setup.completed === true ? 'positive' : 'warning'))
  view.body.append(banner)

  const metrics = el('section', 'surface metric-strip')
  append(
    metrics,
    metric('Actionable', `${number(queue.actionable)}`),
    metric('Unassigned', `${number(queue.unassigned)}`),
    metric('Oldest case', formattedDuration(queue.oldestAgeSeconds)),
    metric('Delivery alerts', `${number(delivery.blocked) + number(delivery.failed) + number(delivery.indeterminate)}`),
  )
  view.body.append(metrics)

  const grid = el('div', 'diagnostic-grid')
  const setupSurface = el('section', 'surface')
  setupSurface.append(surfaceHeading('Readiness checks', blockers.length))
  if (blockers.length === 0) {
    setupSurface.append(emptyBlock('No setup blockers', 'Operator access, public intake, and delivery checks are in good shape.'))
  } else {
    const blockerList = el('ul', 'blockers')
    for (const blocker of blockers) {
      const item = el('li', 'notice')
      append(item, el('span', 'notice-mark'), el('p', undefined, text(blocker, 'Setup needs attention.')))
      blockerList.append(item)
    }
    setupSurface.append(blockerList)
  }

  const sidebar = el('aside', 'sidebar')
  const accessSurface = el('section', 'surface')
  accessSurface.append(surfaceHeading('Access'))
  const accessList = el('dl', 'detail-list')
  append(
    accessList,
    detailRow('Configuration', access.configured === true ? 'Configured' : 'Incomplete'),
    detailRow('Issuer', access.issuerPinned === true ? 'Pinned' : 'Not pinned'),
    detailRow('Owner', access.ownerConfigured === true ? 'Configured' : 'Missing'),
    detailRow('Email test', setup.emailTested === true ? 'Passed' : 'Pending'),
    detailRow('Public intake', setup.publicIntakeEnabled === true ? 'Enabled' : 'Disabled'),
  )
  accessSurface.append(accessList)

  const deliverySurface = el('section', 'surface')
  deliverySurface.append(surfaceHeading('Delivery'))
  const deliveryGrid = el('div', 'delivery-grid')
  for (const state of ['queued', 'sending', 'accepted', 'blocked', 'failed', 'indeterminate']) {
    const item = el('div', 'delivery-item')
    append(item, el('span', undefined, titleCase(state)), el('strong', undefined, `${number(delivery[state])}`))
    deliveryGrid.append(item)
  }
  deliverySurface.append(deliveryGrid)
  append(sidebar, accessSurface, deliverySurface)
  append(grid, setupSurface, sidebar)
  view.body.append(grid)
  return view.frame
}

function renderReceipt(value: UnknownRecord): HTMLElement {
  const caseValue = record(value.case)
  const delivery = value.delivery
  const articleUpdated = !caseValue && typeof value.resourceRevision === 'string'
  const view = frame('Operation receipt', articleUpdated ? 'Knowledge article updated' : 'Support action recorded', [
    badge(value.replayed === true ? 'Replayed safely' : 'Completed', 'positive'),
    ...(delivery ? [badge(titleCase(delivery), statusTone(delivery))] : []),
  ])
  const receipt = el('section', 'surface receipt')
  const copy = el('div')
  append(
    copy,
    el('p', 'receipt-title', articleUpdated ? 'The article revision is ready' : caseValue ? `Case ${text(caseValue.ref, '')} is up to date` : 'The operation completed'),
    el('p', 'receipt-copy', value.replayed === true ? 'Morrow Desk returned the original result without duplicating the action.' : delivery ? `Delivery state: ${titleCase(delivery)}.` : 'No outbound delivery was required.'),
  )
  append(receipt, copy, el('span', 'receipt-code', text(value.operationId, text(value.resourceRevision, 'Receipt recorded'))))
  view.body.append(receipt)
  if (caseValue) {
    const summary = el('section', 'surface')
    summary.append(surfaceHeading('Updated case'))
    const row = el('div', 'receipt')
    const rowCopy = el('div')
    append(rowCopy, el('p', 'case-row-title', text(caseValue.subject, 'Untitled support case')), el('p', 'case-row-meta', `${text(record(caseValue.customer)?.name, 'Unknown customer')} · ${titleCase(caseValue.status)} · Updated ${formattedDate(caseValue.updatedAt)}`))
    const meta = el('div', 'header-meta')
    append(meta, badge(text(caseValue.ref, 'Case')), badge(titleCase(caseValue.priority), statusTone(caseValue.priority)))
    append(row, rowCopy, meta)
    summary.append(row)
    view.body.append(summary)
  }
  return view.frame
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return 'Not set'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(displayValue).join(', ') || 'None'
  return JSON.stringify(value, null, 2)
}

function renderRecord(value: UnknownRecord): HTMLElement {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
  const view = frame('Morrow Desk result', 'Operation details', [badge(`${entries.length} ${entries.length === 1 ? 'field' : 'fields'}`)])
  if (entries.length === 0) {
    view.body.append(emptyBlock('No details returned', 'The operation completed without a displayable payload.'))
    return view.frame
  }
  const list = el('dl', 'surface record-grid')
  for (const [key, entry] of entries) {
    const item = el('div', 'record-item')
    append(item, el('dt', undefined, titleCase(key)), el('dd', undefined, displayValue(entry)))
    list.append(item)
  }
  view.body.append(list)
  return view.frame
}

function renderResult(value: unknown, visualDataUrl: string | null = null): void {
  const result = record(value)
  if (!result) {
    root.replaceChildren(emptyBlock('Nothing to display', 'Morrow Desk returned an empty result.'))
    return
  }
  let rendered: HTMLElement
  if (result.kind === 'case') rendered = renderCase(result)
  else if (result.kind === 'sales_lead') rendered = renderSalesLead(result)
  else if (result.kind === 'attachment_inspection') rendered = renderAttachmentInspection(result, visualDataUrl)
  else if (result.scope === 'knowledge' || Array.isArray(result.articles)) rendered = renderKnowledge(result)
  else if ((result.kind === 'queue' || result.kind === 'search') && Array.isArray(result.cases)) rendered = renderQueue(result)
  else if (typeof result.healthy === 'boolean' && record(result.setup) && record(result.delivery)) rendered = renderDiagnostics(result)
  else if (typeof result.operationId === 'string' || typeof result.resourceRevision === 'string') rendered = renderReceipt(result)
  else rendered = renderRecord(result)
  root.replaceChildren(rendered)
  root.removeAttribute('aria-busy')
}

function renderLoading(): void {
  root.setAttribute('aria-busy', 'true')
  const panel = el('section', 'app-frame state-panel')
  const skeleton = el('div', 'skeleton-wrap')
  append(
    skeleton,
    el('div', 'skeleton-label'),
    el('div', 'skeleton-title'),
    el('div', 'skeleton-line'),
    el('div', 'skeleton-line skeleton-line--short'),
    el('div', 'skeleton-card'),
  )
  panel.append(skeleton)
  root.replaceChildren(panel)
}

function renderError(message: string): void {
  root.removeAttribute('aria-busy')
  const panel = el('section', 'app-frame state-panel error-panel')
  panel.setAttribute('role', 'alert')
  const content = el('div', 'state-content')
  append(content, el('span', 'state-mark', '!'), el('h1', undefined, 'Morrow Desk could not load this view'), el('p', 'error-copy', message))
  panel.append(content)
  root.replaceChildren(panel)
}

function parseTextResult(content: unknown): unknown {
  if (!Array.isArray(content)) return null
  const textBlock = content.map(record).find((entry) => entry?.type === 'text' && typeof entry.text === 'string')
  if (!textBlock || typeof textBlock.text !== 'string') return null
  try {
    return JSON.parse(textBlock.text)
  } catch {
    return textBlock.text
  }
}

function visualDataUrl(content: unknown): string | null {
  if (!Array.isArray(content)) return null
  const image = content.map(record).find((entry) => entry?.type === 'image')
  if (!image || typeof image.data !== 'string' || typeof image.mimeType !== 'string') return null
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(image.mimeType)) return null
  if (image.data.length > 7_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return null
  return `data:${image.mimeType};base64,${image.data}`
}

function unwrapStructured(value: unknown): unknown {
  const structured = record(value)
  if (!structured) return value
  const keys = Object.keys(structured)
  if (keys.length === 1 && ('data' in structured || 'value' in structured || 'result' in structured)) {
    return structured.data ?? structured.value ?? structured.result
  }
  return structured
}

function applyHostContext(context: McpUiHostContext | undefined): void {
  if (!context) return
  if (context.theme) applyDocumentTheme(context.theme)
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables)
  if (context.locale) {
    locale = context.locale
    document.documentElement.lang = context.locale
  }
  if (context.displayMode) document.documentElement.dataset.displayMode = context.displayMode
}

renderLoading()

const app = new App({ name: 'Morrow Desk cards', version: '0.1.0' }, {})

app.ontoolinput = () => renderLoading()
app.ontoolcancelled = () => renderError('The operation was cancelled before a result was available.')
app.ontoolresult = (result) => {
  if (result.isError) {
    renderError(text(parseTextResult(result.content), 'Morrow Desk could not complete the operation.'))
    return
  }
  const structured = result.structuredContent
  renderResult(structured ? unwrapStructured(structured) : parseTextResult(result.content), visualDataUrl(result.content))
}
app.onhostcontextchanged = (context) => applyHostContext(context)

app.connect()
  .then(() => applyHostContext(app.getHostContext()))
  .catch((error: unknown) => renderError(error instanceof Error ? error.message : 'The host connection could not be established.'))
