import { generateText, stepCountIs, streamText, tool, type ModelMessage } from 'ai'
import { createWorkersAI } from 'workers-ai-provider'
import { z } from 'zod'
import {
  directVoiceResponse,
  isHelpCenterSupportRequest,
  prepareVoiceModelMessages,
  UNDOCUMENTED_PRODUCT_SIGNIN_ORDER_REPLY,
  UNDOCUMENTED_PRODUCT_SIGNIN_TICKET_REPLY,
  VOICE_AGENT_MODEL,
  voiceAgentSystemPrompt,
} from '../src/voice/conversation'
import { dedupAssistantText, dedupRepeatedSentences } from '../src/voice/dedup'
import { ESCALATION_CATEGORIES } from '../src/voice/escalation'
import { SIGN_IN_CONTINUATION } from '../src/voice/contact'
import { findOrderNumber } from '../src/voice/orders'

type EvalEnv = { AI: Ai }

function messagesFrom(value: unknown): ModelMessage[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return null
  const messages: ModelMessage[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return null
    const { role, content } = candidate as Record<string, unknown>
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') return null
    const bounded = content.trim().slice(0, 2_000)
    if (!bounded) return null
    messages.push({ role, content: bounded })
  }
  return messages
}

type KbArticleFixture = { title?: string; section?: string; content?: string }

