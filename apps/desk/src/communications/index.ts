import type { Actor, DeliveryState } from '../domain/types'
import {
  canonicalJson,
  cleanIsoTimestamp,
  cleanText,
  defaultUuid,
  ensureOperator,
  sha256Text,
} from '../platform/command-support'
import type {
  Communications,
  AttachConversationWorkCommand,
  ConversationCommand,
  ConversationActionReceipt,
  ConversationChannel,
  ConversationContact,
  ConversationContactAddressKind,
  ConversationContentReference,
  ConversationDeliveryObservation,
  ConversationInboundEvent,
  ClassifyConversationCommand,
  ConversationDisposition,
  ConversationIntake,
  ConversationIntakeReceipt,
  ConversationMessage,
  ConversationQueue,
  ConversationQueueItem,
  ConversationReplyCapability,
  ConversationResolution,
  ConversationRevision,
  ReopenConversationCommand,
  ReplyConversationCommand,
  ConversationRouteLink,
  ConversationSelector,
  ConversationWorkspace,
} from './types'

export type {
  Communications,
  AttachConversationWorkCommand,
  ConversationCommand,
  ConversationActionReceipt,
  ConversationChannel,
  ConversationContact,
  ConversationContactAddressKind,
  ConversationContentReference,
  ConversationDeliveryObservation,
  ConversationInboundEvent,
  ClassifyConversationCommand,
  ConversationDisposition,
  ConversationIntake,
  ConversationIntakeReceipt,
  ConversationMessage,
  ConversationQueue,
  ConversationQueueItem,
  ConversationReplyCapability,
  ConversationResolution,
  ConversationRevision,
  ReopenConversationCommand,
  ReplyConversationCommand,
  ConversationRouteLink,
  ConversationSelector,
  ConversationWorkspace,
} from './types'

export type CommunicationsDependencies = {
  db: D1Database
  clock?: { now(): Date }
  random?: { uuid(): string }
}

type ConversationRow = {
  id: string
  channel: ConversationChannel
  provider: string
  account_id: string
  endpoint_id: string
  external_thread_id: string
  contact_name: string
  contact_address_kind: ConversationContactAddressKind
  contact_address: string
  contact_email: string | null
  contact_phone: string | null
  attention_state: 'needs_attention' | 'handled' | 'delivery_problem'
  final_disposition: ConversationDisposition | null
  final_disposition_reason: string | null
  final_disposition_at: string | null
  revision: string
  last_inbound_at: string
  created_at: string
  updated_at: string
}

type ConversationQueueRow = ConversationRow & {
  message_count: number
  latest_inbound_body: string | null
  latest_inbound_truncated: number
  route_targets: string | null
}

type MessageRow = {
  id: string
  direction: 'inbound' | 'outbound'
  author_name: string
  body_text: string
  delivery_state: DeliveryState | null
  provider_message_id: string | null
  content_json: string | null
  source_created_at: string | null
  created_at: string
}

type ProviderEventRow = {
  payload_hash: string
  conversation_id: string
  message_id: string
  operation_id: string
}

type ReceiptRow = { id: string; command_hash: string; result_json: string }
type StoredReceipt = {
  conversationId: string
  messageId?: string
  outbound?: ConversationActionReceipt['outbound']
}

type RouteRow = {
  target: 'support' | 'sales'
  target_module: 'helpdesk' | 'crm'
  target_entity_type: 'case' | 'sales_lead'
  target_entity_id: string
  routing_intent_id: string
  created_at: string
}

function replyCapability(row: Pick<ConversationRow, 'channel' | 'provider'>): ConversationReplyCapability {
  if (row.channel === 'whatsapp' && row.provider === 'meta_whatsapp') {
    return {
      available: true,
      reason: null,
      nextAction: 'Use morrow_conversation_reply with the latest revision. Delivery remains subject to the WhatsApp customer-service window.',
    }
  }
  return {
    available: false,
    reason: `No delivery adapter is installed for ${row.channel}`,
    nextAction: 'Do not queue a public reply. Route the conversation or wait until this channel has a verified delivery adapter.',
  }
}

function cleanHash(value: string): string {
  const hash = cleanText(value, 'Provider payload hash', 64).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Provider payload hash is invalid')
  return hash
}

const conversationChannels: ConversationChannel[] = [
  'whatsapp',
  'email',
  'portal',
  'web_chat',
  'voice',
  'instagram',
  'facebook_messenger',
]

function cleanChannel(value: ConversationChannel): ConversationChannel {
  if (!conversationChannels.includes(value)) throw new Error('Conversation channel is invalid')
  return value
}

function cleanContactAddress(
  input: ConversationIntake['contact']['address'],
): ConversationContact['address'] {
  if (!(['email', 'phone', 'opaque'] as ConversationContactAddressKind[]).includes(input.kind)) {
    throw new Error('Contact address kind is invalid')
  }
  const value = cleanText(input.value, 'Contact address', 320)
  if (input.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error('Contact email address is invalid')
  }
  return { kind: input.kind, value }
}

function cleanContentReference(input: ConversationContentReference | null | undefined): ConversationContentReference | null {
  if (!input) return null
  return {
    type: cleanText(input.type, 'Content type', 80),
    providerMediaId: input.providerMediaId === null ? null : cleanText(input.providerMediaId, 'Provider media ID', 998),
    mimeType: input.mimeType === null ? null : cleanText(input.mimeType, 'Media type', 160),
    filename: input.filename === null ? null : cleanText(input.filename, 'Media filename', 512),
    caption: input.caption === null ? null : cleanText(input.caption, 'Media caption', 4_000),
  }
}

type InboxCursor = { lastInboundAt: string; id: string }

