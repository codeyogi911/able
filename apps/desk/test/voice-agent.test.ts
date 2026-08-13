import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { HUMAN_HELP_MESSAGE } from '../src/voice/escalation'
import { SIGN_IN_CONTINUATION } from '../src/voice/contact'
import { SHOPIFY_CUSTOMER_SESSION_COOKIE, signShopifyCustomerSession } from '../src/identity/shopify-customer'

type TestAgentEnv = typeof env & { AbleDeskAgent: DurableObjectNamespace }

const LOCAL_SECRET = 'able-local-capability-secret-not-for-production'

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

async function customerCookie(name: string, email: string): Promise<string> {
  const token = await signShopifyCustomerSession(LOCAL_SECRET, {
    name,
    email,
    accessToken: 'customer-token-test',
    expiresAt: Date.now() + 60_000,
  })
  return `${SHOPIFY_CUSTOMER_SESSION_COOKIE}=${token}`
}

describe('voice agent WebSocket boundary', () => {
  it('accepts minimized answer feedback only after the session proof', async () => {
    const socket = await connectAgent(`feedback-${crypto.randomUUID()}`)
    try {
      await proveSession(socket)
      const received = nextMessage(socket, (message) => message.type === 'voice_feedback_received')
      socket.send(JSON.stringify({ type: 'voice_feedback', assistantTurn: 1, rating: 'helpful' }))
      await expect(received).resolves.toMatchObject({
        type: 'voice_feedback_received',
        assistantTurn: 1,
        rating: 'helpful',
      })
    } finally {
      socket.close()
    }
  })

  it('gates turns on the session proof', async () => {
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

  it('requests sign-in for a safety escalation and completes the pending ticket after it', async () => {
    const name = `anon-escalation-${crypto.randomUUID()}`
    const email = `escalation-${crypto.randomUUID()}@example.test`
    const first = await connectAgent(name)
    try {
      await proveSession(first)
      const signinRequested = nextMessage(first, (message) => message.type === 'voice_signin_required')
      const gated = nextMessage(
        first,
        (message) => message.type === 'transcript_end' && typeof message.text === 'string',
      )
      // A deterministic escalation trigger must never silently drop; without a
      // signed-in caller it routes to the sign-in hand-off, not a ticket.
      first.send(JSON.stringify({ type: 'text_message', text: 'My document scanner is smoking.' }))
      await expect(signinRequested).resolves.toMatchObject({ type: 'voice_signin_required', anchor: 'after_reply', reason: 'open_ticket' })
      expect(String((await gated).text)).toContain('Sign in with your store account below')
    } finally {
      first.close()
    }

    // The hosted-login round trip returns on a fresh connection carrying the
    // verified session cookie; the continuation completes the parked ticket.
    const second = await connectAgent(name, 'http://localhost', await customerCookie('Escalation Customer', email))
    try {
      await proveSession(second)
      const ticketCreated = nextMessage(second, (message) => message.type === 'voice_ticket_created')
      const reply = nextMessage(second, (message) => message.type === 'transcript_end')
      second.send(JSON.stringify({ type: 'text_message', text: SIGN_IN_CONTINUATION }))
      await expect(ticketCreated).resolves.toMatchObject({
        type: 'voice_ticket_created',
        ticket: { status: 'open' },
      })
      expect(String((await reply).text)).toContain('for human review')

      const count = await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM cases
         JOIN customers ON customers.id = cases.customer_id
         WHERE customers.email = ?`,
      ).bind(email).first<{ count: number }>()
      expect(count?.count).toBe(1)
    } finally {
      second.close()
    }
  })

  it('routes the landing human-help action into the sign-in hand-off', async () => {
    const socket = await connectAgent(`human-help-${crypto.randomUUID()}`)
    try {
      await proveSession(socket)
      const signinRequested = nextMessage(socket, (message) => message.type === 'voice_signin_required')
      const reply = nextMessage(
        socket,
        (message) => message.type === 'transcript_end' && typeof message.text === 'string',
      )

      socket.send(JSON.stringify({ type: 'text_message', text: HUMAN_HELP_MESSAGE }))

      await expect(signinRequested).resolves.toMatchObject({ type: 'voice_signin_required', anchor: 'after_reply', reason: 'open_ticket' })
      await expect(reply).resolves.toMatchObject({ type: 'transcript_end' })
    } finally {
      socket.close()
    }
  })

  it('requests sign-in for an order question and never asks for typed details', async () => {
    const socket = await connectAgent(`order-signin-${crypto.randomUUID()}`)
    try {
      await proveSession(socket)
      const signinRequested = nextMessage(socket, (message) => message.type === 'voice_signin_required')
      const initialReply = nextMessage(socket, (message) => message.type === 'transcript_end')
      socket.send(JSON.stringify({ type: 'text_message', text: 'Where is my order?' }))

      await expect(signinRequested).resolves.toMatchObject({ anchor: 'after_reply', reason: 'order_lookup' })
      const reply = await initialReply
      expect(String(reply.text)).toContain('sign in with your store account below')
      expect(String(reply.text)).not.toMatch(/name and email|checkout email/i)
    } finally {
      socket.close()
    }
  })

  it('resumes the order flow after the sign-in round trip', async () => {
    // The sign-in hand-off itself navigates away; the pending flow must
    // survive and complete deterministically when the caller returns.
    const name = `order-signin-resume-${crypto.randomUUID()}`
    const first = await connectAgent(name)
    try {
      await proveSession(first)
      const signinRequested = nextMessage(first, (message) => message.type === 'voice_signin_required')
      first.send(JSON.stringify({ type: 'text_message', text: 'My delivery is delayed.' }))
      await expect(signinRequested).resolves.toMatchObject({ anchor: 'after_reply', reason: 'order_lookup' })
    } finally {
      first.close()
    }

    const second = await connectAgent(name, 'http://localhost', await customerCookie('Radha Tester', 'radha@example.test'))
    try {
      await proveSession(second)
      const reply = nextMessage(second, (message) => message.type === 'transcript_end')
      second.send(JSON.stringify({ type: 'text_message', text: SIGN_IN_CONTINUATION }))
      const message = await reply
      // The customer-context read is unavailable against the test shop, and
      // the reply reports that truthfully instead of claiming no orders.
      expect(String(message.text)).toContain('trouble checking orders')
      expect(String(message.text)).not.toMatch(/only help with support|name and email/i)
    } finally {
      second.close()
    }
  })

  it('treats a store-account session as verified identity for direct lookups', async () => {
    const socket = await connectAgent(
      `shopify-session-${crypto.randomUUID()}`,
      'http://localhost',
      await customerCookie('Signed In Customer', 'signed-in@example.test'),
    )
    try {
      await proveSession(socket)
      let signinShown = false
      socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string' && JSON.parse(event.data).type === 'voice_signin_required') signinShown = true
      })
      // A bare order number from a signed-in caller goes straight to lookup
      // under the verified email — no sign-in card, no guardrail.
      const reply = nextMessage(socket, (message) => message.type === 'transcript_end')
      socket.send(JSON.stringify({ type: 'text_message', text: '#2026-27/7903' }))
      const message = await reply
      expect(String(message.text)).toContain('trouble checking orders')
      expect(String(message.text)).not.toMatch(/sign in|only help with support/i)
      expect(signinShown).toBe(false)
    } finally {
      socket.close()
    }
  })

  it('ignores a tampered store-account session token', async () => {
    const cookie = await customerCookie('Tampered Customer', 'tampered@example.test')
    const socket = await connectAgent(
      `shopify-tampered-${crypto.randomUUID()}`,
      'http://localhost',
      `${cookie}TAMPERED`,
    )
    try {
      await proveSession(socket)
      // Without a valid session the bare number behaves anonymously: sign-in
      // is requested once.
      const signinRequested = nextMessage(socket, (message) => message.type === 'voice_signin_required')
      socket.send(JSON.stringify({ type: 'text_message', text: '#2026-27/7903' }))
      await expect(signinRequested).resolves.toMatchObject({ reason: 'order_lookup' })
    } finally {
      socket.close()
    }
  })

  it('asks to sign in once when a bare order number arrives anonymously', async () => {
    const socket = await connectAgent(`bare-number-${crypto.randomUUID()}`)
    try {
      await proveSession(socket)
      const signinRequested = nextMessage(socket, (message) => message.type === 'voice_signin_required')
      const reply = nextMessage(socket, (message) => message.type === 'transcript_end')
      socket.send(JSON.stringify({ type: 'text_message', text: '#2026-27/7903' }))
      await expect(signinRequested).resolves.toMatchObject({ reason: 'order_lookup' })
      expect(String((await reply).text)).toContain('To look up order #2026-27/7903, sign in with your store account below.')
    } finally {
      socket.close()
    }
  })

  it('creates a real voice ticket under the signed-in identity', async () => {
    await env.DB.prepare(`UPDATE workspace_settings SET
      support_email = 'support@example.test',
      outbound_sender = 'sender@example.test',
      email_tested_at = CURRENT_TIMESTAMP,
      portal_base_url = 'http://localhost',
      updated_at = CURRENT_TIMESTAMP
      WHERE id = 1`).run()

    const email = `ticket-${crypto.randomUUID()}@example.test`
    const socket = await connectAgent(
      `signed-ticket-${crypto.randomUUID()}`,
      'http://localhost',
      await customerCookie('Ada Customer', email),
    )
    try {
      await proveSession(socket)
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
      ).bind(email).first<{
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
        email,
        phone: null,
        message_channel: 'voice',
      })
    } finally {
      socket.close()
    }
  })
})
