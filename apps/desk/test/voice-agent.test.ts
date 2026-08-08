import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { HUMAN_HELP_MESSAGE } from '../src/voice/escalation'
import { ORDER_LOOKUP_CONTACT_CONTINUATION } from '../src/voice/contact'
import { SHOPIFY_CUSTOMER_SESSION_COOKIE, signShopifyCustomerSession } from '../src/identity/shopify-customer'

type TestAgentEnv = typeof env & { AbleDeskAgent: DurableObjectNamespace }

function nextMessage(socket: WebSocket, predicate: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for voice-agent message')), 5_000)
    const listener = (event: MessageEvent) => {
      if (typeof event.data !== 'string') return
      const parsed = JSON.parse(event.data) as Record<string, unknown>
      if (!predicate(parsed)) return
      clearTimeout(timeout)
      socket.removeEventListener('message', listener)
      resolve(parsed)
    }
    socket.addEventListener('message', listener)
  })
}

async function connectAgent(name: string, origin = 'http://localhost', cookie?: string): Promise<WebSocket> {
  const namespace = (env as TestAgentEnv).AbleDeskAgent
  const stub = namespace.get(namespace.idFromName(name))
  // Every real connection carries a client IP and the public rate limits key
  // on it. A unique IP per connection keeps tests from draining one shared
  // rate-limit budget as the suite grows.
  const bytes = crypto.getRandomValues(new Uint8Array(3))
  const response = await stub.fetch(new Request(`${origin}/agents/able-desk-agent/${name}`, {
    headers: {
      upgrade: 'websocket',
      'CF-Connecting-IP': `10.${bytes[0]}.${bytes[1]}.${bytes[2]}`,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  }))
  expect(response.status).toBe(101)
  const socket = response.webSocket
  if (!socket) throw new Error('Voice agent did not return a WebSocket')
  socket.accept()
  return socket
}

async function proveSession(socket: WebSocket): Promise<void> {
  const ready = nextMessage(socket, (message) => message.type === 'voice_session_ready')
  socket.send(JSON.stringify({ type: 'start_voice_session' }))
  await ready
}

describe('voice agent WebSocket boundary', () => {
  it('gates turns and contact registration on the session proof', async () => {
    const socket = await connectAgent(`unproven-${crypto.randomUUID()}`)
    try {
      const gatedTurn = nextMessage(
        socket,
        (message) => message.type === 'transcript_end' && typeof message.text === 'string',
      )
      socket.send(JSON.stringify({ type: 'text_message', text: 'Open a support ticket for me.' }))
      await expect(gatedTurn).resolves.toMatchObject({
        type: 'transcript_end',
        text: 'Please wait a moment while the chat finishes its anti-spam check, then try again.',
      })

      const gatedContact = nextMessage(socket, (message) => message.type === 'voice_contact_error')
      socket.send(JSON.stringify({ type: 'set_voice_contact', name: 'Ada', email: 'ada@example.test' }))
      await expect(gatedContact).resolves.toMatchObject({
        type: 'voice_contact_error',
        reason: 'session_required',
      })
    } finally {
      socket.close()
    }
  })

  it('requires a Turnstile proof for the session on non-local hostnames', async () => {
    const socket = await connectAgent(`turnstile-${crypto.randomUUID()}`, 'http://support.example.test')
    try {
      const failure = nextMessage(socket, (message) => message.type === 'voice_session_error')
      socket.send(JSON.stringify({ type: 'start_voice_session' }))
      await expect(failure).resolves.toMatchObject({
        type: 'voice_session_error',
        reason: 'turnstile_not_configured',
      })
    } finally {
      socket.close()
    }
  })

  it('rejects an invalid email on a proven session', async () => {
    const socket = await connectAgent(`no-contact-${crypto.randomUUID()}`)
    try {
      await proveSession(socket)
      const invalidContact = nextMessage(socket, (message) => message.type === 'voice_contact_error')
      socket.send(JSON.stringify({ type: 'set_voice_contact', email: 'not-an-email' }))
      await expect(invalidContact).resolves.toMatchObject({ type: 'voice_contact_error', reason: 'invalid_contact' })
    } finally {
      socket.close()
    }
  })

  it('asks for contact details after the reply, then completes one pending safety ticket', async () => {
    const socket = await connectAgent(`anon-escalation-${crypto.randomUUID()}`)
    const email = `anon-escalation-${crypto.randomUUID()}@example.test`
    try {
      await proveSession(socket)
      const cardRequested = nextMessage(socket, (message) => message.type === 'voice_contact_required')
      const gated = nextMessage(
        socket,
        (message) => message.type === 'transcript_end' && typeof message.text === 'string',
      )
      // A deterministic escalation trigger must never silently drop; without
      // a contact it routes to the in-thread card, not a ticket.
      socket.send(JSON.stringify({ type: 'text_message', text: 'My document scanner is smoking.' }))
      await expect(cardRequested).resolves.toMatchObject({ type: 'voice_contact_required', anchor: 'after_reply', reason: 'open_ticket' })
      const reply = await gated
      expect(String(reply.text)).toContain('card below')

      const contactSet = nextMessage(socket, (message) => message.type === 'voice_contact_set')
      const ticketCreated = nextMessage(socket, (message) => message.type === 'voice_ticket_created')
      socket.send(JSON.stringify({ type: 'set_voice_contact', name: 'Anonymous Customer', email }))
      await expect(contactSet).resolves.toMatchObject({
        type: 'voice_contact_set',
        continuation: 'handled',
        contact: { name: 'Anonymous Customer', email },
      })
      await expect(ticketCreated).resolves.toMatchObject({
        type: 'voice_ticket_created',
        ticket: { status: 'open' },
      })

      const count = await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM cases
         JOIN customers ON customers.id = cases.customer_id
         WHERE customers.email = ?`,
      ).bind(email).first<{ count: number }>()
      expect(count?.count).toBe(1)
    } finally {
      socket.close()
    }
  })

  it('routes the landing human-help action into JIT identity after the explanation', async () => {
    const socket = await connectAgent(`human-help-${crypto.randomUUID()}`)
    try {
      await proveSession(socket)
      const cardRequested = nextMessage(socket, (message) => message.type === 'voice_contact_required')
      const reply = nextMessage(
        socket,
        (message) => message.type === 'transcript_end' && typeof message.text === 'string',
      )

      socket.send(JSON.stringify({ type: 'text_message', text: HUMAN_HELP_MESSAGE }))

      await expect(cardRequested).resolves.toMatchObject({ type: 'voice_contact_required', anchor: 'after_reply', reason: 'open_ticket' })
      await expect(reply).resolves.toMatchObject({ type: 'transcript_end' })
    } finally {
      socket.close()
    }
  })

  it('continues an order request after contact without repeating the identity request', async () => {
    const socket = await connectAgent(`order-contact-${crypto.randomUUID()}`)
    try {
      await proveSession(socket)
      const cardRequested = nextMessage(socket, (message) => message.type === 'voice_contact_required')
      const initialReply = nextMessage(socket, (message) => message.type === 'transcript_end')
      socket.send(JSON.stringify({ type: 'text_message', text: 'Where is my order?' }))

      await expect(cardRequested).resolves.toMatchObject({ anchor: 'after_reply', reason: 'order_lookup' })
      await expect(initialReply).resolves.toMatchObject({
        text: 'To look up your order, add your name and the email used at checkout in the card below.',
      })

      const contactSet = nextMessage(socket, (message) => message.type === 'voice_contact_set')
      socket.send(JSON.stringify({
        type: 'set_voice_contact',
        name: 'Local Order Tester',
        email: 'local-order@example.test',
      }))
      await expect(contactSet).resolves.toMatchObject({ continuation: 'order_lookup' })

      const lookupReply = nextMessage(socket, (message) => message.type === 'transcript_end')
      socket.send(JSON.stringify({ type: 'text_message', text: ORDER_LOOKUP_CONTACT_CONTINUATION }))
      const result = await lookupReply
      expect(result).toMatchObject({ text: 'What is the order number from your confirmation email?' })
      expect(String(result.text)).not.toMatch(/add your name|email.*card/i)

      // The customer answers with nothing but the order number — that is the
      // order flow, never the model's topic guardrail.
      const numberReply = nextMessage(socket, (message) => message.type === 'transcript_end')
      socket.send(JSON.stringify({ type: 'text_message', text: '2026-27/7903.' }))
      expect(String((await numberReply).text)).toContain('trouble checking orders')
    } finally {
      socket.close()
    }
  })

  it('resumes contact and the order flow across a dropped connection', async () => {
    // Mobile browsers routinely drop the WebSocket mid-flow; the session agent
    // must keep the contact and pending order lookup for the reconnect.
    const name = `order-reconnect-${crypto.randomUUID()}`
    const first = await connectAgent(name)
    try {
      await proveSession(first)
      const cardRequested = nextMessage(first, (message) => message.type === 'voice_contact_required')
      first.send(JSON.stringify({ type: 'text_message', text: 'My delivery is delayed.' }))
      await expect(cardRequested).resolves.toMatchObject({ anchor: 'after_reply', reason: 'order_lookup' })

      const contactSet = nextMessage(first, (message) => message.type === 'voice_contact_set')
      first.send(JSON.stringify({ type: 'set_voice_contact', name: 'Radha Tester', email: 'radha@example.test' }))
      await expect(contactSet).resolves.toMatchObject({ continuation: 'order_lookup' })
    } finally {
      first.close()
    }

    const second = await connectAgent(name)
    try {
      await proveSession(second)
      const reply = nextMessage(second, (message) => message.type === 'transcript_end')
      second.send(JSON.stringify({ type: 'text_message', text: '#2026-27/7903' }))
      const message = await reply
      // The stored contact answers the lookup directly: no re-asking for the
      // card, no off-topic refusal.
      expect(String(message.text)).toContain('trouble checking orders')
      expect(String(message.text)).not.toMatch(/only help with support|add your name/i)
    } finally {
      second.close()
    }
  })

  it('treats a store-account session as verified contact and never shows the card', async () => {
    const token = await signShopifyCustomerSession('able-local-capability-secret-not-for-production', {
      name: 'Signed In Customer',
      email: 'signed-in@example.test',
      accessToken: 'shcat-test-token',
      expiresAt: Date.now() + 60_000,
    })
    const socket = await connectAgent(
      `shopify-session-${crypto.randomUUID()}`,
      'http://localhost',
      `${SHOPIFY_CUSTOMER_SESSION_COOKIE}=${token}`,
    )
    try {
      await proveSession(socket)
      let cardShown = false
      socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string' && JSON.parse(event.data).type === 'voice_contact_required') cardShown = true
      })
      // A bare order number from a signed-in caller goes straight to lookup
      // under the verified email — no contact card, no guardrail.
      const reply = nextMessage(socket, (message) => message.type === 'transcript_end')
      socket.send(JSON.stringify({ type: 'text_message', text: '#2026-27/7903' }))
      const message = await reply
      expect(String(message.text)).toContain('trouble checking orders')
      expect(String(message.text)).not.toMatch(/card below|only help with support/i)
      expect(cardShown).toBe(false)
    } finally {
      socket.close()
    }
  })

  it('ignores a tampered store-account session token', async () => {
    const token = await signShopifyCustomerSession('able-local-capability-secret-not-for-production', {
      name: 'Tampered Customer',
      email: 'tampered@example.test',
      accessToken: 'shcat-test-token',
      expiresAt: Date.now() + 60_000,
    })
    const socket = await connectAgent(
      `shopify-tampered-${crypto.randomUUID()}`,
      'http://localhost',
      `${SHOPIFY_CUSTOMER_SESSION_COOKIE}=${token}TAMPERED`,
    )
    try {
      await proveSession(socket)
      // Without a valid session the bare number behaves anonymously: the
      // contact card is requested once.
      const cardRequested = nextMessage(socket, (message) => message.type === 'voice_contact_required')
      socket.send(JSON.stringify({ type: 'text_message', text: '#2026-27/7903' }))
      await expect(cardRequested).resolves.toMatchObject({ reason: 'order_lookup' })
    } finally {
      socket.close()
    }
  })

  it('asks for contact once when a bare order number arrives with nobody on file', async () => {
    const socket = await connectAgent(`bare-number-${crypto.randomUUID()}`)
    try {
      await proveSession(socket)
      const cardRequested = nextMessage(socket, (message) => message.type === 'voice_contact_required')
      const reply = nextMessage(socket, (message) => message.type === 'transcript_end')
      socket.send(JSON.stringify({ type: 'text_message', text: '#2026-27/7903' }))
      await expect(cardRequested).resolves.toMatchObject({ reason: 'order_lookup' })
      expect(String((await reply).text)).toContain('To look up order #2026-27/7903')
    } finally {
      socket.close()
    }
  })

  it('stores unverified contact details once and creates a real voice ticket', async () => {
    await env.DB.prepare(`UPDATE workspace_settings SET
      support_email = 'support@example.test',
      outbound_sender = 'sender@example.test',
      email_tested_at = CURRENT_TIMESTAMP,
      portal_base_url = 'http://localhost',
      updated_at = CURRENT_TIMESTAMP
      WHERE id = 1`).run()

    const socket = await connectAgent(`contact-${crypto.randomUUID()}`)
    try {
      await proveSession(socket)
      const contactSet = nextMessage(socket, (message) => message.type === 'voice_contact_set')
      socket.send(JSON.stringify({
        type: 'set_voice_contact',
        email: 'ada-voice@example.test',
        name: 'Ada Customer',
        // Extra client fields must not become stored contact or ticket data.
        phone: '+65 9123 4567',
      }))
      await expect(contactSet).resolves.toMatchObject({
        type: 'voice_contact_set',
        contact: { name: 'Ada Customer', email: 'ada-voice@example.test' },
      })

      const incomplete = nextMessage(socket, (message) => message.type === 'transcript_end')
      socket.send(JSON.stringify({ type: 'text_message', text: 'Can you open a new support' }))
      await expect(incomplete).resolves.toMatchObject({
        type: 'transcript_end',
        text: "Go ahead, I'm listening.",
      })

      const continuation = nextMessage(socket, (message) => message.type === 'transcript_end')
      socket.send(JSON.stringify({ type: 'text_message', text: 'ticket for me?' }))
      await expect(continuation).resolves.toMatchObject({
        type: 'transcript_end',
        text: 'Of course. What happened?',
      })

      const ticketCreated = nextMessage(socket, (message) => message.type === 'voice_ticket_created')
      socket.send(JSON.stringify({ type: 'text_message', text: 'My document scanner is smoking.' }))
      const ticket = await ticketCreated
      expect(ticket).toMatchObject({
        type: 'voice_ticket_created',
        ticket: { label: 'Human review requested', status: 'open' },
      })

      const stored = await env.DB.prepare(
        `SELECT cases.ref, cases.channel, customers.name, customers.email, customers.phone,
                messages.channel AS message_channel
         FROM cases
         JOIN customers ON customers.id = cases.customer_id
         JOIN messages ON messages.case_id = cases.id
         WHERE customers.email = ?`,
      ).bind('ada-voice@example.test').first<{
        ref: string
        channel: string
        name: string
        email: string
        phone: string | null
        message_channel: string
      }>()
      expect(stored).toMatchObject({
        ref: (ticket.ticket as { reference: string }).reference,
        channel: 'voice',
        name: 'Ada Customer',
        email: 'ada-voice@example.test',
        phone: null,
        message_channel: 'voice',
      })
    } finally {
      socket.close()
    }
  })

  it('verifies the contact email progressively and resets on identity clear', async () => {
    await env.DB.prepare(`UPDATE workspace_settings SET
      support_email = 'support@example.test',
      outbound_sender = 'sender@example.test',
      email_tested_at = CURRENT_TIMESTAMP,
      portal_base_url = 'http://localhost',
      updated_at = CURRENT_TIMESTAMP
      WHERE id = 1`).run()

    const socket = await connectAgent(`verify-${crypto.randomUUID()}`)
    try {
      await proveSession(socket)
      const needsContact = nextMessage(socket, (message) => message.type === 'voice_verification_error')
      socket.send(JSON.stringify({ type: 'request_voice_verification' }))
      await expect(needsContact).resolves.toMatchObject({ reason: 'contact_required' })

      const contactSet = nextMessage(socket, (message) => message.type === 'voice_contact_set')
      socket.send(JSON.stringify({ type: 'set_voice_contact', name: 'Ada Verify', email: 'ada-verify@example.test' }))
      await contactSet

      const sent = nextMessage(socket, (message) => message.type === 'voice_verification_sent')
      socket.send(JSON.stringify({ type: 'request_voice_verification' }))
      await expect(sent).resolves.toMatchObject({
        type: 'voice_verification_sent',
        emailHint: 'ad•••@example.test',
      })

      const cooldown = nextMessage(socket, (message) => message.type === 'voice_verification_error')
      socket.send(JSON.stringify({ type: 'request_voice_verification' }))
      await expect(cooldown).resolves.toMatchObject({ reason: 'cooldown' })

      const wrongCode = nextMessage(socket, (message) => message.type === 'voice_verification_error')
      socket.send(JSON.stringify({ type: 'verify_voice_code', code: '000000' }))
      await expect(wrongCode).resolves.toMatchObject({ reason: 'invalid_or_expired_code' })

      const verified = nextMessage(socket, (message) => message.type === 'voice_verified')
      socket.send(JSON.stringify({ type: 'verify_voice_code', code: '123456' }))
      await expect(verified).resolves.toMatchObject({ type: 'voice_verified', email: 'ada-verify@example.test' })

      const cleared = nextMessage(socket, (message) => message.type === 'voice_identity_cleared')
      socket.send(JSON.stringify({ type: 'clear_voice_identity' }))
      await cleared

      const afterClear = nextMessage(socket, (message) => message.type === 'voice_verification_error')
      socket.send(JSON.stringify({ type: 'verify_voice_code', code: '123456' }))
      await expect(afterClear).resolves.toMatchObject({ reason: 'invalid_or_expired_code' })
    } finally {
      socket.close()
    }
  })

  it('caps verification attempts at five per challenge', async () => {
    await env.DB.prepare(`UPDATE workspace_settings SET
      support_email = 'support@example.test',
      outbound_sender = 'sender@example.test',
      email_tested_at = CURRENT_TIMESTAMP,
      portal_base_url = 'http://localhost',
      updated_at = CURRENT_TIMESTAMP
      WHERE id = 1`).run()

    const socket = await connectAgent(`verify-cap-${crypto.randomUUID()}`)
    try {
      await proveSession(socket)
      const contactSet = nextMessage(socket, (message) => message.type === 'voice_contact_set')
      socket.send(JSON.stringify({ type: 'set_voice_contact', name: 'Ada Capacity', email: 'ada-cap@example.test' }))
      await contactSet

      const sent = nextMessage(socket, (message) => message.type === 'voice_verification_sent')
      socket.send(JSON.stringify({ type: 'request_voice_verification' }))
      await sent

      for (let attempt = 0; attempt < 5; attempt++) {
        const failure = nextMessage(socket, (message) => message.type === 'voice_verification_error')
        socket.send(JSON.stringify({ type: 'verify_voice_code', code: '000000' }))
        await expect(failure).resolves.toMatchObject({ reason: 'invalid_or_expired_code' })
      }

      // The correct code is rejected after the attempt cap destroys the challenge.
      const capped = nextMessage(socket, (message) => message.type === 'voice_verification_error')
      socket.send(JSON.stringify({ type: 'verify_voice_code', code: '123456' }))
      await expect(capped).resolves.toMatchObject({ reason: 'invalid_or_expired_code' })
    } finally {
      socket.close()
    }
  })

  it('rate limits repeated contact registration per client', async () => {
    const socket = await connectAgent(`rate-${crypto.randomUUID()}`)
    try {
      await proveSession(socket)
      let sawRateLimit = false
      for (let attempt = 0; attempt < 12 && !sawRateLimit; attempt++) {
        const error = nextMessage(socket, (message) => message.type === 'voice_contact_error')
        socket.send(JSON.stringify({ type: 'set_voice_contact', email: 'not-an-email' }))
        const received = await error
        expect(['invalid_contact', 'rate_limited']).toContain(received.reason)
        sawRateLimit = received.reason === 'rate_limited'
      }
      expect(sawRateLimit).toBe(true)
    } finally {
      socket.close()
    }
  })
})