function encodeInboxCursor(cursor: InboxCursor): string {
  return btoa(JSON.stringify(cursor))
}

function decodeInboxCursor(value: string | undefined): InboxCursor | null {
  if (value === undefined) return null
  try {
    const parsed = JSON.parse(atob(cleanText(value, 'Inbox cursor', 2_000))) as Partial<InboxCursor>
    if (typeof parsed.lastInboundAt !== 'string' || typeof parsed.id !== 'string') throw new Error()
    return {
      lastInboundAt: cleanIsoTimestamp(parsed.lastInboundAt, 'Inbox cursor time'),
      id: cleanText(parsed.id, 'Inbox cursor conversation ID', 240),
    }
  } catch {
    throw new Error('Inbox cursor is invalid; restart with morrow_inbox_list without a cursor')
  }
}

class D1Communications implements Communications {
  private readonly db: D1Database
  private readonly now: () => Date
  private readonly uuid: () => string

  constructor(dependencies: CommunicationsDependencies) {
    this.db = dependencies.db
    this.now = dependencies.clock?.now.bind(dependencies.clock) ?? (() => new Date())
    this.uuid = dependencies.random?.uuid.bind(dependencies.random) ?? defaultUuid
  }

  async work(actor: Actor, selector: { kind: 'next' } | { kind: 'conversation'; id: string }): Promise<ConversationWorkspace | null>
  async work(actor: Actor, selector: { kind: 'queue'; limit?: number; cursor?: string }): Promise<ConversationQueue>
  async work(actor: Actor, selector: ConversationSelector): Promise<ConversationWorkspace | ConversationQueue | null> {
    await ensureOperator(this.db, actor, this.now)
    if (selector.kind === 'queue') {
      const limit = Math.max(1, Math.min(selector.limit ?? 100, 100))
      const cursor = decodeInboxCursor(selector.cursor)
      const rows = await this.db.prepare(
        `SELECT c.*,
                (SELECT COUNT(*) FROM communication_messages m WHERE m.conversation_id = c.id) AS message_count,
                (SELECT substr(m.body_text, 1, 1000) FROM communication_messages m
                 WHERE m.conversation_id = c.id AND m.direction = 'inbound'
                 ORDER BY COALESCE(m.source_created_at, m.created_at) DESC, m.rowid DESC LIMIT 1) AS latest_inbound_body,
                (SELECT CASE WHEN length(m.body_text) > 1000 THEN 1 ELSE 0 END FROM communication_messages m
                 WHERE m.conversation_id = c.id AND m.direction = 'inbound'
                 ORDER BY COALESCE(m.source_created_at, m.created_at) DESC, m.rowid DESC LIMIT 1) AS latest_inbound_truncated,
                (SELECT GROUP_CONCAT(r.target, ',') FROM communication_routes r WHERE r.conversation_id = c.id) AS route_targets
         FROM communication_conversations c
         WHERE c.attention_state <> 'handled'
           AND (? IS NULL OR c.last_inbound_at > ? OR (c.last_inbound_at = ? AND c.id > ?))
         ORDER BY c.last_inbound_at ASC, c.id ASC LIMIT ?`,
      ).bind(
        cursor?.lastInboundAt ?? null,
        cursor?.lastInboundAt ?? null,
        cursor?.lastInboundAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      ).all<ConversationQueueRow>()
      const page = rows.results.slice(0, limit)
      const hasMore = rows.results.length > limit
      const last = page.at(-1)
      return {
        kind: 'conversation_queue',
        conversations: page.map((row): ConversationQueueItem => ({
          id: row.id,
          channel: row.channel,
          contact: {
            name: row.contact_name,
            address: { kind: row.contact_address_kind, value: row.contact_address },
            email: row.contact_email,
            phone: row.contact_phone,
          },
          attention: row.attention_state,
          messageCount: row.message_count,
          latestInboundBody: row.latest_inbound_body ?? 'No inbound message',
          latestInboundTruncated: row.latest_inbound_truncated === 1,
          routeTargets: (row.route_targets?.split(',') ?? []).filter(
            (target): target is ConversationRouteLink['target'] => target === 'support' || target === 'sales',
          ),
          lastInboundAt: row.last_inbound_at,
        })),
        returned: page.length,
        hasMore,
        nextCursor: hasMore && last ? encodeInboxCursor({ lastInboundAt: last.last_inbound_at, id: last.id }) : null,
        nextAction: hasMore
          ? 'Pass nextCursor to morrow_inbox_list to load the next compact inbox page.'
          : null,
      }
    }
    const row = selector.kind === 'next'
      ? await this.db.prepare(
          `SELECT * FROM communication_conversations
           WHERE attention_state <> 'handled'
           ORDER BY last_inbound_at ASC, id ASC LIMIT 1`,
        ).first<ConversationRow>()
      : await this.db.prepare('SELECT * FROM communication_conversations WHERE id = ?')
          .bind(cleanText(selector.id, 'Conversation ID', 240)).first<ConversationRow>()
    return row ? this.workspace(row) : null
  }

