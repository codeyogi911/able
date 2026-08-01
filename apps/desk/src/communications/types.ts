import type { Actor, DeliveryState } from '../domain/types'

declare const conversationRevisionBrand: unique symbol
export type ConversationRevision = string & { readonly [conversationRevisionBrand]: true }

/**
 * The channel on which a customer exchange occurs. A channel only becomes
 * reply-capable after its delivery adapter is installed; ingress is broader
 * than outbound delivery by design.
 */
export type ConversationChannel =
  | 'whatsapp'
  | 'email'
  | 'portal'
  | 'web_chat'
  | 'voice'
  | 'instagram'
  | 'facebook_messenger'

export type ConversationContactAddressKind = 'email' | 'phone' | 'opaque'

export type ConversationContact = {
  /** Stable only within the provider/channel binding; it is not a Directory party ID. */
  channelContactId: string
  name: string
  address: { kind: ConversationContactAddressKind; value: string }
  /** Compatibility convenience fields. Consumers must prefer `address`. */
  email: string | null
  phone: string | null
}

export type ConversationReplyCapability = {
  available: boolean
  reason: string | null
  nextAction: string
}

/**
 * Bounded provider evidence for non-text intake. It intentionally keeps only
 * the typed retrieval reference and safe display metadata, never the raw
 * webhook envelope or media bytes.
 */
export type ConversationContentReference = {
  type: string
  providerMediaId: string | null
  mimeType: string | null
  filename: string | null
  caption: string | null
}

export type ConversationMessage = {
  id: string
  direction: 'inbound' | 'outbound'
  author: string
  body: string
  delivery: DeliveryState | null
  providerMessageId: string | null
  content: ConversationContentReference | null
  occurredAt: string
}

export type ConversationRouteLink = {
  target: 'support' | 'sales'
  module: 'helpdesk' | 'crm'
  entityType: 'case' | 'sales_lead'
  entityId: string
  intentId: string
  createdAt: string
}

export type ConversationDisposition = 'no_action' | 'spam' | 'duplicate'

export type ConversationResolution = {
  disposition: ConversationDisposition
  reason: string
  classifiedAt: string
}

export type ConversationWorkspace = {
  kind: 'conversation'
  id: string
  revision: ConversationRevision
  channel: ConversationChannel
  contact: ConversationContact
  replyCapability: ConversationReplyCapability
  attention: 'needs_attention' | 'handled' | 'delivery_problem'
  resolution: ConversationResolution | null
  messages: ConversationMessage[]
  routes: ConversationRouteLink[]
  lastInboundAt: string
  createdAt: string
  updatedAt: string
}

export type ConversationQueueItem = {
  id: string
  channel: ConversationChannel
  contact: Pick<ConversationContact, 'name' | 'address' | 'email' | 'phone'>
  attention: ConversationWorkspace['attention']
  messageCount: number
  latestInboundBody: string
  latestInboundTruncated: boolean
  routeTargets: ConversationRouteLink['target'][]
  lastInboundAt: string
}

export type ConversationQueue = {
  kind: 'conversation_queue'
  conversations: ConversationQueueItem[]
  returned: number
  hasMore: boolean
  nextCursor: string | null
  nextAction: string | null
}

export type ConversationSelector =
  | { kind: 'next' }
  | { kind: 'queue'; limit?: number; cursor?: string }
  | { kind: 'conversation'; id: string }

/**
 * A verified, normalized provider event. Provider adapters own signature
 * validation and payload parsing; Communications owns replay protection,
 * conversation state, receipts, and audit after this seam.
 */
export type ConversationInboundEvent = {
  channel: ConversationChannel
  provider: string
  providerEventId: string
  providerMessageId: string
  accountId: string
  endpointId: string
  externalThreadId: string
  occurredAt: string
  payloadHash: string
}

export type ConversationDeliveryObservation = {
  provider: string
  accountId: string
  providerMessageId: string
  status: 'sent' | 'delivered' | 'read' | 'failed'
  occurredAt: string
  payloadHash: string
}

export type ConversationIntake = {
  contact: {
    name: string
    address: { kind: ConversationContactAddressKind; value: string }
  }
  body: string
  content?: ConversationContentReference | null
}

export type ConversationIntakeReceipt = {
  operationId: string
  replayed: boolean
  conversation: ConversationWorkspace
}

export type AttachConversationWorkCommand = {
  kind: 'attach_work'
  conversationId: string
  revision: ConversationRevision
  intentId: string
  link: Omit<ConversationRouteLink, 'createdAt'>
  markHandled: boolean
}

export type ReplyConversationCommand = {
  kind: 'reply'
  conversationId: string
  revision: ConversationRevision
  intentId: string
  body: string
}

export type ClassifyConversationCommand = {
  kind: 'classify'
  conversationId: string
  revision: ConversationRevision
  intentId: string
  disposition: ConversationDisposition
  reason: string
}

export type ReopenConversationCommand = {
  kind: 'reopen'
  conversationId: string
  revision: ConversationRevision
  intentId: string
  reason: string
}

export type ConversationCommand = AttachConversationWorkCommand | ReplyConversationCommand | ClassifyConversationCommand | ReopenConversationCommand

export type ConversationActionReceipt = {
  operationId: string
  replayed: boolean
  conversation: ConversationWorkspace
  delivery: DeliveryState | null
  outbound: {
    channel: ConversationWorkspace['channel']
    recipient: string
    messageId: string
    outboxId: string
  } | null
}

export interface Communications {
  work(actor: Actor, selector: { kind: 'next' } | { kind: 'conversation'; id: string }): Promise<ConversationWorkspace | null>
  work(actor: Actor, selector: { kind: 'queue'; limit?: number; cursor?: string }): Promise<ConversationQueue>
  ingest(event: ConversationInboundEvent, intake: ConversationIntake): Promise<ConversationIntakeReceipt>
  observeDelivery(observation: ConversationDeliveryObservation): Promise<void>
  act(actor: Actor, command: AttachConversationWorkCommand): Promise<ConversationActionReceipt>
  act(actor: Actor, command: ReplyConversationCommand): Promise<ConversationActionReceipt>
  act(actor: Actor, command: ClassifyConversationCommand): Promise<ConversationActionReceipt>
  act(actor: Actor, command: ReopenConversationCommand): Promise<ConversationActionReceipt>
}
