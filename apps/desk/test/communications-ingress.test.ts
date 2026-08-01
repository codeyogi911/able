import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createCommunications } from '../src/communications'
import { createCrm } from '../src/crm'
import { createDirectory } from '../src/directory'
import type { Actor } from '../src/domain/types'
import { createHelpdesk } from '../src/helpdesk'
import { createConversationRouter } from '../src/suite/conversation-routing'

const actor: Actor = {
  id: 'generic-ingress-agent',
  email: 'generic-ingress-agent@example.test',
  name: 'Generic Ingress Agent',
  role: 'agent',
}

const emailEvent = {
  channel: 'email',
  provider: 'cloudflare_email',
  providerEventId: 'event-email-001',
  providerMessageId: 'message-email-001',
  accountId: 'example.test',
  endpointId: 'support@example.test',
  externalThreadId: 'thread-email-001',
  occurredAt: '2026-07-21T09:00:00.000Z',
  payloadHash: 'a'.repeat(64),
}

const emailIntake = {
  contact: {
    name: 'Email Prospect',
    address: { kind: 'email', value: 'prospect@example.test' },
  },
  body: 'Could you quote five routers for our new office?',
}

describe('channel-neutral Communications ingress', () => {
  it('persists one email conversation and provider-event receipt across a replay', async () => {
    const communications = createCommunications({ db: env.DB })

    const first = await communications.ingest(emailEvent, emailIntake)
    const replay = await communications.ingest(emailEvent, emailIntake)

    expect(first).toMatchObject({ replayed: false, conversation: {
      channel: 'email',
      contact: { name: 'Email Prospect', address: { kind: 'email', value: 'prospect@example.test' } },
      messages: [{ providerMessageId: 'message-email-001', body: emailIntake.body }],
    } })
    expect(replay).toMatchObject({ replayed: true, operationId: first.operationId, conversation: { id: first.conversation.id } })
    expect(await env.DB.prepare(
      `SELECT provider, provider_event_id, conversation_id, message_id
       FROM communication_provider_events`,
    ).first()).toEqual({
      provider: 'cloudflare_email',
      provider_event_id: 'event-email-001',
      conversation_id: first.conversation.id,
      message_id: first.conversation.messages[0]!.id,
    })
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM communication_messages').first()).toEqual({ count: 1 })
  })

  it('rejects a provider event ID reused for different business content', async () => {
    const communications = createCommunications({ db: env.DB })
    await communications.ingest(emailEvent, emailIntake)

    await expect(communications.ingest(emailEvent, {
      ...emailIntake,
      body: 'The same provider event must not create different business work.',
    })).rejects.toThrow('Provider event ID was already used for different content')
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM communication_messages').first()).toEqual({ count: 1 })
  })

  it('converges concurrent deliveries of the same provider event on one receipt', async () => {
    const communications = createCommunications({ db: env.DB })

    const receipts = await Promise.all([
      communications.ingest(emailEvent, emailIntake),
      communications.ingest(emailEvent, emailIntake),
    ])

    expect(receipts.map((receipt) => receipt.replayed).sort()).toEqual([false, true])
    expect(new Set(receipts.map((receipt) => receipt.operationId)).size).toBe(1)
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM communication_provider_events').first()).toEqual({ count: 1 })
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM communication_messages').first()).toEqual({ count: 1 })
  })

  it('returns a stable continuation cursor rather than silently dropping inbox rows', async () => {
    const communications = createCommunications({ db: env.DB })
    const receipts = await Promise.all([0, 1, 2].map((index) => communications.ingest({
      ...emailEvent,
      providerEventId: `event-email-page-${index}`,
      providerMessageId: `message-email-page-${index}`,
      externalThreadId: `thread-email-page-${index}`,
      occurredAt: `2026-07-21T09:0${index}:00.000Z`,
      payloadHash: `${index}`.repeat(64),
    }, {
      ...emailIntake,
      body: `Email message ${index}`,
    })))

    const first = await communications.work(actor, { kind: 'queue', limit: 2 })
    expect(first).toMatchObject({ returned: 2, hasMore: true, nextCursor: expect.any(String) })
    const second = await communications.work(actor, { kind: 'queue', limit: 2, cursor: first.nextCursor! })
    expect(second).toMatchObject({ returned: 1, hasMore: false, nextCursor: null })
    expect(new Set([
      ...first.conversations.map((conversation) => conversation.id),
      ...second.conversations.map((conversation) => conversation.id),
    ])).toEqual(new Set(receipts.map((receipt) => receipt.conversation.id)))
  })

  it('uses the normalized email identity when routing to Desk and CRM', async () => {
    const communications = createCommunications({ db: env.DB })
    const receipt = await communications.ingest(emailEvent, emailIntake)
    const directory = createDirectory({ db: env.DB })
    const crm = createCrm({ db: env.DB, directory })
    const helpdesk = createHelpdesk({
      db: env.DB,
      attachments: env.ATTACHMENTS,
      baseUrl: 'https://support.example.test',
      capabilitySecret: 'generic-ingress-capability-secret',
    })
    const router = createConversationRouter({ communications, directory, crm, helpdesk })

    const routed = await router.route(actor, {
      conversationId: receipt.conversation.id,
      revision: receipt.conversation.revision,
      intentId: 'route-email-to-both',
      target: 'both',
    })

    expect(routed).toMatchObject({ completed: ['support', 'sales'], pending: [] })
    const support = routed.links.find((link) => link.target === 'support')!
    const desk = await helpdesk.work(actor, { kind: 'case', ref: support.entityId })
    expect(desk).toMatchObject({
      kind: 'case',
      channel: 'email',
      customer: { name: 'Email Prospect', email: 'prospect@example.test', phone: null },
    })
    const party = await directory.work(actor, {
      kind: 'external',
      source: { module: 'communications', entityType: 'contact', entityId: receipt.conversation.contact.channelContactId },
    })
    expect(party).toMatchObject({ contactPoints: [{ kind: 'email', value: 'prospect@example.test', primary: true }] })
  })

  it('keeps an opaque channel contact in triage with an actionable sales-routing reason', async () => {
    const communications = createCommunications({ db: env.DB })
    const receipt = await communications.ingest({
      channel: 'web_chat',
      provider: 'embedded_chat',
      providerEventId: 'event-web-chat-001',
      providerMessageId: 'message-web-chat-001',
      accountId: 'example.test',
      endpointId: 'website',
      externalThreadId: 'anonymous-session-001',
      occurredAt: '2026-07-21T10:00:00.000Z',
      payloadHash: 'b'.repeat(64),
    }, {
      contact: {
        name: 'Website visitor',
        address: { kind: 'opaque', value: 'anonymous-session-001' },
      },
      body: 'Can someone send me a proposal?',
    })
    const directory = createDirectory({ db: env.DB })
    const crm = createCrm({ db: env.DB, directory })
    const helpdesk = createHelpdesk({
      db: env.DB,
      attachments: env.ATTACHMENTS,
      baseUrl: 'https://support.example.test',
      capabilitySecret: 'opaque-contact-capability-secret',
    })
    const router = createConversationRouter({ communications, directory, crm, helpdesk })

    const routed = await router.route(actor, {
      conversationId: receipt.conversation.id,
      revision: receipt.conversation.revision,
      intentId: 'route-opaque-contact-to-sales',
      target: 'sales',
    })

    expect(routed).toMatchObject({
      completed: [],
      pending: ['sales'],
      pendingReasons: [{ target: 'sales', code: 'invalid_input' }],
      conversation: { attention: 'needs_attention' },
    })
  })

  it('rejects a reply when no delivery adapter owns that channel', async () => {
    const communications = createCommunications({ db: env.DB })
    const receipt = await communications.ingest(emailEvent, emailIntake)

    await expect(communications.act(actor, {
      kind: 'reply',
      conversationId: receipt.conversation.id,
      revision: receipt.conversation.revision,
      intentId: 'reply-over-uninstalled-email-channel',
      body: 'We can help with that quote.',
    })).rejects.toThrow('No delivery adapter is installed for email')
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM outbox_rows').first()).toEqual({ count: 0 })
  })
})
