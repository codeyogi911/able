export type CaseStatus = 'open' | 'waiting_on_customer' | 'on_hold' | 'resolved' | 'closed'
export type CasePriority = 'low' | 'normal' | 'high' | 'urgent'
export type Channel = 'portal' | 'email' | 'manual' | 'whatsapp' | 'voice'
export type DeliveryState = 'queued' | 'accepted' | 'blocked' | 'failed' | 'indeterminate'
/** Internal durable-delivery state. `sending` is never exposed as delivery proof. */
export type OutboxState = DeliveryState | 'sending'
export type OperatorRole = 'admin' | 'agent'

declare const caseRefBrand: unique symbol
declare const caseRevisionBrand: unique symbol
export type CaseRef = string & { readonly [caseRefBrand]: true }
export type CaseRevision = string & { readonly [caseRevisionBrand]: true }

export type Actor = {
  id: string
  email: string
  name: string
  role: OperatorRole
}

export type CustomerSummary = {
  id: string
  name: string
  email: string | null
  phone: string | null
  caseCount: number
}

export type AttachmentSummary = {
  id: string
  filename: string
  contentType: string
  size: number
  resourceUri: string
}

export type AttachmentInspection = {
  kind: 'attachment_inspection'
  caseRef: CaseRef
  attachment: AttachmentSummary
  media: {
    kind: 'image' | 'pdf' | 'video' | 'text' | 'binary'
    declaredContentType: string
    detectedContentType: string
    inlineImageAvailable: boolean
    previewResourceUri: string | null
  }
  analysis: {
    status: 'pending' | 'processing' | 'ready' | 'original_only' | 'failed'
    markdown: string | null
    processor: string
    processorVersion: string
    generatedAt: string | null
    cached: boolean
  }
  trust: 'untrusted_customer_content'
  retryAfterSeconds: number | null
  nextAction: string
}

export type ThreadEntry = {
  id: string
  visibility: 'public' | 'internal'
  direction: 'inbound' | 'outbound' | 'note' | 'system'
  author: string
  body: string
  createdAt: string
  delivery: DeliveryState | null
  attachments: AttachmentSummary[]
}

export type KbSuggestion = {
  slug: string
  title: string
  excerpt: string
  resourceUri: string
}

export type CaseWorkspace = {
  kind: 'case'
  ref: CaseRef
  revision: CaseRevision
  subject: string
  status: CaseStatus
  priority: CasePriority
  channel: Channel
  category: { id: string; name: string } | null
  assignee: { id: string; name: string; email: string } | null
  customer: CustomerSummary
  thread: ThreadEntry[]
  attachments: AttachmentSummary[]
  deliveryWarnings: string[]
  kbSuggestions: KbSuggestion[]
  openedAt: string
  updatedAt: string
}

export type QueueResult = {
  kind: 'queue'
  cases: Array<Pick<CaseWorkspace, 'ref' | 'revision' | 'subject' | 'status' | 'priority' | 'openedAt' | 'updatedAt'> & {
    customer: Pick<CustomerSummary, 'name' | 'email' | 'phone'>
    assignee: CaseWorkspace['assignee']
  }>
}

export type SearchResult = Omit<QueueResult, 'kind'> & { kind: 'search' }

export type KnowledgeSearchResult = SearchResult & {
  scope: 'knowledge'
  articles: Array<KbSuggestion & {
    section: { id: string; name: string }
    published: boolean
    revision: string
    updatedAt: string
  }>
}

export type WorkSelector =
  | { kind: 'next' }
  | { kind: 'case'; ref: string }
  | { kind: 'source'; source: { module: string; entityType: string; entityId: string } }
  | { kind: 'queue'; status?: CaseStatus; assignee?: 'me' | 'unassigned' | 'any'; limit?: number }
  | { kind: 'search'; query: string; limit?: number }
  | { kind: 'knowledge'; query: string; limit?: number }

export type ActionCommand =
  | { kind: 'reply'; ref: string; revision: string; body: string }
  | { kind: 'note'; ref: string; revision: string; body: string }
  | {
      kind: 'manage'
      ref: string
      revision: string
      status?: CaseStatus
      priority?: CasePriority
      categoryId?: string | null
      assigneeId?: string | null
      customer?: { name?: string; email?: string; phone?: string | null }
    }
  | {
      kind: 'open'
      customer: { name: string; email?: string; phone?: string }
      subject: string
      body: string
      priority?: CasePriority
      categoryId?: string
      channel?: Channel
      source?: { module: string; entityType: string; entityId: string }
    }
  | { kind: 'article_put'; slug: string; sectionId: string; title: string; body: string; published: boolean; revision?: string }

export type ActionReceipt = {
  operationId: string
  replayed: boolean
  case: CaseWorkspace | null
  delivery: DeliveryState | null
  resourceRevision?: string
}

export type IntakeSource =
  | { kind: 'portal'; requestId: string }
  | { kind: 'voice'; requestId: string }
  | { kind: 'email'; messageId: string }

export type IntakeRequest = {
  name: string
  email?: string
  phone?: string
  subject: string
  body: string
  categoryId?: string
  attachments?: Array<{ id: string; filename: string; contentType: string; size: number; storageKey: string; sha256: string }>
  replyToRef?: string
  /** RFC Message-IDs from In-Reply-To and References, normalized by the email adapter. */
  replyToMessageIds?: string[]
}

export type CustomerReceipt = {
  caseRef: CaseRef
  created: boolean
  publicUrl: string
  delivery: DeliveryState | null
}

export type CustomerCapability = { token: string }

export type CustomerCommand =
  | { kind: 'view' }
  | { kind: 'reply'; body: string; requestId: string }
  | { kind: 'recover'; email: string; ref: string; requestId: string }

export type CustomerResult = { case: CaseWorkspace | null; accepted: boolean; delivery: DeliveryState | null }

export type ResourceBody = {
  contentType: string
  body: ReadableStream | string
  filename?: string
  revision?: string
}

export interface Helpdesk {
  work(actor: Actor, selector: WorkSelector): Promise<CaseWorkspace | QueueResult | SearchResult>
  act(actor: Actor, command: ActionCommand): Promise<ActionReceipt>
  intake(source: IntakeSource, request: IntakeRequest): Promise<CustomerReceipt>
  customer(capability: CustomerCapability, command: CustomerCommand): Promise<CustomerResult>
  inspectAttachment(actor: Actor, attachmentId: string): Promise<AttachmentInspection>
  resource(actor: Actor, uri: string): Promise<ResourceBody>
}
