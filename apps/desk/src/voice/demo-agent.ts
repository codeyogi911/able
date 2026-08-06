import { Agent, type Connection, type ConnectionContext, type WSMessage } from 'agents'
import {
  withVoice,
  WorkersAIFluxSTT,
  WorkersAITTS,
  type VoiceTurnContext,
} from '@cloudflare/voice'
import { stepCountIs, streamText, tool } from 'ai'
import { createWorkersAI } from 'workers-ai-provider'
import { z } from 'zod'
import type { CaseRef, DeliveryState } from '../domain/types'
import type { Env } from '../env'
import { createHelpdesk, createPublicKnowledge, type HelpdeskImplementation } from '../helpdesk'
import { verifyTurnstileProof } from '../security/public-write'
import { loadWorkspaceSettings, workspaceShortName } from '../settings'
import { voiceDemoEnabled } from './demo-page'
import {
  hasVoiceContact,
  normalizeVoiceContact,
  ORDER_LOOKUP_CONTACT_CONTINUATION,
  PRODUCT_HELP_CONTACT_CONTINUATION,
  type VoiceContact,
} from './contact'
import {
  ESCALATION_CATEGORIES,
  classifyEscalation,
  escalationCategoryLabel,
  isTicketStatusRequest,
  type EscalationCategory,
} from './escalation'
import { claimVoiceTicketCapacity, openVoiceSupportCase } from './support'
import {
  directVoiceResponse,
  prepareVoiceModelMessages,
  UNDOCUMENTED_PRODUCT_ORDER_CONTACT_REPLY,
  UNDOCUMENTED_PRODUCT_TICKET_CONTACT_REPLY,
  VOICE_AGENT_MODEL,
  voiceAgentSystemPrompt,
} from './conversation'
import { shopifyConfigured } from '../integrations/shopify'
import {
  findOrderNumber,
  isOrderLookupRequest,
  orderStatusForSession,
  orderStatusReply,
} from './orders'
import {
  createVoiceVerification,
  verifyVoiceVerificationCode,
  type VoiceVerificationChallenge,
} from './verification'
import { dedupAssistantText } from './dedup'

const VoiceAgent = withVoice(Agent, { historyLimit: 16, maxMessageCount: 80 })
const LOCAL_SECRET = 'morrow-local-capability-secret-not-for-production'

type VoiceConnectionState = {
  clientIp?: string
  hostname?: string
  origin?: string
  /** True after this connection passed the Turnstile session check. */
  sessionProofPassed?: boolean
  contact?: VoiceContact | null
  /** True after the contact email was proven via the progressive OTP flow. */
  verified?: boolean
  otpChallenge?: VoiceVerificationChallenge | null
  otpAttempts?: number
  otpResendAt?: number
  otpBusy?: boolean
  otpOperationId?: string | null
  ticketCreatedAt?: number[]
  ticketBusy?: boolean
  pendingEscalation?: {
    category: EscalationCategory
    customerMessage: string
    requestId: string
  } | null
  pendingContactReason?: 'order_lookup' | 'open_ticket' | 'product_help' | null
}

function connectionState(connection: Connection): VoiceConnectionState {
  return connection.state && typeof connection.state === 'object'
    ? connection.state as VoiceConnectionState
    : {}
}

function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost')
}

function cleanError(): string {
  return 'Voice support could not complete that action. Please use the support request form.'
}

