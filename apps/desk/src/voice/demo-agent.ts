import { Agent, type Connection, type ConnectionContext, type WSMessage } from 'agents'
import {
  withVoice,
  WorkersAINova3STT,
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
  SIGN_IN_CONTINUATION,
  type VoiceContact,
  type VoiceSignInReason,
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
  budgetBundleReply,
  directVoiceResponse,
  inrBudgetFromTranscript,
  isHelpCenterSupportRequest,
  isStorefrontShoppingRequest,
  productDiscoveryReply,
  productComparisonReply,
  productComparisonTerms,
  prepareVoiceModelMessages,
  speechText,
  UNDOCUMENTED_PRODUCT_FORM_REPLY,
  UNDOCUMENTED_PRODUCT_SIGNIN_ORDER_REPLY,
  UNDOCUMENTED_PRODUCT_SIGNIN_TICKET_REPLY,
  VOICE_AGENT_MODEL,
  voiceAgentSystemPrompt,
} from './conversation'
import { shopifyConfigured } from '../integrations/shopify'
import {
  getStorefrontProduct,
  searchStorefrontProducts,
  shopifyStorefrontConfigured,
  shopifyStorefrontProfileUrl,
} from '../integrations/shopify-storefront'
import {
  bareOrderNumber,
  findOrderNumber,
  isOrderLookupRequest,
  ordersOverviewReply,
  orderStatusForSession,
  orderStatusReply,
} from './orders'
import { dedupAssistantText, recoverAssistantText } from './dedup'
import {
  SHOPIFY_CUSTOMER_SESSION_COOKIE,
  shopifyCustomerConfigured,
  shopifyCustomerContext,
  verifyShopifyCustomerSession,
  type ShopifyCustomerSession,
} from '../identity/shopify-customer'

const VoiceAgent = withVoice(Agent, { historyLimit: 16, maxMessageCount: 80 })
const LOCAL_SECRET = 'able-local-capability-secret-not-for-production'

function readShopifyCustomerCookie(request: Request): string | null {
  const header = request.headers.get('Cookie') ?? ''
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === SHOPIFY_CUSTOMER_SESSION_COOKIE) return rest.join('=') || null
  }
  return null
}

type VoiceConnectionState = {
  clientIp?: string
  hostname?: string
  origin?: string
  /** True after this connection passed the Turnstile session check. */
  sessionProofPassed?: boolean
  /**
   * The raw signed Shopify customer-session token presented on the WebSocket
   * upgrade. Verified lazily per use; the cookie re-arrives on every
   * reconnect, so verified identity survives connection drops by transport.
   */
  shopifyCustomerToken?: string | null
}

/**
 * Conversation-scoped state. This lives in Durable Object storage keyed by the
 * session agent, NOT on the WebSocket connection: mobile browsers routinely
 * drop the socket on backgrounding or screen lock — and the sign-in hand-off
 * itself navigates away — so the pending flow must survive the client's
 * reconnect. Identity is never stored here: it arrives as the verified
 * store-account cookie on every connection. Only transport facts and the
 * per-connection Turnstile proof stay on connections.
 */
type VoiceSessionState = {
  ticketCreatedAt?: number[]
  ticketBusy?: boolean
  pendingEscalation?: {
    category: EscalationCategory
    customerMessage: string
    requestId: string
  } | null
  pendingSignInReason?: VoiceSignInReason | null
}

const SESSION_STATE_KEY = 'voice_session_state'
/**
 * How long a disconnected session keeps its history and state before being
 * wiped. Long enough to ride out network drops and app switches; short enough
 * that an abandoned visit does not retain contact details.
 */
const ABANDONED_SESSION_GRACE_SECONDS = 10 * 60

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

const DEFAULT_VOICE_KEYTERMS = ['printer', 'router', 'paper tray']

export function voiceKeyterms(configured: string | undefined): string[] {
  const terms = (configured ?? '')
    .split(',')
    .map((term) => term.replace(/\s+/g, ' ').trim())
    .filter((term) => term.length >= 2 && term.length <= 60)
  const unique = [...new Set(terms)].slice(0, 30)
  return unique.length > 0 ? unique : DEFAULT_VOICE_KEYTERMS
}