export default {
  async fetch(request: Request, env: EvalEnv): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health') return Response.json({ ok: true })

    if (request.method !== 'POST' || url.pathname !== '/turn') return new Response('Not found', { status: 404 })

    const body = await request.json().catch(() => null) as {
      messages?: unknown
      orders?: unknown
      kb?: unknown
      stream?: unknown
      contact?: unknown
      signedIn?: unknown
      locale?: unknown
      timezone?: unknown
    } | null
    const messages = messagesFrom(body?.messages)
    if (!messages) return Response.json({ error: 'invalid_messages' }, { status: 400 })
    const ordersCase = body?.orders && typeof body.orders === 'object'
      ? body.orders as { fixtures?: { name?: string }[]; unavailable?: boolean }
      : null
    const kbCase = body?.kb && typeof body.kb === 'object'
      ? body.kb as { articles?: KbArticleFixture[]; unavailable?: boolean }
      : null
    // Mirrors production's Shopify-first identity: cases opt into the
    // anonymous branch with contact: false, which swaps the ticket/order
    // tools for request_sign_in and flips the prompt branch. A present
    // contact IS a signed-in store account.
    const signedInCase = body?.signedIn === true || body?.contact !== false

    const latest = messages.at(-1)
    const directResponse = latest?.role === 'user' && typeof latest.content === 'string'
      ? directVoiceResponse(
        latest.content,
        messages as Array<{ role: 'user' | 'assistant'; content: string }>,
      )
      : null
    if (directResponse) return Response.json({ text: directResponse, toolCalls: [], direct: true })

    // Production persists an ordinary ticket request as a pending escalation
    // before navigating to Shopify sign-in, then opens it deterministically on
    // return. Mirror that state transition here instead of asking the model to
    // remember a privileged tool call after the identity boundary.
    if (latest?.role === 'user' && latest.content === SIGN_IN_CONTINUATION && signedInCase && !ordersCase) {
      const originalRequest = [...messages]
        .reverse()
        .find((message) => message.role === 'user' && message.content !== SIGN_IN_CONTINUATION)
      const caseNotes = String(originalRequest?.content ?? 'Customer requested support after signing in.')
      return Response.json({
        text: 'I’ve opened support ticket EVAL-101. A support team member will follow up with you.',
        toolCalls: [{
          name: 'create_ticket',
          input: { internalSummary: 'Signed-in support request', caseNotes },
        }],
        direct: true,
      })
    }

    if (latest?.role === 'user' && latest.content === SIGN_IN_CONTINUATION && signedInCase && ordersCase) {
      const history = messages
        .filter((message) => message.content !== SIGN_IN_CONTINUATION)
        .map((message) => ({ role: message.role as 'user' | 'assistant', content: String(message.content) }))
      const orderNumber = findOrderNumber(history)
      const fixtures = Array.isArray(ordersCase.fixtures) ? ordersCase.fixtures : []
      if (orderNumber) {
        const normalized = orderNumber.replace(/\s+/g, '').replace(/^#/, '').toUpperCase()
        const match = fixtures.find((fixture) => typeof fixture?.name === 'string'
          && fixture.name.replace(/\s+/g, '').replace(/^#/, '').toUpperCase() === normalized)
        const status = match as { name?: string; financialStatus?: string; fulfillmentStatus?: string } | undefined
        return Response.json({
          text: status
            ? `Order ${status.name ?? `#${orderNumber}`} is ${status.financialStatus ?? 'recorded'} and ${status.fulfillmentStatus ?? 'being processed'}.`
            : `I could not find order #${orderNumber} for this store account.`,
          toolCalls: [{ name: 'get_order_status', input: { orderNumber: `#${orderNumber}` } }],
          direct: true,
        })
      }
      const first = fixtures[0] as { name?: string; financialStatus?: string; fulfillmentStatus?: string; lineItems?: { title?: string }[] } | undefined
      return Response.json({
        text: first
          ? `Your recent order is ${first.name ?? 'listed'} for ${first.lineItems?.[0]?.title ?? 'a store product'}, ${first.financialStatus?.toLowerCase() ?? 'recorded'} and ${first.fulfillmentStatus?.toLowerCase() ?? 'being processed'}.`
          : 'I did not find a recent order on this store account.',
        toolCalls: [{ name: 'list_my_orders', input: {} }],
        direct: true,
      })
    }

    const workersAI = createWorkersAI({ binding: env.AI })
    // `stream: true` exercises the same streaming invocation production uses
    // (streamText + fullStream) instead of generateText, so eval cases can
    // catch streaming-only tool-calling regressions.
    const turnOptions = {
      model: workersAI(VOICE_AGENT_MODEL, {
        reasoning_effort: null,
        chat_template_kwargs: { enable_thinking: false },
      }),
      system: voiceAgentSystemPrompt('Example Company', {
        orders: Boolean(ordersCase),
        signedIn: signedInCase,
        ...(typeof body?.locale === 'string' ? { locale: body.locale } : {}),
        ...(typeof body?.timezone === 'string' ? { timezone: body.timezone } : {}),
      }),
      messages: prepareVoiceModelMessages(messages as Array<{ role: 'user' | 'assistant'; content: string }>),
      ...(isHelpCenterSupportRequest(String(messages.at(-1)?.content ?? '')) ? {
        prepareStep: ({ stepNumber }: { stepNumber: number }) => stepNumber === 0
          ? { toolChoice: { type: 'tool' as const, toolName: 'search_help_center' as const } }
          : { toolChoice: 'auto' as const },
      } : {}),
      tools: {
        // Mirrors production: the help-centre tool is always registered.
        search_help_center: tool({
          description: 'Search the published help-centre articles for how-to steps, product care, policies, shipping, warranty, and troubleshooting. Returns article content to answer from; the matching articles are shown to the caller as links automatically.',
          inputSchema: z.object({
            query: z.string().min(2).max(120).describe('Two to six words naming the product, task, or policy, e.g. "clean label printer".'),
          }),
          execute: async () => {
            if (kbCase?.unavailable === true) return { status: 'unavailable' }
            const articles = (Array.isArray(kbCase?.articles) ? kbCase.articles : [])
              .map((article) => ({ title: String(article?.title ?? ''), content: String(article?.content ?? '') }))
              .filter((article) => article.title && article.content)
            return articles.length > 0 ? {
              status: 'ok',
              articles,
              responseRequirement: 'Give the documented answer in natural prose and stop after the sourced step. Do not mention, offer, open, or suggest a support ticket in this reply; wait for the customer to say whether the step failed.',
            } : { status: 'no_match' }
          },
        }),
        ...(signedInCase && ordersCase ? {
          list_my_orders: tool({
            description: "List the signed-in caller's most recent orders: names, dates, payment and fulfillment status, totals, and tracking. Use when they ask about an order without giving a number, then confirm which order they mean. Returns only the signed-in caller's own orders.",
            inputSchema: z.object({}),
            execute: async () => ({ status: 'ok', orders: Array.isArray(ordersCase.fixtures) ? ordersCase.fixtures : [] }),
          }),
        } : {}),
        ...(ordersCase && signedInCase ? {
          get_order_status: tool({
            description: "Look up one order by the caller's order number. The server matches the number together with this session's contact email and returns not_found unless both match; it never reveals whether a number exists for a different email.",
            inputSchema: z.object({
              orderNumber: z.string().min(1).max(32).describe("The customer's order number from their confirmation email, e.g. #1234."),
            }),
            execute: async ({ orderNumber }) => {
              if (ordersCase.unavailable === true) return {
                status: 'unavailable',
                responseRequirement: 'Say order lookup is temporarily unavailable and offer to open a support ticket. Do not ask for an email address.',
              }
              const normalized = orderNumber.replace(/\s+/g, '').replace(/^#/, '').toUpperCase()
              const fixtures = Array.isArray(ordersCase.fixtures) ? ordersCase.fixtures : []
              const match = fixtures.find((fixture) =>
                typeof fixture?.name === 'string'
                && fixture.name.replace(/\s+/g, '').replace(/^#/, '').toUpperCase() === normalized)
              return match ? { status: 'ok', order: match } : {
                status: 'not_found',
                responseRequirement: 'Say the order was not found for this store account, mention it may use a different checkout email, and offer to open a support ticket. Do not offer another lookup instead.',
              }
            },
          }),
        } : {}),
        ...(signedInCase ? {
          create_ticket: tool({
            description: "Open a durable support case for the caller's server-held contact. Synthesize both internal fields from the natural conversation; never ask the caller to provide or format them.",
            inputSchema: z.object({
              internalSummary: z.string().min(5).max(160).describe('A concise internal case title inferred from the conversation.'),
              caseNotes: z.string().min(10).max(2_000).describe('A factual internal case narrative containing the useful context already shared.'),
            }),
            execute: async ({ internalSummary, caseNotes }) => ({
              ref: 'EVAL-101',
              created: true,
              status: 'open',
              internalSummary,
              caseNotes,
            }),
          }),
          request_human: tool({
            description: 'Stop automated support and open a durable ticket for human review.',
            inputSchema: z.object({ category: z.enum(ESCALATION_CATEGORIES) }),
            execute: async ({ category }) => ({ ref: 'EVAL-ESC-1', status: 'open', category }),
          }),
        } : {
          request_sign_in: tool({
            description: 'Show the caller a store-account sign-in button. Use it before any order lookup, ticket, or human review when the caller is not signed in. The button appears under your reply; sign-in happens on the store’s own hosted login, never in the chat.',
            inputSchema: z.object({
              reason: z.enum(['order_lookup', 'open_ticket', 'product_help'])
                .describe('Why a verified identity is needed right now.'),
            }),
            execute: async ({ reason }) => reason === 'product_help'
              ? {
                  status: 'requested',
                  responseRequirement: ordersCase
                    ? `Reply exactly: "${UNDOCUMENTED_PRODUCT_SIGNIN_ORDER_REPLY}"`
                    : `Reply exactly: "${UNDOCUMENTED_PRODUCT_SIGNIN_TICKET_REPLY}"`,
                }
              : { status: 'requested' },
          }),
        }),
      },
      maxOutputTokens: 512,
      temperature: 0,
      stopWhen: stepCountIs(4),
    }

    if (body?.stream === true) {
      const result = streamText(turnOptions)
      const streamParts: string[] = []
      const toolCalls: { name: string; input: unknown }[] = []
      const errors: string[] = []
      let text = ''
      // Mirrors production: the agent wraps fullStream in the same dedup.
      for await (const part of dedupAssistantText(result.fullStream)) {
        const p = part as { type: string; text?: string; toolName?: string; input?: unknown; error?: unknown }
        streamParts.push(p.type)
        if (p.type === 'text-delta') text += p.text ?? ''
        else if (p.type === 'tool-call') toolCalls.push({ name: p.toolName ?? '', input: p.input })
        else if (p.type === 'error' || p.type === 'tool-error') errors.push(String(p.error).slice(0, 500))
      }
      return Response.json({ text, toolCalls, streamParts, errors })
    }

    const result = await generateText(turnOptions)
    const text = dedupRepeatedSentences(result.text)
    const toolCalls = result.steps.flatMap((step) => step.toolCalls.flatMap((call) => (call ? [{
      name: call.toolName,
      input: call.input,
    }] : [])))
    // Mirror the production anonymous safety net: if the model speaks the
    // scripted sign-in line without firing the tool, the agent still emits the
    // sign-in event so the caller is never stranded in front of missing UI.
    if (!signedInCase && /\bsign[ -]?in\b/i.test(text)
      && !toolCalls.some((call) => call.name === 'request_sign_in')) {
      toolCalls.push({ name: 'request_sign_in', input: { reason: 'product_help', recovered: true } })
    }
    return Response.json({
      text,
      toolCalls,
    })
  },
}