export class MorrowDeskAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI, {
    eotThreshold: 0.7,
    keyterms: ['printer', 'router', 'paper tray'],
  })

  tts = new WorkersAITTS(this.env.AI, { speaker: 'asteria' })

  #activeSpeaker: string | null = null

  onConnect(connection: Connection, context: ConnectionContext): void {
    const url = new URL(context.request.url)
    connection.setState({
      clientIp: context.request.headers.get('CF-Connecting-IP') ?? 'unknown',
      hostname: url.hostname,
      origin: url.origin,
    } satisfies VoiceConnectionState)
  }

  beforeCallStart(connection: Connection): boolean {
    if (!voiceDemoEnabled(this.env)) return false
    if (connectionState(connection).sessionProofPassed !== true) {
      connection.send(JSON.stringify({ type: 'voice_session_required' }))
      return false
    }
    if (this.#activeSpeaker !== null) return false
    this.#activeSpeaker = connection.id
    return true
  }

  onCallEnd(connection: Connection): void {
    if (this.#activeSpeaker === connection.id) this.#activeSpeaker = null
    this.#clearHistory()
  }

  onClose(): void {
    this.#activeSpeaker = null
    this.#clearHistory()
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (typeof message !== 'string') return
    try {
      const parsed = JSON.parse(message) as Record<string, unknown>
      if (parsed.type === 'start_voice_session') {
        try {
          await this.#startSession(connection, parsed)
        } catch {
          connection.send(JSON.stringify({ type: 'voice_session_error', reason: 'unavailable' }))
        }
        return
      }
      if (parsed.type === 'set_voice_contact') {
        await this.#setContact(connection, parsed)
        return
      }
      if (parsed.type === 'request_voice_verification') {
        try {
          await this.#requestVerification(connection, parsed)
        } catch {
          connection.send(JSON.stringify({ type: 'voice_verification_error', reason: 'unavailable' }))
        }
        return
      }
      if (parsed.type === 'verify_voice_code') {
        try {
          await this.#verifyCode(connection, parsed.code)
        } catch {
          connection.send(JSON.stringify({ type: 'voice_verification_error', reason: 'unavailable' }))
        }
        return
      }
      if (parsed.type === 'clear_voice_identity') {
        const state = connectionState(connection)
        connection.setState({
          ...state,
          contact: null,
          verified: false,
          otpChallenge: null,
          otpAttempts: 0,
          otpResendAt: 0,
          otpBusy: false,
          otpOperationId: null,
          pendingEscalation: null,
          pendingContactReason: null,
        } satisfies VoiceConnectionState)
        this.#clearHistory()
        connection.send(JSON.stringify({ type: 'voice_identity_cleared' }))
        return
      }
      if (parsed.type !== 'clear_demo_session') return
      connection.setState({
        ...connectionState(connection),
        pendingEscalation: null,
        pendingContactReason: null,
      } satisfies VoiceConnectionState)
      this.#clearHistory()
      connection.send(JSON.stringify({ type: 'demo_session_cleared' }))
    } catch {
      connection.send(JSON.stringify({ type: 'voice_contact_error', reason: 'unavailable' }))
    }
  }

  afterTranscribe(transcript: string): string | null {
    const bounded = transcript.trim().slice(0, 1_200)
    return bounded.length >= 2 ? bounded : null
  }

  async onTurn(transcript: string, context: VoiceTurnContext) {
    const state = connectionState(context.connection)
    if (state.sessionProofPassed !== true) {
      context.connection.send(JSON.stringify({ type: 'voice_session_required' }))
      return 'Please wait a moment while the chat finishes its anti-spam check, then try again.'
    }
    const turnRate = await this.env.PUBLIC_RATE_LIMIT.limit({ key: `voice_turn:${state.clientIp ?? 'unknown'}` })
    if (!turnRate.success) {
      return 'You are sending messages very quickly. Give it a minute, then send that again.'
    }

    const contact = this.#contact(context.connection)
    const turnRequestId = `voice-turn-${crypto.randomUUID()}`
    const messages = context.messages.map(({ role, content }) => ({ role, content }))
    const classifiedCategory = classifyEscalation(transcript)
    const deterministicCategory = isTicketStatusRequest(transcript) && classifiedCategory === 'payment_or_refund'
      ? null
      : classifiedCategory
    if (deterministicCategory) {
      if (!contact) {
        context.connection.setState({
          ...state,
          pendingEscalation: {
            category: deterministicCategory,
            customerMessage: transcript,
            requestId: turnRequestId,
          },
        } satisfies VoiceConnectionState)
        context.connection.send(JSON.stringify({ type: 'voice_contact_required', anchor: 'after_reply' }))
        return 'This needs a person from the team to review it. Add your email in the card below and I will open a ticket for you right away.'
      }
      try {
        const ticket = await this.#openEscalationTicket(
          context.connection,
          contact,
          { category: deterministicCategory, customerMessage: transcript },
          turnRequestId,
        )
        const emailCopy = ticket.delivery === 'queued' ? ' The private link is queued for email delivery.' : ''
        return `I’ve stopped the automated flow and opened ticket ${ticket.ref} for human review.${emailCopy}`
      } catch {
        return cleanError()
      }
    }

    const ordersAvailable = shopifyConfigured(this.env)
    if (!contact && ordersAvailable && isOrderLookupRequest(transcript)) {
      context.connection.setState({
        ...state,
        pendingContactReason: 'order_lookup',
      } satisfies VoiceConnectionState)
      context.connection.send(JSON.stringify({ type: 'voice_contact_required', anchor: 'after_reply' }))
      return 'To look up your order, add your name and the email used at checkout in the card below.'
    }

    const isOrderContinuation = transcript.trim() === ORDER_LOOKUP_CONTACT_CONTINUATION
      || transcript.trim() === PRODUCT_HELP_CONTACT_CONTINUATION
    if (contact && ordersAvailable && isOrderContinuation) {
      const orderNumber = findOrderNumber(messages.filter((message) => message.content.trim() !== transcript.trim()))
      if (!orderNumber) return 'What is the order number from your confirmation email?'
      const result = await orderStatusForSession(this.env, { email: contact.email }, orderNumber)
      return orderStatusReply(result)
    }

    const directResponse = directVoiceResponse(transcript, messages)
    if (directResponse) return directResponse

    const ordersEnabled = ordersAvailable && contact !== null
    let contactCardRequested = false
    const settings = await loadWorkspaceSettings(this.env.DB)
    const workersAI = createWorkersAI({ binding: this.env.AI })
    const result = streamText({
      model: workersAI(VOICE_AGENT_MODEL, {
        sessionAffinity: this.sessionAffinity,
        reasoning_effort: null,
        chat_template_kwargs: { enable_thinking: false },
      }),
      system: voiceAgentSystemPrompt(workspaceShortName(settings.displayName), {
        orders: ordersAvailable,
        contact: contact !== null,
      }),
      messages: prepareVoiceModelMessages(messages),
      tools: {
        search_help_center: tool({
          description: 'Search the published help-centre articles for how-to steps, product care, policies, shipping, warranty, and troubleshooting. Returns article content to answer from; the matching articles are shown to the caller as links automatically.',
          inputSchema: z.object({
            query: z.string().min(2).max(120).describe('Two to six words naming the product, task, or policy, e.g. "clean label printer".'),
          }),
          execute: async ({ query }) => {
            try {
              const articles = await createPublicKnowledge(this.env.DB).ground(query, 3, 700)
              if (articles.length === 0) return { status: 'no_match' }
              const state = connectionState(context.connection)
              const base = (settings.portalBaseUrl ?? state.origin ?? '').replace(/\/+$/, '')
              context.connection.send(JSON.stringify({
                type: 'voice_sources',
                articles: articles.map((article) => ({
                  title: article.title,
                  section: article.section,
                  url: `${base}/kb/${encodeURIComponent(article.slug)}`,
                })),
              }))
              return { status: 'ok', articles: articles.map(({ title, content }) => ({ title, content })) }
            } catch {
              return { status: 'unavailable' }
            }
          },
        }),
        ...(ordersEnabled ? {
          get_order_status: tool({
            description: "Look up one order by the caller's order number. The server matches the number together with this session's contact email and returns not_found unless both match; it never reveals whether a number exists for a different email.",
            inputSchema: z.object({
              orderNumber: z.string().min(1).max(32).describe("The customer's order number from their confirmation email, e.g. #1234."),
            }),
            execute: async ({ orderNumber }) => {
              const state = connectionState(context.connection)
              return orderStatusForSession(this.env, {
                email: hasVoiceContact(state) ? state.contact.email : null,
              }, orderNumber)
            },
          }),
        } : {}),
        ...(contact ? {
          create_ticket: tool({
            description: "Open a durable support case for the caller's server-held contact. Synthesize both internal fields from the natural conversation; never ask the caller to provide or format them.",
            inputSchema: z.object({
              internalSummary: z.string().min(5).max(160).describe('A concise internal case title inferred from the conversation.'),
              caseNotes: z.string().min(10).max(2_000).describe('A factual internal case narrative containing the useful context already shared.'),
            }),
            execute: async ({ internalSummary, caseNotes }) => this.#openTicket(
              context.connection,
              contact,
              { subject: internalSummary, body: caseNotes },
              turnRequestId,
            ),
          }),
          request_human: tool({
            description: 'Stop automated support and open a durable ticket for human review.',
            inputSchema: z.object({
              category: z.enum(ESCALATION_CATEGORIES).describe('The policy reason for human review.'),
            }),
            execute: async ({ category }) => this.#openTicket(
              context.connection,
              contact,
              {
                subject: `${escalationCategoryLabel(category)} — voice support`,
                body: `Ava requested human review after this voice-support message.\n\nCustomer message:\n${transcript}`,
              },
              turnRequestId,
            ),
          }),
        } : {
          request_contact: tool({
            description: "Show the caller a secure card to share their name and the email used for their order or ticket follow-up. Use it before any order lookup, ticket, or human review when no contact is on file. The card appears under your reply; the caller fills it there, never in the chat.",
            inputSchema: z.object({
              reason: z.enum(['order_lookup', 'open_ticket', 'product_help'])
                .describe('Why contact details are needed right now.'),
            }),
            execute: async ({ reason }) => {
              contactCardRequested = true
              const continuationReason = reason === 'product_help' && !ordersAvailable
                ? 'open_ticket'
                : reason
              context.connection.setState({
                ...connectionState(context.connection),
                pendingContactReason: continuationReason,
              } satisfies VoiceConnectionState)
              context.connection.send(JSON.stringify({ type: 'voice_contact_required', anchor: 'after_reply' }))
              return reason === 'product_help'
                  ? {
                    status: 'requested',
                    responseRequirement: ordersAvailable
                      ? `Reply exactly: "${UNDOCUMENTED_PRODUCT_ORDER_CONTACT_REPLY}"`
                      : `Reply exactly: "${UNDOCUMENTED_PRODUCT_TICKET_CONTACT_REPLY}"`,
                  }
                : { status: 'requested' }
            },
          }),
        }),
      },
      maxOutputTokens: 120,
      temperature: 0,
      stopWhen: stepCountIs(4),
      abortSignal: context.signal,
    })

    // At temperature 0 the model sometimes restates its pre-tool-call sentence
    // verbatim after the tool result; the wrapper drops exact repeats within
    // the turn before they reach TTS and the transcript.
    const stream = dedupAssistantText(result.fullStream)
    if (contact) return stream

    // Safety net for the anonymous branch: the model occasionally speaks the
    // scripted "card below" line without calling request_contact, which would
    // strand the caller in front of a card that never rendered. If the turn
    // mentions the card and the tool never fired, send the card anyway.
    const connection = context.connection
    return (async function* () {
      let spoken = ''
      for await (const part of stream) {
        if (part.type === 'text-delta') spoken += (part as { text?: string }).text ?? ''
        yield part
      }
      if (!contactCardRequested && /\bcard\b/i.test(spoken)) {
        connection.send(JSON.stringify({ type: 'voice_contact_required', anchor: 'after_reply' }))
      }
    })()
  }

  // The Turnstile check moved from the contact card to session start: one
  // invisible proof gates every turn, so the mid-conversation identity card
  // stays lightweight.
  async #startSession(connection: Connection, input: Record<string, unknown>): Promise<void> {
    const state = connectionState(connection)
    if (state.sessionProofPassed === true) {
      connection.send(JSON.stringify({ type: 'voice_session_ready' }))
      return
    }
    const rate = await this.env.PUBLIC_RATE_LIMIT.limit({ key: `voice_session:${state.clientIp ?? 'unknown'}` })
    if (!rate.success) {
      connection.send(JSON.stringify({ type: 'voice_session_error', reason: 'rate_limited' }))
      return
    }
    const turnstile = await verifyTurnstileProof({
      token: typeof input.turnstileToken === 'string' ? input.turnstileToken : null,
      action: 'voice_session',
      ip: state.clientIp ?? 'unknown',
      hostname: state.hostname ?? '',
      local: isLocalHostname(state.hostname ?? ''),
    }, this.env)
    if (!turnstile.ok) {
      connection.send(JSON.stringify({ type: 'voice_session_error', reason: turnstile.reason }))
      return
    }
    connection.setState({
      ...connectionState(connection),
      sessionProofPassed: true,
    } satisfies VoiceConnectionState)
    connection.send(JSON.stringify({ type: 'voice_session_ready' }))
  }

  async #setContact(connection: Connection, input: Record<string, unknown>): Promise<void> {
    const state = connectionState(connection)
    if (state.sessionProofPassed !== true) {
      connection.send(JSON.stringify({ type: 'voice_contact_error', reason: 'session_required' }))
      return
    }
    const rate = await this.env.PUBLIC_RATE_LIMIT.limit({ key: `voice_contact:${state.clientIp ?? 'unknown'}` })
    if (!rate.success) {
      connection.send(JSON.stringify({ type: 'voice_contact_error', reason: 'rate_limited' }))
      return
    }
    const contact = normalizeVoiceContact(input)
    if (!contact) {
      connection.send(JSON.stringify({ type: 'voice_contact_error', reason: 'invalid_contact' }))
      return
    }
    const pendingEscalation = state.pendingEscalation ?? null
    const pendingContactReason = state.pendingContactReason ?? null
    connection.setState({
      ...connectionState(connection),
      contact,
      // A new contact is always unverified; any pending challenge is stale.
      verified: false,
      otpChallenge: null,
      otpAttempts: 0,
      otpResendAt: 0,
      pendingEscalation: null,
      pendingContactReason: null,
    } satisfies VoiceConnectionState)
    connection.send(JSON.stringify({
      type: 'voice_contact_set',
      contact: { name: contact.name, email: contact.email },
      continuation: pendingEscalation ? 'handled' : pendingContactReason ?? 'continue',
    }))
    if (pendingEscalation) {
      try {
        await this.#openEscalationTicket(
          connection,
          contact,
          pendingEscalation,
          pendingEscalation.requestId,
        )
      } catch {
        connection.send(JSON.stringify({ type: 'voice_pending_action_error', reason: 'unavailable' }))
      }
    }
  }

  async #requestVerification(connection: Connection, input: Record<string, unknown>): Promise<void> {
    const state = connectionState(connection)
    const contact = hasVoiceContact(state) ? state.contact : null
    if (!contact) {
      connection.send(JSON.stringify({ type: 'voice_verification_error', reason: 'contact_required' }))
      return
    }
    const now = Date.now()
    if ((state.otpResendAt ?? 0) > now) {
      connection.send(JSON.stringify({ type: 'voice_verification_error', reason: 'cooldown' }))
      return
    }
    if (state.otpBusy) {
      connection.send(JSON.stringify({ type: 'voice_verification_error', reason: 'request_in_progress' }))
      return
    }
    const operationId = crypto.randomUUID()
    connection.setState({ ...state, otpBusy: true, otpOperationId: operationId } satisfies VoiceConnectionState)
    try {
      const [ipRate, emailRate] = await Promise.all([
        this.env.PUBLIC_RATE_LIMIT.limit({ key: `voice_verify_ip:${state.clientIp ?? 'unknown'}` }),
        this.env.PUBLIC_RATE_LIMIT.limit({ key: `voice_verify_email:${contact.email}` }),
      ])
      if (!ipRate.success || !emailRate.success) {
        connection.send(JSON.stringify({ type: 'voice_verification_error', reason: 'rate_limited' }))
        return
      }
      const turnstile = await verifyTurnstileProof({
        token: typeof input.turnstileToken === 'string' ? input.turnstileToken : null,
        action: 'voice_verify',
        ip: state.clientIp ?? 'unknown',
        hostname: state.hostname ?? '',
        local: isLocalHostname(state.hostname ?? ''),
      }, this.env)
      if (!turnstile.ok) {
        connection.send(JSON.stringify({ type: 'voice_verification_error', reason: turnstile.reason }))
        return
      }

      const settings = await loadWorkspaceSettings(this.env.DB)
      const sender = settings.outboundSender
      const secret = this.#secret(state)
      if (!sender || !settings.supportEmail || !settings.emailTestedAt || !secret) {
        connection.send(JSON.stringify({ type: 'voice_verification_error', reason: 'email_not_configured' }))
        return
      }
      const testCode = Array.isArray(this.env.TEST_MIGRATIONS) ? this.env.VOICE_TEST_OTP_CODE : undefined
      const issued = await createVoiceVerification(contact, secret, testCode ? { code: () => testCode } : {})
      await this.env.EMAIL.send({
        from: { email: sender, name: `${settings.displayName} Support` },
        to: contact.email,
        replyTo: settings.supportEmail,
        subject: `Your ${settings.displayName} voice-support code`,
        text: `Your verification code is ${issued.code}. It expires in 10 minutes. If you did not request this code, you can ignore this email.`,
        headers: { 'Auto-Submitted': 'auto-generated', Organization: settings.displayName },
      })
      const latest = connectionState(connection)
      if (latest.otpOperationId !== operationId) return
      connection.setState({
        ...latest,
        otpChallenge: issued.challenge,
        otpAttempts: 0,
        otpResendAt: now + 60_000,
        otpBusy: false,
        otpOperationId: null,
        verified: false,
      } satisfies VoiceConnectionState)
      connection.send(JSON.stringify({
        type: 'voice_verification_sent',
        emailHint: contact.email.replace(/^(.{1,2}).*(@.*)$/, '$1•••$2'),
        expiresAt: issued.challenge.expiresAt,
      }))
    } finally {
      const latest = connectionState(connection)
      if (latest.otpOperationId === operationId) {
        connection.setState({ ...latest, otpBusy: false, otpOperationId: null } satisfies VoiceConnectionState)
      }
    }
  }

  async #verifyCode(connection: Connection, code: unknown): Promise<void> {
    const state = connectionState(connection)
    const challenge = state.otpChallenge
    const attempts = state.otpAttempts ?? 0
    if (!challenge || attempts >= 5 || typeof code !== 'string' || state.otpBusy) {
      connection.send(JSON.stringify({ type: 'voice_verification_error', reason: 'invalid_or_expired_code' }))
      return
    }
    const operationId = crypto.randomUUID()
    const nextAttempts = attempts + 1
    connection.setState({
      ...state,
      otpAttempts: nextAttempts,
      otpBusy: true,
      otpOperationId: operationId,
    } satisfies VoiceConnectionState)
    try {
      const [ipRate, emailRate] = await Promise.all([
        this.env.PUBLIC_RATE_LIMIT.limit({ key: `voice_verify_code_ip:${state.clientIp ?? 'unknown'}` }),
        this.env.PUBLIC_RATE_LIMIT.limit({ key: `voice_verify_code_email:${challenge.contact.email}` }),
      ])
      if (!ipRate.success || !emailRate.success) {
        connection.send(JSON.stringify({ type: 'voice_verification_error', reason: 'rate_limited' }))
        return
      }
      const valid = await verifyVoiceVerificationCode(challenge, code.trim(), this.#secret(state), Date.now())
      const latest = connectionState(connection)
      if (latest.otpOperationId !== operationId) return
      const currentEmail = hasVoiceContact(latest) ? latest.contact.email : null
      if (!valid || currentEmail !== challenge.contact.email) {
        connection.setState({
          ...latest,
          otpChallenge: nextAttempts >= 5 ? null : challenge,
          otpBusy: false,
          otpOperationId: null,
        } satisfies VoiceConnectionState)
        connection.send(JSON.stringify({ type: 'voice_verification_error', reason: 'invalid_or_expired_code' }))
        return
      }
      connection.setState({
        ...latest,
        verified: true,
        otpChallenge: null,
        otpAttempts: 0,
        otpBusy: false,
        otpOperationId: null,
      } satisfies VoiceConnectionState)
      connection.send(JSON.stringify({ type: 'voice_verified', email: challenge.contact.email }))
    } finally {
      const latest = connectionState(connection)
      if (latest.otpOperationId === operationId) {
        connection.setState({ ...latest, otpBusy: false, otpOperationId: null } satisfies VoiceConnectionState)
      }
    }
  }

  #secret(state: VoiceConnectionState): string {
    if (this.env.CUSTOMER_CAPABILITY_SECRET) return this.env.CUSTOMER_CAPABILITY_SECRET
    return isLocalHostname(state.hostname ?? '') || Array.isArray(this.env.TEST_MIGRATIONS) ? LOCAL_SECRET : ''
  }

  #contact(connection: Connection): VoiceContact | null {
    const state = connectionState(connection)
    return hasVoiceContact(state) ? state.contact : null
  }

  async #helpdesk(connection: Connection): Promise<HelpdeskImplementation> {
    const state = connectionState(connection)
    const settings = await loadWorkspaceSettings(this.env.DB)
    const secret = this.#secret(state)
    if (!secret) throw new Error('Customer capabilities are not configured')
    return createHelpdesk({
      db: this.env.DB,
      attachments: this.env.ATTACHMENTS,
      baseUrl: settings.portalBaseUrl ?? state.origin ?? 'https://invalid.local',
      capabilitySecret: secret,
      workspaceName: settings.displayName,
    })
  }

  async #openTicket(
    connection: Connection,
    contact: VoiceContact,
    input: { subject: string; body: string },
    requestId: string,
  ): Promise<{ ref: CaseRef; created: boolean; delivery: DeliveryState | null }> {
    const state = connectionState(connection)
    const now = Date.now()
    const recent = (state.ticketCreatedAt ?? []).filter((createdAt) => createdAt > now - 15 * 60_000)
    if (state.ticketBusy) throw new Error('Voice ticket creation is already in progress')
    connection.setState({ ...state, ticketBusy: true } satisfies VoiceConnectionState)
    try {
      const [ipRate, emailRate] = await Promise.all([
        this.env.PUBLIC_RATE_LIMIT.limit({ key: `voice_ticket_ip:${state.clientIp ?? 'unknown'}` }),
        this.env.PUBLIC_RATE_LIMIT.limit({ key: `voice_ticket_email:${contact.email}` }),
      ])
      if (!ipRate.success || !emailRate.success) throw new Error('Voice ticket rate limit reached')

      const capacity = await claimVoiceTicketCapacity(this.env.DB, contact.email, requestId, now)
      if (capacity === 'limited') throw new Error('Voice ticket limit reached')

      const ticket = await openVoiceSupportCase(await this.#helpdesk(connection), contact, { ...input, requestId })
      if (ticket.created) connection.setState({
        ...connectionState(connection),
        ticketCreatedAt: [...recent, now],
        ticketBusy: false,
      } satisfies VoiceConnectionState)
      connection.send(JSON.stringify({
        type: 'voice_ticket_created',
        ticket: { reference: ticket.ref, label: 'Human review requested', status: 'open' },
      }))
      return ticket
    } finally {
      const latest = connectionState(connection)
      if (latest.ticketBusy) connection.setState({ ...latest, ticketBusy: false } satisfies VoiceConnectionState)
    }
  }

  #openEscalationTicket(
    connection: Connection,
    contact: VoiceContact,
    escalation: Pick<NonNullable<VoiceConnectionState['pendingEscalation']>, 'category' | 'customerMessage'>,
    requestId: string,
  ): Promise<{ ref: CaseRef; created: boolean; delivery: DeliveryState | null }> {
    return this.#openTicket(connection, contact, {
      subject: `${escalationCategoryLabel(escalation.category)} — voice support`,
      body: `Ava escalated this voice-support message for human review.\n\nCustomer message:\n${escalation.customerMessage}`,
    }, requestId)
  }

  #clearHistory(): void {
    this.getConversationHistory(1)
    this.sql`DELETE FROM cf_voice_messages`
  }
}
