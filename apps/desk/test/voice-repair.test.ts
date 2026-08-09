import { describe, expect, it } from 'vitest'

import { claimsKnowledgeGap, prepareForcedSearchStep, repairUnsearchedKnowledgeGap } from '../src/voice/repair'

// Observed @cf/zai-org/glm-4.7-flash output at temperature 0: the broken
// kbMiss shape — an unfamiliar-product question answered with a knowledge-gap
// claim and no tool call.
const UNSEARCHED_GAP_REPLIES = [
  "I can only help with support for products, services, orders, or accounts. I don't have information on router settings. If you have a support case or a product issue, I can open a ticket for you. What support problem can I help with?",
  "I can only help with support for products, services, orders, or accounts. I don't have information about adjusting print alignment on routers. If you have a support question about a router, I can open a ticket for the team to assist. Would you like me to do that?",
  "I don't have a documented answer for adjusting print alignment on a router. If this is related to a specific product or service you're using, I can open a support ticket for you.",
  "I don't have a documented guide for that. Add your name and email in the card below and I can open a ticket for the team.",
  'That is not documented in our help articles, so I cannot walk you through it.',
  'There is no article covering that, but I can open a ticket for the team.',
  "I couldn't find a guide for that, but the team can help.",
]

// Observed off-topic scope redirects, plus non-KB capability statements that
// must never trigger a forced search.
const NON_GAP_REPLIES = [
  "I can only help with support for Example Company's products, services, orders, or accounts. If you have a question about a product or service from us, I'm happy to assist. Otherwise, I can open a support ticket for you to discuss this further.",
  "I can only help with support for Example Company's products, services, orders, or accounts. If you have a question about a product or service from us, I'd be happy to assist. Otherwise, I'm not able to answer general questions like this.",
  "I can only help with support questions about products, services, orders, or accounts. If you have a support issue, please describe it and I'll assist.",
  "I can only help with support for Example Company's products, services, orders, accounts, or existing support cases. I'm not able to discuss general programming topics or language comparisons. If you have a support question about a product or service, I'd be happy to assist.",
  "I'm not able to discuss general programming language comparisons or opinions. If you have a support question, I'm happy to assist.",
  "You'll get updates by email through your private case link — I can't check ticket status here.",
  "I couldn't find that order for the email on this session. Double-check the number, or restart the chat with the email used at checkout. I can also open a support ticket for the team.",
  "I'm having trouble checking orders right now. I can open a support ticket for the team to follow up.",
  "Please don't share your password. I can help without it—what problem are you seeing?",
  "A machine that won't start is frustrating. What kind of machine is it?",
  'Clean the machine every 60 days using a citric acid cleaning solution, then run one full tank of fresh water through afterward. Never use vinegar, as it damages the pump seals.',
  "I'm not able to answer that, but our support team can guide you through the next steps.",
  'Happy to check. What is the order number from your confirmation email?',
  "I don't have the ability to answer general questions like this.",
  "Got it — there's no answer when you press the power button, correct?",
  "I don't have anyone to guide you through that right now, but I can open a ticket.",
]

type Part = { type: string; text?: string; toolName?: string }

async function collect(stream: AsyncIterable<Part>): Promise<Part[]> {
  const parts: Part[] = []
  for await (const part of stream) parts.push(part)
  return parts
}

async function* parts(...items: Part[]): AsyncIterable<Part> {
  yield* items
}

describe('knowledge-gap claim detection', () => {
  it('matches every observed unsearched knowledge-gap reply', () => {
    for (const reply of UNSEARCHED_GAP_REPLIES) {
      expect(claimsKnowledgeGap(reply), reply).toBe(true)
    }
  })

  it('never matches scope redirects or non-knowledge capability statements', () => {
    for (const reply of NON_GAP_REPLIES) {
      expect(claimsKnowledgeGap(reply), reply).toBe(false)
    }
  })
})

describe('forced search step', () => {
  it('forces search_help_center only on the first step', () => {
    expect(prepareForcedSearchStep({ stepNumber: 0 })).toEqual({
      toolChoice: { type: 'tool', toolName: 'search_help_center' },
    })
    expect(prepareForcedSearchStep({ stepNumber: 1 })).toEqual({})
  })
})

describe('unsearched knowledge-gap stream repair', () => {
  it('passes a turn with a tool call through untouched and never reruns', async () => {
    const source = parts(
      { type: 'text-delta', text: 'Let me check. ' },
      { type: 'tool-call', toolName: 'search_help_center' },
      { type: 'text-delta', text: "I don't have a documented answer for that." },
      { type: 'finish' },
    )
    const collected = await collect(repairUnsearchedKnowledgeGap(source, () => {
      throw new Error('must not rerun')
    }))
    expect(collected.map((part) => part.type)).toEqual(['text-delta', 'tool-call', 'text-delta', 'finish'])
  })

  it('passes a text-only turn without a gap claim through untouched', async () => {
    const source = parts(
      { type: 'text-delta', text: 'What kind of machine is it?' },
      { type: 'finish' },
    )
    const collected = await collect(repairUnsearchedKnowledgeGap(source, () => {
      throw new Error('must not rerun')
    }))
    expect(collected.map((part) => part.type)).toEqual(['text-delta', 'finish'])
  })

  it('discards an unsearched gap-claim turn and streams the rerun instead', async () => {
    const source = parts(
      { type: 'text-delta', text: 'I can only help with support. ' },
      { type: 'text-delta', text: "I don't have information on router settings." },
      { type: 'finish' },
    )
    const collected = await collect(repairUnsearchedKnowledgeGap(source, () => parts(
      { type: 'tool-call', toolName: 'search_help_center' },
      { type: 'text-delta', text: "I don't have a documented answer for that. I can open a ticket." },
      { type: 'finish' },
    )))
    expect(collected[0]).toEqual({ type: 'tool-call', toolName: 'search_help_center' })
    const text = collected.filter((part) => part.type === 'text-delta').map((part) => part.text).join('')
    expect(text).toBe("I don't have a documented answer for that. I can open a ticket.")
  })

  it('detects a gap claim split across text deltas', async () => {
    const source = parts(
      { type: 'text-delta', text: "I don't have inform" },
      { type: 'text-delta', text: 'ation about that product.' },
      { type: 'finish' },
    )
    const collected = await collect(repairUnsearchedKnowledgeGap(source, () => parts(
      { type: 'tool-call', toolName: 'search_help_center' },
      { type: 'finish' },
    )))
    expect(collected[0]?.type).toBe('tool-call')
  })
})