export class AbleDeskAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAINova3STT(this.env.AI, {
    language: 'multi',
    endpointingMs: 420,
    utteranceEndMs: 900,
    keyterms: voiceKeyterms(this.env.ABLE_VOICE_KEYTERMS),
  })

  tts = new WorkersAITTS(this.env.AI, {
    model: '@cf/deepgram/aura-2-en',
    speaker: 'harmonia',
  })

  #activeSpeaker: string | null = null

  onConnect(connection: Connection, context: ConnectionContext): void {
    const url = new URL(context.request.url)
    connection.setState({
      clientIp: context.request.headers.get('CF-Connecting-IP') ?? 'unknown',
      hostname: url.hostname,
      origin: url.origin,
      shopifyCustomerToken: readShopifyCustomerCookie(context.request),
    } satisfies VoiceConnectionState)
  }

  /** The verified store-account identity on this connection, if any. */
  async #shopifyCustomer(connection: Connection): Promise<ShopifyCustomerSession | null> {
    const state = connectionState(connection)
    if (!state.shopifyCustomerToken || !shopifyCustomerConfigured(this.env)) return null
    return verifyShopifyCustomerSession(this.#secret(state), state.shopifyCustomerToken)
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
    // A dropped socket is not the end of the visit. Keep history and session
    // state for a grace period so the client's automatic reconnect resumes the
    // conversation mid-flow, then wipe everything if nobody came back.
    void this.schedule(ABANDONED_SESSION_GRACE_SECONDS, 'cleanupAbandonedSession')
  }

  async cleanupAbandonedSession(): Promise<void> {
    if ([...this.getConnections()].length > 0) return
    await this.ctx.storage.delete(SESSION_STATE_KEY)
    this.#clearHistory()
  }

  async #session(): Promise<VoiceSessionState> {
    return await this.ctx.storage.get<VoiceSessionState>(SESSION_STATE_KEY) ?? {}
  }

  async #patchSession(patch: Partial<VoiceSessionState>): Promise<VoiceSessionState> {
    const next = { ...await this.#session(), ...patch }
    await this.ctx.storage.put(SESSION_STATE_KEY, next)
    return next
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
      if (parsed.type !== 'clear_demo_session') return
      await this.#patchSession({
        pendingEscalation: null,
        pendingSignInReason: null,
      })
      this.#clearHistory()
      connection.send(JSON.stringify({ type: 'demo_session_cleared' }))
    } catch {
      connection.send(JSON.stringify({ type: 'voice_session_error', reason: 'unavailable' }))
    }
  }

  afterTranscribe(transcript: string): string | null {
    const bounded = transcript.trim().slice(0, 1_200)
    return bounded.length >= 2 ? bounded : null
  }

  beforeSynthesize(text: string): string | null {
    return speechText(text)
  }

  #showProducts(connection: Connection, products: Array<{
    handle: string
    title: string
    availableForSale: boolean
    priceRange: { min: { amount: string; currencyCode: string }; max: { amount: string; currencyCode: string } }
    url: string | null
    image: { url: string; altText: string | null } | null
  }>): void {
    connection.send(JSON.stringify({
      type: 'voice_products',
      products: products.map((product) => ({
        handle: product.handle,
        title: product.title,
        availableForSale: product.availableForSale,
        priceRange: product.priceRange,
        url: product.url,
        image: product.image,
      })),
    }))
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

    const shopifyCustomer = await this.#shopifyCustomer(context.connection)
    // Identity is Shopify-first: the verified store-account session IS the
    // contact. Nothing is ever typed into the chat.
    const contact: VoiceContact | null = shopifyCustomer
      ? { name: shopifyCustomer.name, email: shopifyCustomer.email }
      : null
    const signInAvailable = shopifyCustomerConfigured(this.env)
    const turnRequestId = `voice-turn-${crypto.randomUUID()}`
    const messages = context.messages.map(({ role, content }) => ({ role, content }))

    // The client sends this as its first turn after returning from the hosted
    // store login. Escalations, ordinary ticket requests, and order flows all
    // complete deterministically; verified actions must never depend on the
    // model remembering to call the corresponding tool after navigation.
    if (transcript.trim() === SIGN_IN_CONTINUATION) {
      const continuationReply = await this.#completeSignInContinuation(context.connection, shopifyCustomer, contact)
      if (continuationReply !== null) return continuationReply
    }

    const classifiedCategory = classifyEscalation(transcript)
    const deterministicCategory = isTicketStatusRequest(transcript) && classifiedCategory === 'payment_or_refund'
      ? null
      : classifiedCategory
    if (deterministicCategory) {
      if (!contact) {
        if (!signInAvailable) {
          return 'This needs a person from the team to review it. Open a support request through the form and the team will take it from there.'
        }
        await this.#patchSession({
          pendingEscalation: {
            category: deterministicCategory,
            customerMessage: transcript,
            requestId: turnRequestId,
          },
        })
        this.#requestSignIn(context.connection, 'open_ticket')
        return 'This needs a person from the team to review it. Sign in with your store account below and I will open a ticket for you right away.'
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

    const settings = await loadWorkspaceSettings(this.env.DB)
    const storefrontOrigin = settings.portalBaseUrl ?? state.origin
    const ordersAvailable = shopifyConfigured(this.env)
    const storefrontProfileUrl = shopifyStorefrontProfileUrl(this.env, storefrontOrigin)
    const productsAvailable = shopifyStorefrontConfigured(this.env, storefrontOrigin)
    if (!contact && ordersAvailable && signInAvailable && isOrderLookupRequest(transcript)) {
      await this.#patchSession({ pendingSignInReason: 'order_lookup' })
      this.#requestSignIn(context.connection, 'order_lookup')
      return 'To look up your order, sign in with your store account below and I can pull it up right away.'
    }

    // A message that is nothing but an order number is always the order flow —
    // typically the answer to "which order?", possibly arriving on a fresh
    // connection after a network drop. It must never fall through to the
    // model's topic guardrail.
    const bareNumber = ordersAvailable ? bareOrderNumber(transcript) : null
    if (bareNumber) {
      if (!contact) {
        if (!signInAvailable) {
          return 'I cannot check orders in this chat. Open a support request through the form and the team will follow up by email.'
        }
        await this.#patchSession({ pendingSignInReason: 'order_lookup' })
        this.#requestSignIn(context.connection, 'order_lookup')
        return `To look up order ${bareNumber}, sign in with your store account below.`
      }
      const result = await orderStatusForSession(this.env, { email: contact.email }, bareNumber)
      return orderStatusReply(result)
    }

    const directResponse = directVoiceResponse(transcript, messages)
    if (directResponse) return directResponse

    const maximumINR = inrBudgetFromTranscript(transcript)
    const requiresBundle = /\bmachine\b/i.test(transcript) && /\bgrinder\b/i.test(transcript)
    if (productsAvailable && maximumINR !== null && requiresBundle) {
      const productResult = await searchStorefrontProducts(this.env, 'machine grinder', {
        profileUrl: storefrontProfileUrl,
        shopperBudget: { amount: maximumINR, currencyCode: 'INR' },
        requireBundle: true,
      })
      if (productResult.status === 'ok') {
        const reply = budgetBundleReply(productResult.products, maximumINR)
        if (reply) return reply
      }
      if (productResult.status === 'unavailable') {
        return 'I cannot check the storefront right now. Please try again shortly.'
      }
      return `I did not find a verified machine-and-grinder bundle within ₹${maximumINR.toLocaleString('en-IN')}. Would you consider a hand grinder?`
    }

    const comparison = productsAvailable ? productComparisonTerms(transcript) : null
    if (comparison) {
      const [firstTerm, secondTerm] = comparison
      const [firstResult, secondResult] = await Promise.all([
        searchStorefrontProducts(this.env, firstTerm, { profileUrl: storefrontProfileUrl }),
        searchStorefrontProducts(this.env, secondTerm, { profileUrl: storefrontProfileUrl }),
      ])
      if (firstResult.status === 'ok' && secondResult.status === 'ok') {
        const reply = productComparisonReply(firstTerm, firstResult.products, secondTerm, secondResult.products)
        if (reply) return reply
      }
      if (firstResult.status === 'unavailable' || secondResult.status === 'unavailable') {
        return 'I cannot compare those products right now. Please try again shortly.'
      }
      return 'I could not verify both products in the storefront. Which one should I look up first?'
    }

    if (productsAvailable && isStorefrontShoppingRequest(transcript)) {
      const result = await searchStorefrontProducts(this.env, transcript, {
        profileUrl: storefrontProfileUrl,
        ...(maximumINR === null ? {} : { shopperBudget: { amount: maximumINR, currencyCode: 'INR' } }),
      })
      if (result.status === 'unavailable') return 'I cannot check the storefront right now. Please try again shortly.'
      if (result.status === 'no_match') return 'I did not find a verified match in the storefront. What product type should I narrow this to?'
      const visibleProducts = maximumINR === null
        ? result.products
        : result.products.filter((product) => product.priceRange.max.currencyCode === 'INR'
          && Number(product.priceRange.max.amount) <= maximumINR)
      this.#showProducts(context.connection, visibleProducts)
      return productDiscoveryReply(result.products, maximumINR)
        ?? 'I found matching products in the storefront. What matters most to you—budget, workflow, or size?'
    }

    const ordersEnabled = ordersAvailable && contact !== null
    let signInRequested = false
    const workersAI = createWorkersAI({ binding: this.env.AI })
    const result = streamText({
      model: workersAI(VOICE_AGENT_MODEL, {
        sessionAffinity: this.sessionAffinity,
        reasoning_effort: null,
        chat_template_kwargs: { enable_thinking: false },
      }),
      system: voiceAgentSystemPrompt(workspaceShortName(settings.displayName), {
        orders: ordersAvailable,
        products: productsAvailable,
        signedIn: shopifyCustomer !== null,
        signInAvailable,
        locale: settings.locale,
        timezone: settings.timezone,
      }),
      messages: prepareVoiceModelMessages(messages),
      ...((productsAvailable && isStorefrontShoppingRequest(transcript)) || isHelpCenterSupportRequest(transcript) ? {
        prepareStep: ({ stepNumber }: { stepNumber: number }) => {
          if (stepNumber !== 0) return { toolChoice: 'auto' as const }
          return {
            toolChoice: {
              type: 'tool' as const,
              toolName: productsAvailable && isStorefrontShoppingRequest(transcript)
                ? 'search_storefront_products'
                : 'search_help_center',
            },
          }
        },
      } : {}),
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
              return {
                status: 'ok',
                articles: articles.map(({ title, content }) => ({ title, content })),
                responseRequirement: 'Give the documented answer in natural prose and stop after the sourced step. Do not mention, offer, open, or suggest a support ticket in this reply; wait for the customer to say whether the step failed.',
              }
            } catch {
              return { status: 'unavailable' }
            }
          },
        }),
        ...(productsAvailable ? {
          search_storefront_products: tool({
            description: 'Search the public Shopify storefront for products a shopper can browse. Returns up to five relevant published products with descriptions, availability, price ranges, images, and product-page URLs. Use for product discovery, selection, comparison, pricing, or availability—not troubleshooting or policy answers. Never read or spell a URL aloud.',
            inputSchema: z.object({
              query: z.string().min(2).max(120).describe('A concise natural-language product search, including the customer need or product name.'),
            }),
            execute: async ({ query }) => {
              const maximumINR = inrBudgetFromTranscript(transcript)
              const requiresBundle = /\bmachine\b/i.test(transcript) && /\bgrinder\b/i.test(transcript)
              const result = await searchStorefrontProducts(this.env, requiresBundle ? 'machine grinder' : query, {
                profileUrl: storefrontProfileUrl,
                ...(maximumINR === null ? {} : { shopperBudget: { amount: maximumINR, currencyCode: 'INR' } }),
                ...(requiresBundle ? { requireBundle: true } : {}),
              })
              if (result.status === 'ok') {
                this.#showProducts(context.connection, result.products)
              }
              if (maximumINR === null || result.status !== 'ok') return result
              const withinBudget = result.products.filter((product) => {
                if (product.priceRange.max.currencyCode !== 'INR') return false
                const maximum = Number(product.priceRange.max.amount)
                return Number.isFinite(maximum) && maximum <= maximumINR
              })
              return {
                ...result,
                budgetEvidence: {
                  maximumINR,
                  withinBudgetHandles: withinBudget.map((product) => product.handle),
                  bundleWithinBudgetHandles: withinBudget
                    .filter((product) => product.productType?.toLowerCase() === 'bundle'
                      || /\b(?:bundle|combo|with|kit)\b/i.test(product.title))
                    .map((product) => product.handle),
                  note: 'Budget fit applies to one returned product. Do not add separate product prices.',
                },
              }
            },
          }),
          get_storefront_product: tool({
            description: 'Fetch bounded public storefront detail for one opaque product reference returned by search_storefront_products. Use when the caller selects a result or asks about its options, variants, price, availability, or description.',
            inputSchema: z.object({
              reference: z.string().min(20).max(500).regex(/^shopify_product_[A-Za-z0-9_-]+$/)
                .describe('The exact opaque product reference returned by search_storefront_products.'),
            }),
            execute: async ({ reference }) => getStorefrontProduct(this.env, reference, { profileUrl: storefrontProfileUrl }),
          }),
        } : {}),
        ...(shopifyCustomer ? {
          list_my_orders: tool({
            description: "List the signed-in caller's most recent orders: names, dates, payment and fulfillment status, totals, and tracking. Use when they ask about an order without giving a number, then confirm which order they mean. Returns only the signed-in caller's own orders.",
            inputSchema: z.object({}),
            execute: async () => {
              const result = await shopifyCustomerContext(this.env, shopifyCustomer.accessToken, {})
              return result.status === 'ok' ? { status: 'ok', orders: result.customer.orders } : { status: 'unavailable' }
            },
          }),
        } : {}),
        ...(ordersEnabled ? {
          get_order_status: tool({
            description: "Look up one order by the caller's order number. The server matches the number together with this session's contact email and returns not_found unless both match; it never reveals whether a number exists for a different email.",
            inputSchema: z.object({
              orderNumber: z.string().min(1).max(32).describe("The customer's order number from their confirmation email, e.g. #1234."),
            }),
            execute: async ({ orderNumber }) => {
              const order = await orderStatusForSession(this.env, { email: contact?.email ?? null }, orderNumber)
              if (order.status === 'not_found') return {
                ...order,
                responseRequirement: 'Say the order was not found for this store account, mention it may use a different checkout email, and offer to open a support ticket. Do not offer another lookup instead.',
              }
              if (order.status === 'unavailable') return {
                ...order,
                responseRequirement: 'Say order lookup is temporarily unavailable and offer to open a support ticket. Do not ask for an email address.',
              }
              return order
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
          ...(signInAvailable ? {
            request_sign_in: tool({
              description: 'Show the caller a store-account sign-in button. Use it before any order lookup, ticket, or human review when the caller is not signed in. The button appears under your reply; sign-in happens on the store’s own hosted login, never in the chat.',
              inputSchema: z.object({
                reason: z.enum(['order_lookup', 'open_ticket', 'product_help'])
                  .describe('Why a verified identity is needed right now.'),
              }),
              execute: async ({ reason }) => {
                signInRequested = true
                const continuationReason: VoiceSignInReason = reason === 'order_lookup' && ordersAvailable
                  ? 'order_lookup'
                  : reason === 'product_help' && ordersAvailable
                    ? 'order_lookup'
                    : 'open_ticket'
                await this.#patchSession({
                  pendingSignInReason: continuationReason,
                  ...(continuationReason === 'open_ticket' ? {
                    pendingEscalation: {
                      category: classifyEscalation(transcript) ?? 'explicit_human_request',
                      customerMessage: transcript,
                      requestId: turnRequestId,
                    },
                  } : {}),
                })
                this.#requestSignIn(context.connection, continuationReason)
                return reason === 'product_help'
                  ? { status: 'requested', responseRequirement: `Reply exactly: "${ordersAvailable ? UNDOCUMENTED_PRODUCT_SIGNIN_ORDER_REPLY : UNDOCUMENTED_PRODUCT_SIGNIN_TICKET_REPLY}"` }
                  : { status: 'requested' }
              },
            }),
          } : {}),
        }),
      },
      // This bounds runaway model generation; TTS still speaks every generated
      // sentence and never applies its own character or sentence cutoff.
      maxOutputTokens: 512,
      temperature: 0,
      stopWhen: stepCountIs(4),
      abortSignal: context.signal,
    })

    // At temperature 0 the model sometimes restates its pre-tool-call sentence
    // verbatim after the tool result; the wrapper drops exact repeats within
    // the turn before they reach TTS and the transcript.
    const stream = recoverAssistantText(
      dedupAssistantText(result.fullStream),
      'I couldn’t finish that answer just now. Please try again, or contact support if it keeps happening.',
      () => console.warn(JSON.stringify({ event: 'voice_model_stream', outcome: 'provider_error' })),
    )
    if (contact) return stream

    // Safety net for the anonymous branch: the model occasionally speaks the
    // scripted "sign in below" line without calling request_sign_in, which
    // would strand the caller in front of a button that never rendered. If the
    // turn mentions signing in and the tool never fired, send the button
    // anyway.
    const connection = context.connection
    const canRequestSignIn = signInAvailable
    return (async function* () {
      let spoken = ''
      for await (const part of stream) {
        if (part.type === 'text-delta') spoken += (part as { text?: string }).text ?? ''
        yield part
      }
      if (canRequestSignIn && !signInRequested && /\bsign[ -]?in\b/i.test(spoken)) {
        connection.send(JSON.stringify({ type: 'voice_signin_required', anchor: 'after_reply' }))
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

  #requestSignIn(connection: Connection, reason?: VoiceSignInReason): void {
    connection.send(JSON.stringify({ type: 'voice_signin_required', anchor: 'after_reply', ...(reason ? { reason } : {}) }))
  }

  /**
   * The deterministic resume after the hosted-login round trip: complete the
   * pending escalation or order flow without the model having to re-infer it.
   */
  async #completeSignInContinuation(
    connection: Connection,
    shopifyCustomer: ShopifyCustomerSession | null,
    contact: VoiceContact | null,
  ): Promise<string | null> {
    if (!shopifyCustomer || !contact) {
      return 'The sign-in did not complete. Use the sign-in button to try again, or open a support request through the form.'
    }
    const session = await this.#session()
    const pendingEscalation = session.pendingEscalation ?? null
    const pendingSignInReason = session.pendingSignInReason ?? null
    await this.#patchSession({ pendingEscalation: null, pendingSignInReason: null })

    if (pendingEscalation) {
      try {
        const ticket = await this.#openEscalationTicket(connection, contact, pendingEscalation, pendingEscalation.requestId)
        const emailCopy = ticket.delivery === 'queued' ? ' The private link is queued for email delivery.' : ''
        return `Thanks ${contact.name}. I’ve opened ticket ${ticket.ref} for human review.${emailCopy}`
      } catch {
        return cleanError()
      }
    }

    if (pendingSignInReason === 'order_lookup') {
      const history = (await this.getConversationHistory(40)).map((message) => ({ role: message.role, content: message.content }))
      const orderNumber = findOrderNumber(history.filter((message) => message.content.trim() !== SIGN_IN_CONTINUATION))
      if (orderNumber) {
        const result = await orderStatusForSession(this.env, { email: contact.email }, orderNumber)
        return orderStatusReply(result)
      }
      const overview = await shopifyCustomerContext(this.env, shopifyCustomer.accessToken, {})
      if (overview.status !== 'ok') return orderStatusReply({ status: 'unavailable' })
      return ordersOverviewReply(overview.customer.orders)
    }

    // No pending verified action remains; ordinary conversation can continue.
    return null
  }

  #secret(state: VoiceConnectionState): string {
    if (this.env.CUSTOMER_CAPABILITY_SECRET) return this.env.CUSTOMER_CAPABILITY_SECRET
    return isLocalHostname(state.hostname ?? '') || Array.isArray(this.env.TEST_MIGRATIONS) ? LOCAL_SECRET : ''
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
    const session = await this.#session()
    const now = Date.now()
    const recent = (session.ticketCreatedAt ?? []).filter((createdAt) => createdAt > now - 15 * 60_000)
    if (session.ticketBusy) throw new Error('Voice ticket creation is already in progress')
    await this.#patchSession({ ticketBusy: true })
    try {
      const [ipRate, emailRate] = await Promise.all([
        this.env.PUBLIC_RATE_LIMIT.limit({ key: `voice_ticket_ip:${state.clientIp ?? 'unknown'}` }),
        this.env.PUBLIC_RATE_LIMIT.limit({ key: `voice_ticket_email:${contact.email}` }),
      ])
      if (!ipRate.success || !emailRate.success) throw new Error('Voice ticket rate limit reached')

      const capacity = await claimVoiceTicketCapacity(this.env.DB, contact.email, requestId, now)
      if (capacity === 'limited') throw new Error('Voice ticket limit reached')

      const ticket = await openVoiceSupportCase(await this.#helpdesk(connection), contact, { ...input, requestId })
      if (ticket.created) await this.#patchSession({
        ticketCreatedAt: [...recent, now],
        ticketBusy: false,
      })
      connection.send(JSON.stringify({
        type: 'voice_ticket_created',
        ticket: { reference: ticket.ref, label: 'Human review requested', status: 'open' },
      }))
      return ticket
    } finally {
      const latest = await this.#session()
      if (latest.ticketBusy) await this.#patchSession({ ticketBusy: false })
    }
  }

  #openEscalationTicket(
    connection: Connection,
    contact: VoiceContact,
    escalation: Pick<NonNullable<VoiceSessionState['pendingEscalation']>, 'category' | 'customerMessage'>,
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
