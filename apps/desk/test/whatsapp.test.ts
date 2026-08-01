import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createCommunications } from '../src/communications'
import { deliverOutbox } from '../src/email/outbox'
import type { Env } from '../src/env'

const APP_SECRET = 'whatsapp-test-app-secret'

async function signedNotification(payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload)
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(APP_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  const hex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return SELF.fetch('https://support.example.test/webhooks/whatsapp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${hex}`,
    },
    body,
  })
}

function textNotification(messageId: string, body: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'test-waba-id',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550001000', phone_number_id: 'test-phone-number-id' },
          contacts: [{ profile: { name: 'WhatsApp Customer' }, wa_id: '15550002000' }],
          messages: [{
            from: '15550002000',
            id: messageId,
            timestamp,
            type: 'text',
            text: { body },
          }],
        },
      }],
    }],
  }
}

function statusNotification(messageId: string, status: 'sent' | 'delivered' | 'read' | 'failed', timestamp = String(Math.floor(Date.now() / 1_000))) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'test-waba-id',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550001000', phone_number_id: 'test-phone-number-id' },
          statuses: [{ id: messageId, status, timestamp }],
        },
      }],
    }],
  }
}

describe('WhatsApp Cloud API boundary', () => {
  it('echoes Meta webhook challenges only when the verification token matches', async () => {
    const accepted = await SELF.fetch(
      'https://support.example.test/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=whatsapp-test-verify-token&hub.challenge=challenge-123',
    )

    expect(accepted.status).toBe(200)
    expect(await accepted.text()).toBe('challenge-123')
    expect(accepted.headers.get('cache-control')).toBe('no-store')

    const rejected = await SELF.fetch(
      'https://support.example.test/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge-123',
    )

    expect(rejected.status).toBe(403)
    expect(await rejected.text()).toBe('Forbidden')
  })

  it('rejects webhook notifications without a valid Meta signature', async () => {
    const response = await SELF.fetch('https://support.example.test/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
    })

    expect(response.status).toBe(401)
    expect(await response.text()).toBe('Invalid signature')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('creates one unclassified conversation without inventing Desk or CRM work', async () => {
    const firstPayload = textNotification('wamid.inbound-1', 'My equipment router is making a strange sound.')
    const first = await signedNotification(firstPayload)
    const replay = await signedNotification(firstPayload)
    const repackagedPayload = structuredClone(firstPayload)
    Object.assign(repackagedPayload.entry[0]!.changes[0]!.value, { delivery_attempt: 2 })
    const repackagedReplay = await signedNotification(repackagedPayload)
    const followUp = await signedNotification(textNotification('wamid.inbound-2', 'It started after I cleaned the vents.'))

    expect(first.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(repackagedReplay.status).toBe(200)
    expect(followUp.status).toBe(200)
    expect(await first.text()).toBe('EVENT_RECEIVED')

    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM cases').first()).toEqual({ count: 0 })
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM crm_relationships').first()).toEqual({ count: 0 })
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM communication_conversations').first()).toEqual({ count: 1 })
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM communication_messages').first()).toEqual({ count: 2 })
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM communication_provider_events').first()).toEqual({ count: 2 })
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM operation_receipts').first()).toEqual({ count: 2 })
    expect(await env.DB.prepare(
      `SELECT channel, attention_state, contact_name, contact_phone
       FROM communication_conversations`,
    ).first()).toEqual({
      channel: 'whatsapp',
      attention_state: 'needs_attention',
      contact_name: 'WhatsApp Customer',
      contact_phone: '+15550002000',
    })
    expect((await env.DB.prepare(
      'SELECT body_text FROM communication_messages ORDER BY source_created_at ASC, rowid ASC',
    ).all()).results.map((row) => row.body_text)).toEqual([
      'My equipment router is making a strange sound.',
      'It started after I cleaned the vents.',
    ])
    expect((await env.DB.prepare(
      'SELECT provider_message_id FROM communication_messages ORDER BY source_created_at ASC, rowid ASC',
    ).all()).results).toEqual([
      { provider_message_id: 'wamid.inbound-1' },
      { provider_message_id: 'wamid.inbound-2' },
    ])
    const intakeEvidence = (await env.DB.prepare(
      `SELECT evidence_json FROM audit_events WHERE event_type = 'communications.message_received' ORDER BY created_at, id`,
    ).all<{ evidence_json: string }>()).results.map((row) => JSON.parse(row.evidence_json) as { payloadHash?: string })
    expect(intakeEvidence).toHaveLength(2)
    expect(intakeEvidence.every((evidence) => /^[0-9a-f]{64}$/.test(evidence.payloadHash ?? ''))).toBe(true)
  })

  it('retains an unsupported WhatsApp message type as inbox evidence instead of silently acknowledging it', async () => {
    const payload = textNotification('wamid.image-1', 'placeholder') as any
    payload.entry[0].changes[0].value.messages[0] = {
      from: '15550002000',
      id: 'wamid.image-1',
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'image',
      image: { id: 'media-1', mime_type: 'image/jpeg' },
    }

    const response = await signedNotification(payload)

    expect(response.status).toBe(200)
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM communication_provider_events').first()).toEqual({ count: 1 })
    expect(await env.DB.prepare('SELECT body_text, content_json FROM communication_messages').first()).toEqual({
      body_text: 'WhatsApp image message received. Its content is not available in this pilot.',
      content_json: JSON.stringify({
        type: 'image',
        providerMediaId: 'media-1',
        mimeType: 'image/jpeg',
        filename: null,
        caption: null,
      }),
    })
  })

  it('queues agent replies for WhatsApp and preserves Meta acceptance evidence', async () => {
    expect((await signedNotification(textNotification('wamid.inbound-reply', 'Can you help with my router?'))).status).toBe(200)
    const communications = createCommunications({ db: env.DB })
    const actor = { id: 'operator-1', email: 'agent@example.test', name: 'Support Agent', role: 'agent' as const }
    const selected = await communications.work(actor, { kind: 'next' })
    if (!selected) throw new Error('Expected a conversation')
    const receipt = await communications.act(actor, {
      kind: 'reply',
      conversationId: selected.id,
      revision: selected.revision,
      intentId: 'reply-to-whatsapp-inquiry',
      body: 'Yes. Please send a short video of the sound.',
    })

    expect(receipt).toMatchObject({
      delivery: 'queued',
      outbound: {
        channel: 'whatsapp',
        recipient: '+15550002000',
        messageId: expect.stringMatching(/^communication_message_/),
        outboxId: expect.stringMatching(/^out_/),
      },
    })
    expect(await env.DB.prepare(
      `SELECT kind, recipient, state FROM outbox_rows WHERE kind = 'whatsapp_reply'`,
    ).first()).toEqual({ kind: 'whatsapp_reply', recipient: '+15550002000', state: 'queued' })

    let graphRequest: Request | null = null
    const graphFetch: typeof fetch = async (input, init) => {
      graphRequest = new Request(input, init)
      return Response.json({
        messaging_product: 'whatsapp',
        contacts: [{ input: '+15550002000', wa_id: '15550002000' }],
        messages: [{ id: 'wamid.outbound-1' }],
      })
    }
    const delivery = await deliverOutbox(env as Env, 25, { fetch: graphFetch })

    expect(delivery).toMatchObject({ considered: 1, accepted: 1 })
    expect(graphRequest?.url).toBe('https://graph.facebook.com/v25.0/test-phone-number-id/messages')
    expect(graphRequest?.headers.get('authorization')).toBe('Bearer whatsapp-test-access-token')
    expect(await graphRequest?.json()).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '+15550002000',
      type: 'text',
      text: { preview_url: false, body: 'Yes. Please send a short video of the sound.' },
    })
    expect(await env.DB.prepare(
      `SELECT outbox_rows.state, outbox_rows.provider_message_id AS outbox_provider_message_id,
              communication_messages.delivery_state,
              communication_messages.provider_message_id AS message_provider_message_id
       FROM outbox_rows
       JOIN communication_messages ON communication_messages.id = outbox_rows.communication_message_id
       WHERE outbox_rows.kind = 'whatsapp_reply'`,
    ).first()).toEqual({
      state: 'accepted',
      outbox_provider_message_id: 'wamid.outbound-1',
      delivery_state: 'accepted',
      message_provider_message_id: 'wamid.outbound-1',
    })
    const replay = await communications.act(actor, {
      kind: 'reply',
      conversationId: selected.id,
      revision: selected.revision,
      intentId: 'reply-to-whatsapp-inquiry',
      body: 'Yes. Please send a short video of the sound.',
    })
    expect(replay).toMatchObject({
      replayed: true,
      delivery: 'accepted',
      outbound: { channel: 'whatsapp', recipient: '+15550002000', outboxId: receipt.outbound?.outboxId },
    })
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM outbox_rows WHERE kind = 'whatsapp_reply'`,
    ).first()).toEqual({ count: 1 })
    expect((await signedNotification(textNotification('wamid.new-work-cycle', 'I also need a quote for two routers.'))).status).toBe(200)
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM communication_conversations').first()).toEqual({ count: 2 })
    const next = await communications.work(actor, { kind: 'next' })
    expect(next).toMatchObject({
      attention: 'needs_attention',
      messages: [{ body: 'I also need a quote for two routers.' }],
      routes: [],
    })
    const queue = await communications.work(actor, { kind: 'queue' })
    expect(queue.kind).toBe('conversation_queue')
    expect(queue.conversations).toHaveLength(1)
    expect(queue.conversations[0]).toMatchObject({
      id: next?.id,
      attention: 'needs_attention',
    })
  })

  it('turns a post-acceptance Meta delivery failure into inbox work exactly once', async () => {
    expect((await signedNotification(textNotification('wamid.delivery-status-inbound', 'Please reply'))).status).toBe(200)
    const communications = createCommunications({ db: env.DB })
    const actor = { id: 'operator-delivery-status', email: 'delivery-status@example.test', name: 'Delivery Status Agent', role: 'agent' as const }
    const selected = await communications.work(actor, { kind: 'next' })
    if (!selected) throw new Error('Expected a conversation')
    await communications.act(actor, {
      kind: 'reply',
      conversationId: selected.id,
      revision: selected.revision,
      intentId: 'reply-awaiting-delivery-status',
      body: 'We can help with that.',
    })
    await deliverOutbox(env as Env, 25, {
      fetch: async () => Response.json({
        messaging_product: 'whatsapp',
        contacts: [{ input: '+15550002000', wa_id: '15550002000' }],
        messages: [{ id: 'wamid.delivery-status-outbound' }],
      }),
    })

    const payload = statusNotification('wamid.delivery-status-outbound', 'failed', '1784624400')
    expect((await signedNotification(payload)).status).toBe(200)
    expect((await signedNotification(payload)).status).toBe(200)

    expect(await env.DB.prepare(
      `SELECT state, last_error FROM outbox_rows WHERE kind = 'whatsapp_reply'`,
    ).first()).toEqual({
      state: 'blocked',
      last_error: 'Meta reported a terminal delivery failure after accepting the message',
    })
    expect(await communications.work(actor, { kind: 'conversation', id: selected.id })).toMatchObject({
      attention: 'delivery_problem',
      messages: expect.arrayContaining([expect.objectContaining({ direction: 'outbound', delivery: 'blocked' })]),
    })
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM communication_provider_delivery_events').first()).toEqual({ count: 1 })
    expect(await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'communications.delivery_status_observed'`,
    ).first()).toEqual({ count: 1 })
  })

  it('reconciles a failed status that arrives before the outbound WAMID is persisted', async () => {
    expect((await signedNotification(textNotification('wamid.early-status-inbound', 'Please reply'))).status).toBe(200)
    const communications = createCommunications({ db: env.DB })
    const actor = { id: 'operator-early-status', email: 'early-status@example.test', name: 'Early Status Agent', role: 'agent' as const }
    const selected = await communications.work(actor, { kind: 'next' })
    if (!selected) throw new Error('Expected a conversation')
    await communications.act(actor, {
      kind: 'reply',
      conversationId: selected.id,
      revision: selected.revision,
      intentId: 'reply-with-early-status',
      body: 'We can help with that.',
    })

    const delivery = await deliverOutbox(env as Env, 25, {
      fetch: async () => {
        expect((await signedNotification(statusNotification('wamid.early-status-outbound', 'failed', '1784624500'))).status).toBe(200)
        expect(await env.DB.prepare(
          `SELECT communication_message_id FROM communication_provider_delivery_events`,
        ).first()).toEqual({ communication_message_id: null })
        return Response.json({
          messaging_product: 'whatsapp',
          contacts: [{ input: '+15550002000', wa_id: '15550002000' }],
          messages: [{ id: 'wamid.early-status-outbound' }],
        })
      },
    })

    expect(delivery).toMatchObject({ accepted: 1 })
    expect(await env.DB.prepare(
      `SELECT state, last_error FROM outbox_rows WHERE kind = 'whatsapp_reply'`,
    ).first()).toEqual({
      state: 'blocked',
      last_error: 'Meta reported a terminal delivery failure after accepting the message',
    })
    expect(await env.DB.prepare(
      `SELECT communication_message_id FROM communication_provider_delivery_events`,
    ).first()).toEqual({ communication_message_id: expect.stringMatching(/^communication_message_/) })
    expect(await communications.work(actor, { kind: 'conversation', id: selected.id })).toMatchObject({
      attention: 'delivery_problem',
      messages: expect.arrayContaining([expect.objectContaining({ direction: 'outbound', delivery: 'blocked' })]),
    })
  })

  it('blocks free-form delivery after the WhatsApp customer-service window expires', async () => {
    const now = new Date('2026-07-20T12:00:00.000Z')
    const oldTimestamp = String(Math.floor((now.valueOf() - 25 * 60 * 60 * 1_000) / 1_000))
    expect((await signedNotification(textNotification('wamid.window-expired', 'An old customer message', oldTimestamp))).status).toBe(200)
    const communications = createCommunications({ db: env.DB })
    const actor = { id: 'operator-window', email: 'window@example.test', name: 'Window Agent', role: 'agent' as const }
    const selected = await communications.work(actor, { kind: 'next' })
    if (!selected) throw new Error('Expected a conversation')
    await communications.act(actor, {
      kind: 'reply',
      conversationId: selected.id,
      revision: selected.revision,
      intentId: 'reply-after-window',
      body: 'Free-form reply',
    })
    expect((await signedNotification(textNotification(
      'wamid.window-new-session',
      'A newer request arrived while the older reply was queued.',
      String(Number(oldTimestamp) + 60),
    ))).status).toBe(200)
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM communication_conversations').first()).toEqual({ count: 2 })
    let providerCalled = false

    const delivery = await deliverOutbox(env as Env, 25, {
      now: () => now,
      fetch: async () => {
        providerCalled = true
        return Response.json({ messages: [{ id: 'must-not-send' }] })
      },
    })

    expect(providerCalled).toBe(false)
    expect(delivery).toMatchObject({ considered: 1, blocked: 1 })
    expect(await env.DB.prepare(
      `SELECT state, last_error FROM outbox_rows WHERE kind = 'whatsapp_reply'`,
    ).first()).toEqual({
      state: 'blocked',
      last_error: 'The WhatsApp customer-service window has expired; an approved template is required',
    })
    expect((await communications.work(actor, { kind: 'next' }))).toMatchObject({
      id: selected.id,
      attention: 'delivery_problem',
      messages: [
        expect.objectContaining({ direction: 'inbound' }),
        expect.objectContaining({ direction: 'outbound', delivery: 'blocked' }),
      ],
    })
  })

  it('retains an explicit Meta rejection without retrying a permanent error', async () => {
    expect((await signedNotification(textNotification('wamid.meta-rejection', 'Please reply'))).status).toBe(200)
    const communications = createCommunications({ db: env.DB })
    const actor = { id: 'operator-error', email: 'error@example.test', name: 'Error Agent', role: 'agent' as const }
    const selected = await communications.work(actor, { kind: 'next' })
    if (!selected) throw new Error('Expected a conversation')
    await communications.act(actor, {
      kind: 'reply',
      conversationId: selected.id,
      revision: selected.revision,
      intentId: 'provider-rejected-reply',
      body: 'Provider-rejected reply',
    })

    const delivery = await deliverOutbox(env as Env, 25, {
      fetch: async () => Response.json({ error: { message: 'Recipient is not allowed', code: 131030 } }, { status: 400 }),
    })

    expect(delivery).toMatchObject({ considered: 1, blocked: 1 })
    const rejected = await env.DB.prepare(
      `SELECT state, attempt_count, last_error FROM outbox_rows WHERE kind = 'whatsapp_reply'`,
    ).first<{ state: string; attempt_count: number; last_error: string }>()
    expect(rejected).not.toBeNull()
    expect(rejected).toMatchObject({
      state: 'blocked',
      attempt_count: 1,
    })
    expect(JSON.parse(rejected!.last_error)).toEqual({
      provider: 'meta_whatsapp',
      message: 'Meta rejected the WhatsApp message: Recipient is not allowed',
      httpStatus: 400,
      code: 131030,
      subcode: null,
      type: null,
      traceId: null,
    })
  })

  it('keeps the newest inbound time when Meta delivers messages out of order', async () => {
    const newer = '2026-07-20T10:00:00.000Z'
    const older = '2026-07-20T09:00:00.000Z'
    expect((await signedNotification(textNotification('wamid.newer', 'Newer', String(Date.parse(newer) / 1_000)))).status).toBe(200)
    expect((await signedNotification(textNotification('wamid.older', 'Older but delayed', String(Date.parse(older) / 1_000)))).status).toBe(200)

    expect(await env.DB.prepare('SELECT last_inbound_at FROM communication_conversations').first()).toEqual({ last_inbound_at: newer })
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM communication_conversations').first()).toEqual({ count: 1 })
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM communication_messages').first()).toEqual({ count: 2 })
  })
})
