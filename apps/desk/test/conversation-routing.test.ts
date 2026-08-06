import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createCommunications } from '../src/communications'
import type { Communications } from '../src/communications'
import { createCrm } from '../src/crm'
import { createDirectory } from '../src/directory'
import type { Actor } from '../src/domain/types'
import { createHelpdesk } from '../src/helpdesk'
import { createConversationRouter } from '../src/suite/conversation-routing'

const actor: Actor = {
  id: 'conversation-agent',
  email: 'conversation-agent@example.test',
  name: 'Conversation Agent',
  role: 'agent',
}

async function inboundConversation(messageId = 'wamid.sales-inquiry') {
  const communications = createCommunications({ db: env.DB })
  const receipt = await communications.ingest({
    channel: 'whatsapp',
    provider: 'meta_whatsapp',
    providerEventId: messageId,
    providerMessageId: messageId,
    accountId: 'test-waba-id',
    endpointId: 'test-phone-number-id',
    externalThreadId: '15550002000',
    occurredAt: '2026-07-20T10:00:00.000Z',
    payloadHash: 'a'.repeat(64),
  }, {
    contact: { name: 'WhatsApp Prospect', address: { kind: 'phone', value: '+15550002000' } },
    body: 'Can you quote ten conference displays for our offices?',
  })
  return { communications, conversation: receipt.conversation }
}