  async ingest(eventInput: ConversationInboundEvent, intakeInput: ConversationIntake): Promise<ConversationIntakeReceipt> {
    const event: ConversationInboundEvent = {
      channel: cleanChannel(eventInput.channel),
      provider: cleanText(eventInput.provider, 'Provider', 120),
      providerEventId: cleanText(eventInput.providerEventId, 'Provider event ID', 998),
      providerMessageId: cleanText(eventInput.providerMessageId, 'Provider message ID', 998),
      accountId: cleanText(eventInput.accountId, 'Provider account ID', 128),
      endpointId: cleanText(eventInput.endpointId, 'Provider endpoint ID', 128),
      externalThreadId: cleanText(eventInput.externalThreadId, 'External thread ID', 320),
      occurredAt: cleanIsoTimestamp(eventInput.occurredAt, 'Provider event time'),
      payloadHash: cleanHash(eventInput.payloadHash),
    }
    const intake: ConversationIntake = {
      contact: {
        name: cleanText(intakeInput.contact.name, 'Contact name', 240),
        address: cleanContactAddress(intakeInput.contact.address),
      },
      body: cleanText(intakeInput.body, 'Message', 50_000),
      content: cleanContentReference(intakeInput.content),
    }
    if (event.channel === 'whatsapp' && intake.contact.address.kind !== 'phone') {
      throw new Error('WhatsApp conversations require a phone contact address')
    }
    if (event.channel === 'email' && intake.contact.address.kind !== 'email') {
      throw new Error('Email conversations require an email contact address')
    }
    const sourceCoordinate = `${event.provider}:${event.accountId}:${event.providerEventId}`
    const idempotencyKey = await sha256Text(`communications:${sourceCoordinate}`)
    const semanticEvent = { ...event, payloadHash: undefined }
    const commandHash = await sha256Text(canonicalJson({ event: semanticEvent, intake }))
    const providerReplay = await this.db.prepare(
      `SELECT payload_hash, conversation_id, message_id, operation_id
       FROM communication_provider_events WHERE provider = ? AND account_id = ? AND provider_event_id = ?`,
    ).bind(event.provider, event.accountId, event.providerEventId).first<ProviderEventRow>()
    const replay = await this.db.prepare(
      'SELECT id, command_hash, result_json FROM operation_receipts WHERE idempotency_key = ?',
    ).bind(idempotencyKey).first<ReceiptRow>()
    if (providerReplay || replay) {
      if (!replay) throw new Error('Provider event receipt is incomplete; reconcile before retrying')
      if (replay.command_hash !== commandHash) throw new Error('Provider event ID was already used for different content')
      const stored = JSON.parse(replay.result_json) as StoredReceipt
      if (providerReplay && (providerReplay.conversation_id !== stored.conversationId || providerReplay.operation_id !== replay.id)) {
        throw new Error('Provider event receipt does not match the recorded conversation')
      }
      const conversation = await this.load(stored.conversationId)
      if (!conversation) throw new Error('Conversation receipt points to missing state')
      return { operationId: replay.id, replayed: true, conversation }
    }

    const conversationCoordinate = `${event.channel}:${event.provider}:${event.accountId}:${event.endpointId}:${event.externalThreadId}`
    const active = await this.db.prepare(
      `SELECT id FROM communication_conversations
       WHERE channel = ? AND provider = ? AND account_id = ? AND endpoint_id = ? AND external_thread_id = ?
         AND attention_state = 'needs_attention'
       ORDER BY updated_at DESC, id DESC LIMIT 1`,
    ).bind(event.channel, event.provider, event.accountId, event.endpointId, event.externalThreadId).first<{ id: string }>()
    const conversationId = active?.id
      ?? `conversation_${(await sha256Text(`${conversationCoordinate}:${event.providerMessageId}`)).slice(0, 32)}`
    const messageId = `communication_message_${(await sha256Text(sourceCoordinate)).slice(0, 32)}`
    const revision = `rev_${this.uuid()}`
    const operationId = `op_${idempotencyKey.slice(0, 32)}`
    const now = this.now().toISOString()
    const stored: StoredReceipt = { conversationId }
    const contactEmail = intake.contact.address.kind === 'email' ? intake.contact.address.value : null
    const contactPhone = intake.contact.address.kind === 'phone' ? intake.contact.address.value : null
    try {
      await this.db.batch([
      this.db.prepare(
        `INSERT INTO communication_conversations
           (id, channel, provider, account_id, endpoint_id, external_thread_id, contact_name,
            contact_address_kind, contact_address, contact_email, contact_phone,
            attention_state, revision, last_inbound_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'needs_attention', ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           contact_name = excluded.contact_name,
           contact_address_kind = excluded.contact_address_kind,
           contact_address = excluded.contact_address,
           contact_email = excluded.contact_email,
           contact_phone = excluded.contact_phone,
           attention_state = 'needs_attention',
           revision = excluded.revision,
           version = communication_conversations.version + 1,
           last_inbound_at = CASE
             WHEN communication_conversations.last_inbound_at < excluded.last_inbound_at THEN excluded.last_inbound_at
             ELSE communication_conversations.last_inbound_at
           END,
           updated_at = excluded.updated_at`,
      ).bind(
        conversationId,
        event.channel,
        event.provider,
        event.accountId,
        event.endpointId,
        event.externalThreadId,
        intake.contact.name,
        intake.contact.address.kind,
        intake.contact.address.value,
        contactEmail,
        contactPhone,
        revision,
        event.occurredAt,
        now,
        now,
      ),
      this.db.prepare(
        `INSERT INTO communication_messages
           (id, conversation_id, direction, author_type, author_name, body_text,
            provider, provider_account_id, provider_message_id, provider_payload_hash, content_json, source_created_at, created_at)
         VALUES (?, ?, 'inbound', 'contact', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        messageId,
        conversationId,
        intake.contact.name,
        intake.body,
        event.provider,
        event.accountId,
        event.providerMessageId,
        event.payloadHash,
        intake.content ? JSON.stringify(intake.content) : null,
        event.occurredAt,
        now,
      ),
      this.db.prepare(
        `INSERT INTO operation_receipts
           (id, idempotency_key, scope, subject_type, subject_id, command_hash, result_json, created_at)
         VALUES (?, ?, 'communications', 'conversation', ?, ?, ?, ?)`,
      ).bind(operationId, idempotencyKey, conversationId, commandHash, JSON.stringify(stored), now),
      this.db.prepare(
        `INSERT INTO audit_events
           (id, subject_type, subject_id, actor_kind, event_type, evidence_json, source_created_at, created_at)
         VALUES (?, 'conversation', ?, 'system', 'communications.message_received', ?, ?, ?)`,
      ).bind(
        `audit_${this.uuid()}`,
        conversationId,
        JSON.stringify({
          channel: event.channel,
          provider: event.provider,
          providerEventId: event.providerEventId,
          providerMessageId: event.providerMessageId,
          payloadHash: event.payloadHash,
          bodyHash: await sha256Text(intake.body),
        }),
        event.occurredAt,
        now,
      ),
      this.db.prepare(
        `INSERT INTO communication_provider_events
           (id, provider, provider_event_id, channel, account_id, endpoint_id, payload_hash,
            occurred_at, received_at, conversation_id, message_id, operation_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `communication_event_${(await sha256Text(sourceCoordinate)).slice(0, 32)}`,
        event.provider,
        event.providerEventId,
        event.channel,
        event.accountId,
        event.endpointId,
        event.payloadHash,
        event.occurredAt,
        now,
        conversationId,
        messageId,
        operationId,
      ),
      ])
    } catch (error) {
      // A provider retry can race between the preflight read and the atomic
      // write. A completed receipt is stronger evidence than a duplicate-key
      // error, so return the original result when it describes this exact
      // normalized event.
      const racedReceipt = await this.db.prepare(
        'SELECT id, command_hash, result_json FROM operation_receipts WHERE idempotency_key = ?',
      ).bind(idempotencyKey).first<ReceiptRow>()
      if (!racedReceipt || racedReceipt.command_hash !== commandHash) throw error
      const racedStored = JSON.parse(racedReceipt.result_json) as StoredReceipt
      const racedConversation = await this.load(racedStored.conversationId)
      if (!racedConversation) throw error
      return { operationId: racedReceipt.id, replayed: true, conversation: racedConversation }
    }
    const conversation = await this.load(conversationId)
    if (!conversation) throw new Error('Received conversation could not be loaded')
    return { operationId, replayed: false, conversation }
  }

  async observeDelivery(observationInput: ConversationDeliveryObservation): Promise<void> {
    const observation: ConversationDeliveryObservation = {
      provider: cleanText(observationInput.provider, 'Delivery provider', 120),
      accountId: cleanText(observationInput.accountId, 'Delivery provider account ID', 128),
      providerMessageId: cleanText(observationInput.providerMessageId, 'Delivery provider message ID', 998),
      status: observationInput.status,
      occurredAt: cleanIsoTimestamp(observationInput.occurredAt, 'Delivery observation time'),
      payloadHash: cleanHash(observationInput.payloadHash),
    }
    if (!(['sent', 'delivered', 'read', 'failed'] as ConversationDeliveryObservation['status'][]).includes(observation.status)) {
      throw new Error('Delivery observation status is invalid')
    }
    const now = this.now().toISOString()
    const eventId = `communication_delivery_event_${(await sha256Text(canonicalJson({
      provider: observation.provider,
      accountId: observation.accountId,
      providerMessageId: observation.providerMessageId,
      status: observation.status,
      occurredAt: observation.occurredAt,
    }))).slice(0, 32)}`
    const statements: D1PreparedStatement[] = [
      // Keep the provider receipt, audit record, and any failed-delivery
      // projection in one transaction. If projection fails, a retry must be
      // able to perform it instead of seeing a premature receipt and exiting.
      this.db.prepare(
        `INSERT INTO communication_provider_delivery_events
           (id, provider, provider_account_id, provider_message_id, status, payload_hash, occurred_at, received_at,
            conversation_id, communication_message_id)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?,
                (SELECT m.conversation_id
                 FROM communication_messages m
                 JOIN communication_conversations c ON c.id = m.conversation_id
                 WHERE c.channel = 'whatsapp' AND m.provider = ? AND m.provider_account_id = ? AND m.provider_message_id = ?
                 ORDER BY m.rowid DESC LIMIT 1),
                (SELECT m.id
                 FROM communication_messages m
                 JOIN communication_conversations c ON c.id = m.conversation_id
                 WHERE c.channel = 'whatsapp' AND m.provider = ? AND m.provider_account_id = ? AND m.provider_message_id = ?
                 ORDER BY m.rowid DESC LIMIT 1)`,
      ).bind(
        eventId,
        observation.provider,
        observation.accountId,
        observation.providerMessageId,
        observation.status,
        observation.payloadHash,
        observation.occurredAt,
        now,
        observation.provider,
        observation.accountId,
        observation.providerMessageId,
        observation.provider,
        observation.accountId,
        observation.providerMessageId,
      ),
    ]
    statements.push(
      this.db.prepare(
        `INSERT INTO audit_events
           (id, subject_type, subject_id, actor_kind, event_type, evidence_json, source_created_at, created_at)
         SELECT ?, 'conversation', conversation_id, 'system', 'communications.delivery_status_observed', ?, ?, ?
         FROM communication_provider_delivery_events
         WHERE id = ? AND conversation_id IS NOT NULL`,
      ).bind(
        `audit_${eventId}`,
        JSON.stringify({
          provider: observation.provider,
          providerMessageId: observation.providerMessageId,
          status: observation.status,
          payloadHash: observation.payloadHash,
        }),
        observation.occurredAt,
        now,
        eventId,
      ),
    )
    if (observation.status === 'failed') {
      statements.push(
        this.db.prepare(
          `UPDATE outbox_rows
           SET state = 'blocked', last_error = ?, updated_at = ?
           WHERE communication_message_id = (
                   SELECT communication_message_id FROM communication_provider_delivery_events WHERE id = ?
                 )
             AND subject_type = 'conversation' AND state = 'accepted'`,
        ).bind('Meta reported a terminal delivery failure after accepting the message', now, eventId),
        this.db.prepare(
          `UPDATE communication_messages SET delivery_state = 'blocked'
           WHERE id = (SELECT communication_message_id FROM communication_provider_delivery_events WHERE id = ?)
             AND delivery_state = 'accepted'`,
        ).bind(eventId),
      )
    }
    try {
      await this.db.batch(statements)
    } catch (error) {
      // Webhook retries can race. A matching committed receipt makes this a
      // successful replay; anything else is a real persistence failure.
      const replay = await this.db.prepare(
        `SELECT id FROM communication_provider_delivery_events
         WHERE provider = ? AND provider_account_id = ? AND provider_message_id = ? AND status = ? AND occurred_at = ?`,
      ).bind(
        observation.provider,
        observation.accountId,
        observation.providerMessageId,
        observation.status,
        observation.occurredAt,
      ).first<{ id: string }>()
      if (replay) return
      throw error
    }
  }

  async act(actor: Actor, input: AttachConversationWorkCommand): Promise<ConversationActionReceipt>
  async act(actor: Actor, input: ReplyConversationCommand): Promise<ConversationActionReceipt>
  async act(actor: Actor, input: ClassifyConversationCommand): Promise<ConversationActionReceipt>
  async act(actor: Actor, input: ReopenConversationCommand): Promise<ConversationActionReceipt>
  async act(actor: Actor, input: ConversationCommand): Promise<ConversationActionReceipt> {
    const operator = await ensureOperator(this.db, actor, this.now)
    if (input.kind === 'reply') return this.reply(operator, input)
    if (input.kind === 'classify') return this.classify(operator, input)
    if (input.kind === 'reopen') return this.reopen(operator, input)
    const command: AttachConversationWorkCommand = {
      kind: 'attach_work',
      conversationId: cleanText(input.conversationId, 'Conversation ID', 240),
      revision: cleanText(input.revision, 'Conversation revision', 240) as ConversationRevision,
      intentId: cleanText(input.intentId, 'Intent ID', 240),
      link: {
        target: input.link.target,
        module: input.link.module,
        entityType: input.link.entityType,
        entityId: cleanText(input.link.entityId, 'Route entity ID', 240),
        intentId: cleanText(input.link.intentId, 'Routing intent ID', 240),
      },
      markHandled: input.markHandled,
    }
    const expected = command.link.target === 'support'
      ? { module: 'helpdesk', entityType: 'case' }
      : { module: 'crm', entityType: 'sales_lead' }
    if (command.link.module !== expected.module || command.link.entityType !== expected.entityType) {
      throw new Error('Conversation route target does not match its business module')
    }
    const commandHash = await sha256Text(canonicalJson(command))
    const idempotencyKey = await sha256Text(canonicalJson({ scope: 'communications', actor: operator.id, intentId: command.intentId }))
    const replay = await this.db.prepare(
      'SELECT id, command_hash, result_json FROM operation_receipts WHERE idempotency_key = ?',
    ).bind(idempotencyKey).first<ReceiptRow>()
    if (replay) {
      if (replay.command_hash !== commandHash) throw new Error('Intent ID was already used for a different Communications command')
      const stored = JSON.parse(replay.result_json) as StoredReceipt
      const conversation = await this.load(stored.conversationId)
      if (!conversation) throw new Error('Communications receipt points to missing state')
      return { operationId: replay.id, replayed: true, conversation, delivery: null, outbound: null }
    }
    const current = await this.load(command.conversationId)
    if (!current) throw new Error('Conversation not found')
    if (current.revision !== command.revision) throw new Error('The conversation changed; load the latest revision and try again')
    if (current.resolution) throw new Error('Use morrow_conversation_reopen before routing a final no-work classification')
    if (current.routes.some((route) => route.target === command.link.target)) {
      throw new Error(`Conversation is already routed to ${command.link.target}`)
    }
    const now = this.now().toISOString()
    const revision = `rev_${this.uuid()}`
    const operationId = `op_${this.uuid()}`
    const stored: StoredReceipt = { conversationId: command.conversationId }
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE communication_conversations
         SET attention_state = CASE WHEN ? = 1 THEN 'handled' ELSE attention_state END,
             revision = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND revision = ?`,
      ).bind(command.markHandled ? 1 : 0, revision, now, command.conversationId, command.revision),
      this.db.prepare(
        `INSERT INTO communication_routes
           (id, conversation_id, target, target_module, target_entity_type, target_entity_id, routing_intent_id, actor_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         FROM communication_conversations WHERE id = ? AND revision = ?`,
      ).bind(
        `route_${this.uuid()}`,
        command.conversationId,
        command.link.target,
        command.link.module,
        command.link.entityType,
        command.link.entityId,
        command.link.intentId,
        operator.id,
        now,
        command.conversationId,
        revision,
      ),
      this.db.prepare(
        `INSERT INTO audit_events
           (id, subject_type, subject_id, actor_id, actor_kind, event_type, evidence_json, created_at)
         SELECT ?, 'conversation', ?, ?, 'operator', 'communications.conversation_routed', ?, ?
         FROM communication_conversations WHERE id = ? AND revision = ?`,
      ).bind(
        `audit_${this.uuid()}`,
        command.conversationId,
        operator.id,
        JSON.stringify({ link: command.link, markHandled: command.markHandled, revision }),
        now,
        command.conversationId,
        revision,
      ),
      this.db.prepare(
        `INSERT INTO operation_receipts
           (id, idempotency_key, scope, actor_id, subject_type, subject_id, command_hash, result_json, created_at)
         SELECT ?, ?, 'communications', ?, 'conversation', ?, ?, ?, ?
         FROM communication_conversations WHERE id = ? AND revision = ?`,
      ).bind(
        operationId,
        idempotencyKey,
        operator.id,
        command.conversationId,
        commandHash,
        JSON.stringify(stored),
        now,
        command.conversationId,
        revision,
      ),
    ])
    if ((results[0]?.meta.changes ?? 0) !== 1) throw new Error('The conversation changed; load the latest revision and try again')
    const conversation = await this.load(command.conversationId)
    if (!conversation) throw new Error('Routed conversation could not be loaded')
    return { operationId, replayed: false, conversation, delivery: null, outbound: null }
  }

  private async classify(operator: Actor, input: ClassifyConversationCommand): Promise<ConversationActionReceipt> {
    const command: ClassifyConversationCommand = {
      kind: 'classify',
      conversationId: cleanText(input.conversationId, 'Conversation ID', 240),
      revision: cleanText(input.revision, 'Conversation revision', 240) as ConversationRevision,
      intentId: cleanText(input.intentId, 'Intent ID', 240),
      disposition: input.disposition,
      reason: cleanText(input.reason, 'Classification reason', 2_000),
    }
    if (!(['no_action', 'spam', 'duplicate'] as ConversationDisposition[]).includes(command.disposition)) {
      throw new Error('Conversation disposition is invalid')
    }
    const commandHash = await sha256Text(canonicalJson(command))
    const idempotencyKey = await sha256Text(canonicalJson({ scope: 'communications', actor: operator.id, intentId: command.intentId }))
    const replay = await this.db.prepare(
      'SELECT id, command_hash, result_json FROM operation_receipts WHERE idempotency_key = ?',
    ).bind(idempotencyKey).first<ReceiptRow>()
    if (replay) {
      if (replay.command_hash !== commandHash) throw new Error('Intent ID was already used for a different Communications command')
      const stored = JSON.parse(replay.result_json) as StoredReceipt
      const conversation = await this.load(stored.conversationId)
      if (!conversation) throw new Error('Communications receipt points to missing state')
      return { operationId: replay.id, replayed: true, conversation, delivery: null, outbound: null }
    }
    const current = await this.load(command.conversationId)
    if (!current) throw new Error('Conversation not found')
    if (current.revision !== command.revision) throw new Error('The conversation changed; load the latest revision and try again')
    if (current.routes.length > 0) throw new Error('A routed conversation cannot receive a no-work classification')
    if (current.attention !== 'needs_attention') {
      throw new Error(current.attention === 'delivery_problem'
        ? 'A delivery problem must be recovered, not classified'
        : 'Only a conversation that still needs triage can be classified')
    }
    const now = this.now().toISOString()
    const revision = `rev_${this.uuid()}`
    const operationId = `op_${this.uuid()}`
    const stored: StoredReceipt = { conversationId: command.conversationId }
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE communication_conversations
         SET attention_state = 'handled', final_disposition = ?, final_disposition_reason = ?, final_disposition_at = ?,
             revision = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND revision = ? AND attention_state = 'needs_attention' AND final_disposition IS NULL
           AND NOT EXISTS (SELECT 1 FROM communication_routes WHERE conversation_id = communication_conversations.id)`,
      ).bind(command.disposition, command.reason, now, revision, now, command.conversationId, command.revision),
      this.db.prepare(
        `INSERT INTO audit_events
           (id, subject_type, subject_id, actor_id, actor_kind, event_type, evidence_json, created_at)
         SELECT ?, 'conversation', ?, ?, 'operator', 'communications.conversation_classified', ?, ?
         FROM communication_conversations WHERE id = ? AND revision = ?`,
      ).bind(
        `audit_${this.uuid()}`,
        command.conversationId,
        operator.id,
        JSON.stringify({ disposition: command.disposition, reason: command.reason, revision }),
        now,
        command.conversationId,
        revision,
      ),
      this.db.prepare(
        `INSERT INTO operation_receipts
           (id, idempotency_key, scope, actor_id, subject_type, subject_id, command_hash, result_json, created_at)
         SELECT ?, ?, 'communications', ?, 'conversation', ?, ?, ?, ?
         FROM communication_conversations WHERE id = ? AND revision = ?`,
      ).bind(
        operationId,
        idempotencyKey,
        operator.id,
        command.conversationId,
        commandHash,
        JSON.stringify(stored),
        now,
        command.conversationId,
        revision,
      ),
    ])
    if ((results[0]?.meta.changes ?? 0) !== 1) throw new Error('The conversation changed; load the latest revision and try again')
    const conversation = await this.load(command.conversationId)
    if (!conversation) throw new Error('Classified conversation could not be loaded')
    return { operationId, replayed: false, conversation, delivery: null, outbound: null }
  }

  private async reopen(operator: Actor, input: ReopenConversationCommand): Promise<ConversationActionReceipt> {
    const command: ReopenConversationCommand = {
      kind: 'reopen',
      conversationId: cleanText(input.conversationId, 'Conversation ID', 240),
      revision: cleanText(input.revision, 'Conversation revision', 240) as ConversationRevision,
      intentId: cleanText(input.intentId, 'Intent ID', 240),
      reason: cleanText(input.reason, 'Reopen reason', 2_000),
    }
    const commandHash = await sha256Text(canonicalJson(command))
    const idempotencyKey = await sha256Text(canonicalJson({ scope: 'communications', actor: operator.id, intentId: command.intentId }))
    const replay = await this.db.prepare(
      'SELECT id, command_hash, result_json FROM operation_receipts WHERE idempotency_key = ?',
    ).bind(idempotencyKey).first<ReceiptRow>()
    if (replay) {
      if (replay.command_hash !== commandHash) throw new Error('Intent ID was already used for a different Communications command')
      const stored = JSON.parse(replay.result_json) as StoredReceipt
      const conversation = await this.load(stored.conversationId)
      if (!conversation) throw new Error('Communications receipt points to missing state')
      return { operationId: replay.id, replayed: true, conversation, delivery: null, outbound: null }
    }
    const current = await this.load(command.conversationId)
    if (!current) throw new Error('Conversation not found')
    if (current.revision !== command.revision) throw new Error('The conversation changed; load the latest revision and try again')
    if (!current.resolution) throw new Error('Only a final no-work classification can be reopened')
    const active = await this.db.prepare(
      `SELECT active.id FROM communication_conversations active
       JOIN communication_conversations current ON current.id = ?
       WHERE active.id <> current.id
         AND active.channel = current.channel
         AND active.provider = current.provider
         AND active.account_id = current.account_id
         AND active.endpoint_id = current.endpoint_id
         AND active.external_thread_id = current.external_thread_id
         AND active.attention_state = 'needs_attention'
       LIMIT 1`,
    ).bind(command.conversationId).first<{ id: string }>()
    if (active) throw new Error('A newer open conversation already owns this channel thread; route or reply through that conversation instead')
    const now = this.now().toISOString()
    const revision = `rev_${this.uuid()}`
    const operationId = `op_${this.uuid()}`
    const stored: StoredReceipt = { conversationId: command.conversationId }
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE communication_conversations
         SET attention_state = 'needs_attention', final_disposition = NULL, final_disposition_reason = NULL, final_disposition_at = NULL,
             revision = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND revision = ? AND final_disposition IS NOT NULL`,
      ).bind(revision, now, command.conversationId, command.revision),
      this.db.prepare(
        `INSERT INTO audit_events
           (id, subject_type, subject_id, actor_id, actor_kind, event_type, evidence_json, created_at)
         SELECT ?, 'conversation', ?, ?, 'operator', 'communications.conversation_reopened', ?, ?
         FROM communication_conversations WHERE id = ? AND revision = ?`,
      ).bind(
        `audit_${this.uuid()}`,
        command.conversationId,
        operator.id,
        JSON.stringify({ previousDisposition: current.resolution.disposition, reason: command.reason, revision }),
        now,
        command.conversationId,
        revision,
      ),
      this.db.prepare(
        `INSERT INTO operation_receipts
           (id, idempotency_key, scope, actor_id, subject_type, subject_id, command_hash, result_json, created_at)
         SELECT ?, ?, 'communications', ?, 'conversation', ?, ?, ?, ?
         FROM communication_conversations WHERE id = ? AND revision = ?`,
      ).bind(
        operationId,
        idempotencyKey,
        operator.id,
        command.conversationId,
        commandHash,
        JSON.stringify(stored),
        now,
        command.conversationId,
        revision,
      ),
    ])
    if ((results[0]?.meta.changes ?? 0) !== 1) throw new Error('The conversation changed; load the latest revision and try again')
    const conversation = await this.load(command.conversationId)
    if (!conversation) throw new Error('Reopened conversation could not be loaded')
    return { operationId, replayed: false, conversation, delivery: null, outbound: null }
  }

  private async reply(operator: Actor, input: ReplyConversationCommand): Promise<ConversationActionReceipt> {
    const command: ReplyConversationCommand = {
      kind: 'reply',
      conversationId: cleanText(input.conversationId, 'Conversation ID', 240),
      revision: cleanText(input.revision, 'Conversation revision', 240) as ConversationRevision,
      intentId: cleanText(input.intentId, 'Intent ID', 240),
      body: cleanText(input.body, 'Reply', 4_096),
    }
    const commandHash = await sha256Text(canonicalJson(command))
    const idempotencyKey = await sha256Text(canonicalJson({ scope: 'communications', actor: operator.id, intentId: command.intentId }))
    const replay = await this.db.prepare(
      'SELECT id, command_hash, result_json FROM operation_receipts WHERE idempotency_key = ?',
    ).bind(idempotencyKey).first<ReceiptRow>()
    if (replay) {
      if (replay.command_hash !== commandHash) throw new Error('Intent ID was already used for a different Communications command')
      const stored = JSON.parse(replay.result_json) as StoredReceipt
      const conversation = await this.load(stored.conversationId)
      if (!conversation) throw new Error('Communications receipt points to missing state')
      const delivery = stored.messageId
        ? conversation.messages.find((message) => message.id === stored.messageId)?.delivery ?? null
        : null
      return { operationId: replay.id, replayed: true, conversation, delivery, outbound: stored.outbound ?? null }
    }
    const row = await this.db.prepare('SELECT * FROM communication_conversations WHERE id = ?')
      .bind(command.conversationId).first<ConversationRow>()
    if (!row) throw new Error('Conversation not found')
    if (row.revision !== command.revision) throw new Error('The conversation changed; load the latest revision and try again')
    if (row.final_disposition) throw new Error('Use morrow_conversation_reopen before replying to a final no-work classification')
    const capability = replyCapability(row)
    if (!capability.available) throw new Error(capability.reason!)
    const now = this.now().toISOString()
    const revision = `rev_${this.uuid()}`
    const messageId = `communication_message_${this.uuid()}`
    const outboxId = `out_${this.uuid()}`
    const operationId = `op_${this.uuid()}`
    const recipient = row.external_thread_id.startsWith('+') ? row.external_thread_id : `+${row.external_thread_id}`
    const outbound: NonNullable<ConversationActionReceipt['outbound']> = {
      channel: row.channel,
      recipient,
      messageId,
      outboxId,
    }
    const stored: StoredReceipt = { conversationId: command.conversationId, messageId, outbound }
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE communication_conversations
         SET attention_state = 'handled', revision = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND revision = ?`,
      ).bind(revision, now, command.conversationId, command.revision),
      this.db.prepare(
        `INSERT INTO communication_messages
           (id, conversation_id, direction, author_type, operator_id, author_name, body_text, delivery_state, provider, provider_account_id, created_at)
         SELECT ?, ?, 'outbound', 'operator', ?, ?, ?, 'queued', provider, account_id, ?
         FROM communication_conversations WHERE id = ? AND revision = ?`,
      ).bind(messageId, command.conversationId, operator.id, operator.name, command.body, now, command.conversationId, revision),
      this.db.prepare(
        `INSERT INTO outbox_rows
           (id, subject_type, subject_id, communication_message_id, kind, recipient, subject, body_text, body_html, state, created_at, updated_at)
         SELECT ?, 'conversation', ?, ?, 'whatsapp_reply', ?, '', ?, '', 'queued', ?, ?
         FROM communication_conversations WHERE id = ? AND revision = ?`,
      ).bind(outboxId, command.conversationId, messageId, recipient, command.body, now, now, command.conversationId, revision),
      this.db.prepare(
        `INSERT INTO audit_events
           (id, subject_type, subject_id, actor_id, actor_kind, event_type, evidence_json, created_at)
         SELECT ?, 'conversation', ?, ?, 'operator', 'communications.reply_queued', ?, ?
         FROM communication_conversations WHERE id = ? AND revision = ?`,
      ).bind(
        `audit_${this.uuid()}`,
        command.conversationId,
        operator.id,
        JSON.stringify({ messageId, bodyLength: command.body.length, bodyHash: await sha256Text(command.body), revision }),
        now,
        command.conversationId,
        revision,
      ),
      this.db.prepare(
        `INSERT INTO operation_receipts
           (id, idempotency_key, scope, actor_id, subject_type, subject_id, command_hash, result_json, created_at)
         SELECT ?, ?, 'communications', ?, 'conversation', ?, ?, ?, ?
         FROM communication_conversations WHERE id = ? AND revision = ?`,
      ).bind(
        operationId,
        idempotencyKey,
        operator.id,
        command.conversationId,
        commandHash,
        JSON.stringify(stored),
        now,
        command.conversationId,
        revision,
      ),
    ])
    if ((results[0]?.meta.changes ?? 0) !== 1) throw new Error('The conversation changed; load the latest revision and try again')
    const conversation = await this.load(command.conversationId)
    if (!conversation) throw new Error('Replied conversation could not be loaded')
    return { operationId, replayed: false, conversation, delivery: 'queued', outbound }
  }

  private async load(id: string): Promise<ConversationWorkspace | null> {
    const row = await this.db.prepare('SELECT * FROM communication_conversations WHERE id = ?').bind(id).first<ConversationRow>()
    return row ? this.workspace(row) : null
  }

  private async workspace(row: ConversationRow): Promise<ConversationWorkspace> {
    const [messages, routes] = await Promise.all([
      this.db.prepare(
        `SELECT id, direction, author_name, body_text, delivery_state, provider_message_id, content_json, source_created_at, created_at
         FROM communication_messages WHERE conversation_id = ?
         ORDER BY COALESCE(source_created_at, created_at) ASC, rowid ASC`,
      ).bind(row.id).all<MessageRow>(),
      this.db.prepare(
        `SELECT target, target_module, target_entity_type, target_entity_id, routing_intent_id, created_at
         FROM communication_routes WHERE conversation_id = ? ORDER BY created_at ASC, id ASC`,
      ).bind(row.id).all<RouteRow>(),
    ])
    return {
      kind: 'conversation',
      id: row.id,
      revision: row.revision as ConversationRevision,
      channel: row.channel,
      contact: {
        channelContactId: `contact_${(await sha256Text(`${row.channel}:${row.provider}:${row.account_id}:${row.endpoint_id}:${row.external_thread_id}`)).slice(0, 32)}`,
        name: row.contact_name,
        address: { kind: row.contact_address_kind, value: row.contact_address },
        email: row.contact_email,
        phone: row.contact_phone,
      },
      replyCapability: replyCapability(row),
      attention: row.attention_state,
      resolution: row.final_disposition && row.final_disposition_reason && row.final_disposition_at
        ? {
            disposition: row.final_disposition,
            reason: row.final_disposition_reason,
            classifiedAt: row.final_disposition_at,
          } satisfies ConversationResolution
        : null,
      messages: messages.results.map((message): ConversationMessage => ({
        id: message.id,
        direction: message.direction,
        author: message.author_name,
        body: message.body_text,
        delivery: message.delivery_state,
        providerMessageId: message.provider_message_id,
        content: message.content_json ? JSON.parse(message.content_json) as ConversationContentReference : null,
        occurredAt: message.source_created_at ?? message.created_at,
      })),
      routes: routes.results.map((route): ConversationRouteLink => ({
        target: route.target,
        module: route.target_module,
        entityType: route.target_entity_type,
        entityId: route.target_entity_id,
        intentId: route.routing_intent_id,
        createdAt: route.created_at,
      })),
      lastInboundAt: row.last_inbound_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}

export function createCommunications(dependencies: CommunicationsDependencies): Communications {
  return new D1Communications(dependencies)
}
