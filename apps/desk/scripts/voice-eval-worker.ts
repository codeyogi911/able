import { generateText, stepCountIs, streamText, tool, type ModelMessage } from 'ai'
import { createWorkersAI } from 'workers-ai-provider'
import { z } from 'zod'
import {
  directVoiceResponse,
  prepareVoiceModelMessages,
  UNDOCUMENTED_PRODUCT_ORDER_CONTACT_REPLY,
  UNDOCUMENTED_PRODUCT_TICKET_CONTACT_REPLY,
  VOICE_AGENT_MODEL,
  voiceAgentSystemPrompt,
} from '../src/voice/conversation'
import { dedupAssistantText, dedupRepeatedSentences } from '../src/voice/dedup'
import { ESCALATION_CATEGORIES } from '../src/voice/escalation'

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
    } | null
    const messages = messagesFrom(body?.messages)
    if (!messages) return Response.json({ error: 'invalid_messages' }, { status: 400 })
    const ordersCase = body?.orders && typeof body.orders === 'object'
      ? body.orders as { fixtures?: { name?: string }[]; unavailable?: boolean }
      : null
    const kbCase = body?.kb && typeof body.kb === 'object'
      ? body.kb as { articles?: KbArticleFixture[]; unavailable?: boolean }
      : null
    // Mirrors production's deferred identity: cases opt into the anonymous
    // branch with contact: false, which swaps the ticket/order tools for
    // request_contact and flips the prompt branch.
    const contactPresent = body?.contact !== false

    const latest = messages.at(-1)
    const directResponse = latest?.role === 'user' && typeof latest.content === 'string'
      ? directVoiceResponse(
        latest.content,
        messages as Array<{ role: 'user' | 'assistant'; content: string }>,
      )
      : null
    if (directResponse) return Response.json({ text: directResponse, toolCalls: [], direct: true })

    const workersAI = createWorkersAI({ binding: env.AI })
    // `stream: true` exercises the same streaming invocation production uses
    // (streamText + fullStream) instead of generateText, so eval cases can
    // catch streaming-only tool-calling regressions.
    const turnOptions = {
      model: workersAI(VOICE_AGENT_MODEL, {
        reasoning_effort: null,
        chat_template_kwargs: { enable_thinking: false },
      }),
      system: voiceAgentSystemPrompt('Example Company', { orders: Boolean(ordersCase), contact: contactPresent }),
      messages: prepareVoiceModelMessages(messages as Array<{ role: 'user' | 'assistant'; content: string }>),
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
            return articles.length > 0 ? { status: 'ok', articles } : { status: 'no_match' }
          },
        }),
        ...(ordersCase && contactPresent ? {
          get_order_status: tool({
            description: "Look up one order by the caller's order number. The server matches the number together with this session's contact email and returns not_found unless both match; it never reveals whether a number exists for a different email.",
            inputSchema: z.object({
              orderNumber: z.string().min(1).max(32).describe("The customer's order number from their confirmation email, e.g. #1234."),
            }),
            execute: async ({ orderNumber }) => {
              if (ordersCase.unavailable === true) return { status: 'unavailable' }
              const normalized = orderNumber.replace(/\s+/g, '').replace(/^#/, '').toUpperCase()
              const fixtures = Array.isArray(ordersCase.fixtures) ? ordersCase.fixtures : []
              const match = fixtures.find((fixture) =>
                typeof fixture?.name === 'string'
                && fixture.name.replace(/\s+/g, '').replace(/^#/, '').toUpperCase() === normalized)
              return match ? { status: 'ok', order: match } : { status: 'not_found' }
            },
          }),
        } : {}),
        ...(contactPresent ? {
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
          request_contact: tool({
            description: "Show the caller a secure card to share their name and the email used for their order or ticket follow-up. Use it before any order lookup, ticket, or human review when no contact is on file. The card appears under your reply; the caller fills it there, never in the chat.",
            inputSchema: z.object({
              reason: z.enum(['order_lookup', 'open_ticket', 'product_help'])
                .describe('Why contact details are needed right now.'),
            }),
            execute: async ({ reason }) => reason === 'product_help'
              ? {
                  status: 'requested',
                  responseRequirement: ordersCase
                    ? `Reply exactly: "${UNDOCUMENTED_PRODUCT_ORDER_CONTACT_REPLY}"`
                    : `Reply exactly: "${UNDOCUMENTED_PRODUCT_TICKET_CONTACT_REPLY}"`,
                }
              : { status: 'requested' },
          }),
        }),
      },
      maxOutputTokens: 120,
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
    return Response.json({
      text: dedupRepeatedSentences(result.text),
      toolCalls: result.steps.flatMap((step) => step.toolCalls.flatMap((call) => (call ? [{
        name: call.toolName,
        input: call.input,
      }] : []))),
    })
  },
}