describe('conversation routing', () => {
  it('routes buying intent to a first-class CRM sales lead without creating a support case', async () => {
    const { communications, conversation } = await inboundConversation()
    const directory = createDirectory({ db: env.DB })
    const crm = createCrm({ db: env.DB, directory })
    const helpdesk = createHelpdesk({
      db: env.DB,
      attachments: env.ATTACHMENTS,
      baseUrl: 'https://support.example.test',
      capabilitySecret: 'conversation-routing-capability-secret',
    })
    const router = createConversationRouter({ communications, directory, crm, helpdesk })

    const routed = await router.route(actor, {
      conversationId: conversation.id,
      revision: conversation.revision,
      intentId: 'route-sales-inquiry',
      target: 'sales',
    })

    expect(routed).toMatchObject({
      kind: 'conversation_route',
      conversationId: conversation.id,
      completed: ['sales'],
      pending: [],
      links: [{ target: 'sales', entityType: 'sales_lead' }],
    })
    const party = await directory.work(actor, {
      kind: 'external',
      source: { module: 'communications', entityType: 'contact', entityId: conversation.contact.channelContactId },
    })
    expect(party).toMatchObject({
      displayName: 'WhatsApp Prospect',
      contactPoints: [{ kind: 'phone', value: '+15550002000', primary: true }],
    })
    const crmWorkspace = await crm.work(actor, { kind: 'party', partyId: party!.id })
    expect(crmWorkspace.salesLeads).toEqual([
      expect.objectContaining({
        title: 'WhatsApp inquiry from WhatsApp Prospect',
        summary: 'Can you quote ten conference displays for our offices?',
        status: 'new',
        source: { module: 'communications', entityType: 'conversation', entityId: conversation.id },
      }),
    ])
    expect((await helpdesk.work(actor, { kind: 'queue', limit: 10 })).cases).toEqual([])
    expect((await communications.work(actor, { kind: 'conversation', id: conversation.id }))).toMatchObject({
      attention: 'handled',
      routes: [{ target: 'sales', entityType: 'sales_lead' }],
    })
    const replay = await router.route(actor, {
      conversationId: conversation.id,
      revision: conversation.revision,
      intentId: 'route-sales-inquiry',
      target: 'sales',
    })
    expect(replay).toMatchObject({ completed: ['sales'], pending: [] })
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM crm_sales_leads').first()).toEqual({ count: 1 })

    const later = await communications.ingest({
      channel: 'whatsapp',
      provider: 'meta_whatsapp',
      providerEventId: 'wamid.later-sales-inquiry',
      providerMessageId: 'wamid.later-sales-inquiry',
      accountId: 'test-waba-id',
      endpointId: 'test-phone-number-id',
      externalThreadId: '15550002000',
      occurredAt: '2026-07-20T11:00:00.000Z',
      payloadHash: 'c'.repeat(64),
    }, {
      contact: { name: 'WhatsApp Prospect', address: { kind: 'phone', value: '+15550002000' } },
      body: 'We now need another quote for a second office.',
    })
    expect(later.conversation.id).not.toBe(conversation.id)
    expect(later.conversation.contact.channelContactId).toBe(conversation.contact.channelContactId)
    await router.route(actor, {
      conversationId: later.conversation.id,
      revision: later.conversation.revision,
      intentId: 'route-later-sales-inquiry',
      target: 'sales',
    })
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM directory_parties').first()).toEqual({ count: 1 })
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM crm_sales_leads').first()).toEqual({ count: 2 })
  })

  it('routes support intent to Desk while preserving the Communications provenance', async () => {
    const { communications, conversation } = await inboundConversation()
    const directory = createDirectory({ db: env.DB })
    const crm = createCrm({ db: env.DB, directory })
    const helpdesk = createHelpdesk({
      db: env.DB,
      attachments: env.ATTACHMENTS,
      baseUrl: 'https://support.example.test',
      capabilitySecret: 'conversation-routing-capability-secret',
    })
    const router = createConversationRouter({ communications, directory, crm, helpdesk })

    const routed = await router.route(actor, {
      conversationId: conversation.id,
      revision: conversation.revision,
      intentId: 'route-support-inquiry',
      target: 'support',
    })

    expect(routed).toMatchObject({ completed: ['support'], pending: [] })
    const cases = await helpdesk.work(actor, { kind: 'queue', limit: 10 })
    expect(cases.kind).toBe('queue')
    expect(cases.cases).toHaveLength(1)
    const deskCase = await helpdesk.work(actor, { kind: 'case', ref: cases.cases[0]!.ref })
    expect(deskCase).toMatchObject({
      subject: 'WhatsApp conversation with WhatsApp Prospect',
      channel: 'whatsapp',
      customer: { name: 'WhatsApp Prospect', phone: '+15550002000', email: null },
    })
    expect(routed.links).toEqual([
      expect.objectContaining({ target: 'support', module: 'helpdesk', entityType: 'case' }),
    ])
  })

  it('routes one conversation to both modules without collapsing lead and case', async () => {
    const { communications, conversation } = await inboundConversation()
    const directory = createDirectory({ db: env.DB })
    const crm = createCrm({ db: env.DB, directory })
    const helpdesk = createHelpdesk({
      db: env.DB,
      attachments: env.ATTACHMENTS,
      baseUrl: 'https://support.example.test',
      capabilitySecret: 'conversation-routing-capability-secret',
    })
    const router = createConversationRouter({ communications, directory, crm, helpdesk })

    const routed = await router.route(actor, {
      conversationId: conversation.id,
      revision: conversation.revision,
      intentId: 'route-both-inquiry',
      target: 'both',
    })

    expect(routed).toMatchObject({
      completed: ['support', 'sales'],
      pending: [],
      links: [
        { target: 'support', module: 'helpdesk', entityType: 'case' },
        { target: 'sales', module: 'crm', entityType: 'sales_lead' },
      ],
      conversation: { attention: 'handled' },
    })
    expect((await helpdesk.work(actor, { kind: 'queue', limit: 10 })).cases).toHaveLength(1)
    const party = await directory.work(actor, {
      kind: 'external',
      source: { module: 'communications', entityType: 'contact', entityId: conversation.contact.channelContactId },
    })
    expect((await crm.work(actor, { kind: 'party', partyId: party!.id })).salesLeads).toHaveLength(1)
    const supportLink = routed.links.find((link) => link.target === 'support')!
    const desk = await helpdesk.work(actor, { kind: 'case', ref: supportLink.entityId })
    if (desk.kind !== 'case') throw new Error('Expected routed case')
    expect(await directory.work(actor, {
      kind: 'external',
      source: { module: 'helpdesk', entityType: 'customer', entityId: desk.customer.id },
    })).toMatchObject({ id: party!.id })
  })

  it('recovers downstream work after a revision race without creating a duplicate case', async () => {
    const { communications, conversation } = await inboundConversation()
    const directory = createDirectory({ db: env.DB })
    const crm = createCrm({ db: env.DB, directory })
    const helpdesk = createHelpdesk({
      db: env.DB,
      attachments: env.ATTACHMENTS,
      baseUrl: 'https://support.example.test',
      capabilitySecret: 'conversation-routing-capability-secret',
    })
    let raced = false
    const racingCommunications = {
      work: communications.work.bind(communications),
      ingest: communications.ingest.bind(communications),
      act: async (acting: Actor, command: Parameters<Communications['act']>[1]) => {
        if (!raced && command.kind === 'attach_work') {
          raced = true
          await communications.ingest({
            channel: 'whatsapp',
            provider: 'meta_whatsapp',
            providerEventId: 'wamid.routing-race',
            providerMessageId: 'wamid.routing-race',
            accountId: 'test-waba-id',
            endpointId: 'test-phone-number-id',
            externalThreadId: '15550002000',
            occurredAt: '2026-07-20T10:01:00.000Z',
            payloadHash: 'b'.repeat(64),
          }, {
            contact: { name: 'WhatsApp Prospect', address: { kind: 'phone', value: '+15550002000' } },
            body: 'One more detail before you route this.',
          })
        }
        return communications.act(acting, command)
      },
    } as Communications
    const router = createConversationRouter({ communications: racingCommunications, directory, crm, helpdesk })

    const partial = await router.route(actor, {
      conversationId: conversation.id,
      revision: conversation.revision,
      intentId: 'route-support-race',
      target: 'support',
    })
    expect(partial).toMatchObject({ completed: [], pending: ['support'], conversation: { attention: 'needs_attention' } })
    expect((await helpdesk.work(actor, { kind: 'queue', limit: 10 })).cases).toHaveLength(1)

    const latest = await communications.work(actor, { kind: 'conversation', id: conversation.id })
    if (!latest) throw new Error('Expected raced conversation')
    const recovered = await router.route(actor, {
      conversationId: conversation.id,
      revision: latest.revision,
      intentId: 'route-support-race',
      target: 'support',
    })
    expect(recovered).toMatchObject({ completed: ['support'], pending: [], conversation: { attention: 'handled' } })
    expect((await helpdesk.work(actor, { kind: 'queue', limit: 10 })).cases).toHaveLength(1)
  })

  it('keeps a partially routed dual-intent conversation visible for recovery', async () => {
    const { communications, conversation } = await inboundConversation()
    const directory = createDirectory({ db: env.DB })
    const crm = createCrm({ db: env.DB, directory })
    const helpdesk = createHelpdesk({
      db: env.DB,
      attachments: env.ATTACHMENTS,
      baseUrl: 'https://support.example.test',
      capabilitySecret: 'conversation-routing-capability-secret',
    })
    let deskAvailable = false
    const unavailableHelpdesk = {
      work: helpdesk.work.bind(helpdesk),
      async act(acting: Actor, command: Parameters<typeof helpdesk.act>[1]) {
        if (!deskAvailable) throw new Error('Desk unavailable')
        return helpdesk.act(acting, command)
      },
    }
    const router = createConversationRouter({ communications, directory, crm, helpdesk: unavailableHelpdesk })

    const routed = await router.route(actor, {
      conversationId: conversation.id,
      revision: conversation.revision,
      intentId: 'route-partial-both',
      target: 'both',
    })

    expect(routed).toMatchObject({
      completed: ['sales'],
      pending: ['support'],
      pendingReasons: [{ target: 'support', code: 'dependency_unavailable' }],
      nextAction: expect.stringContaining('pending target'),
      links: [{ target: 'sales', entityType: 'sales_lead' }],
      conversation: { attention: 'needs_attention' },
    })
    expect((await communications.work(actor, { kind: 'next' }))).toMatchObject({ id: conversation.id })

    deskAvailable = true
    const recovered = await router.route(actor, {
      conversationId: conversation.id,
      revision: conversation.revision,
      intentId: 'route-partial-both',
      target: 'both',
    })
    expect(recovered).toMatchObject({
      completed: ['support', 'sales'],
      pending: [],
      conversation: { attention: 'handled' },
    })
    const party = await directory.work(actor, {
      kind: 'external',
      source: { module: 'communications', entityType: 'contact', entityId: conversation.contact.channelContactId },
    })
    const support = recovered.links.find((link) => link.target === 'support')!
    const desk = await helpdesk.work(actor, { kind: 'case', ref: support.entityId })
    if (desk.kind !== 'case') throw new Error('Expected recovered support case')
    expect(await directory.work(actor, {
      kind: 'external',
      source: { module: 'helpdesk', entityType: 'customer', entityId: desk.customer.id },
    })).toMatchObject({ id: party!.id })
  })

  it('records a final no-work disposition without leaving the conversation in the inbox', async () => {
    const { communications, conversation } = await inboundConversation()

    const receipt = await communications.act(actor, {
      kind: 'classify',
      conversationId: conversation.id,
      revision: conversation.revision,
      intentId: 'classify-duplicate-sales-inquiry',
      disposition: 'duplicate',
      reason: 'The customer already has an active conversation for this quote request.',
    })

    expect(receipt).toMatchObject({
      replayed: false,
      delivery: null,
      conversation: {
        attention: 'handled',
        resolution: {
          disposition: 'duplicate',
          reason: 'The customer already has an active conversation for this quote request.',
        },
      },
    })
    expect(await communications.work(actor, { kind: 'conversation', id: conversation.id })).toMatchObject({
      resolution: { disposition: 'duplicate' },
    })
    expect(await communications.work(actor, { kind: 'next' })).toBeNull()
    expect((await communications.work(actor, { kind: 'queue', limit: 20 })).conversations).toEqual([])
    expect(await env.DB.prepare(
      `SELECT event_type, evidence_json FROM audit_events
       WHERE subject_type = 'conversation' AND subject_id = ? AND event_type = 'communications.conversation_classified'`,
    ).bind(conversation.id).first()).toMatchObject({
      event_type: 'communications.conversation_classified',
      evidence_json: expect.stringContaining('duplicate'),
    })

    const replay = await communications.act(actor, {
      kind: 'classify',
      conversationId: conversation.id,
      revision: conversation.revision,
      intentId: 'classify-duplicate-sales-inquiry',
      disposition: 'duplicate',
      reason: 'The customer already has an active conversation for this quote request.',
    })
    expect(replay).toMatchObject({ replayed: true, conversation: { attention: 'handled' } })
    await expect(communications.act(actor, {
      kind: 'attach_work',
      conversationId: conversation.id,
      revision: receipt.conversation.revision,
      intentId: 'route-after-final-disposition',
      link: {
        target: 'sales',
        module: 'crm',
        entityType: 'sales_lead',
        entityId: 'lead-after-final-disposition',
        intentId: 'sales-after-final-disposition',
      },
      markHandled: true,
    })).rejects.toThrow('final no-work classification')
    const reopened = await communications.act(actor, {
      kind: 'reopen',
      conversationId: conversation.id,
      revision: receipt.conversation.revision,
      intentId: 'reopen-incorrect-duplicate-classification',
      reason: 'The active quote request is not a duplicate.',
    })
    expect(reopened).toMatchObject({
      conversation: { attention: 'needs_attention', resolution: null },
      delivery: null,
    })
    expect(await env.DB.prepare(
      `SELECT event_type, evidence_json FROM audit_events
       WHERE subject_type = 'conversation' AND subject_id = ? AND event_type = 'communications.conversation_reopened'`,
    ).bind(conversation.id).first()).toMatchObject({
      event_type: 'communications.conversation_reopened',
      evidence_json: expect.stringContaining('duplicate'),
    })
  })

  it('rejects no-work classification after routing or when delivery recovery is needed', async () => {
    const { communications, conversation } = await inboundConversation()
    const routed = await communications.act(actor, {
      kind: 'attach_work',
      conversationId: conversation.id,
      revision: conversation.revision,
      intentId: 'link-support-before-classification',
      link: {
        target: 'support',
        module: 'helpdesk',
        entityType: 'case',
        entityId: 'AD-1',
        intentId: 'route-support-before-classification',
      },
      markHandled: true,
    })
    await expect(communications.act(actor, {
      kind: 'classify',
      conversationId: conversation.id,
      revision: routed.conversation.revision,
      intentId: 'classify-routed-conversation',
      disposition: 'no_action',
      reason: 'This must not erase linked support work.',
    })).rejects.toThrow('routed conversation')

    const { communications: recoveryCommunications, conversation: recoveryConversation } = await inboundConversation('wamid.delivery-recovery')
    await env.DB.prepare(
      `UPDATE communication_conversations
       SET attention_state = 'delivery_problem', revision = 'rev_delivery-problem'
       WHERE id = ?`,
    ).bind(recoveryConversation.id).run()
    const recovery = await recoveryCommunications.work(actor, { kind: 'conversation', id: recoveryConversation.id })
    if (!recovery) throw new Error('Expected delivery-problem conversation')
    await expect(recoveryCommunications.act(actor, {
      kind: 'classify',
      conversationId: recovery.id,
      revision: recovery.revision,
      intentId: 'classify-delivery-problem',
      disposition: 'spam',
      reason: 'This must not hide delivery recovery.',
    })).rejects.toThrow('delivery problem')
  })
})
