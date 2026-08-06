import { describe, expect, it } from 'vitest'
import {
  directVoiceResponse,
  prepareVoiceModelMessages,
  voiceAgentSystemPrompt,
} from '../src/voice/conversation'
import { ORDER_LOOKUP_CONTACT_CONTINUATION } from '../src/voice/contact'

describe('voice conversation policy', () => {
  it('joins a spoken ticket request split at a natural pause', () => {
    const messages = [
      { role: 'user' as const, content: 'Can you open a new support' },
      { role: 'assistant' as const, content: "Go ahead, I'm listening." },
      { role: 'user' as const, content: 'ticket for me?' },
      { role: 'assistant' as const, content: 'Of course. What happened?' },
      { role: 'user' as const, content: 'My machine is not working.' },
    ]

    expect(directVoiceResponse(messages[2]!.content, messages.slice(0, 3))).toBe('Of course. What happened?')
    expect(prepareVoiceModelMessages(messages)).toEqual([
      { role: 'user', content: 'Can you open a new support ticket for me?' },
      { role: 'assistant', content: 'Of course. What happened?' },
      { role: 'user', content: 'My machine is not working.' },
    ])
  })

  it('explicitly stops a caller from sharing an offered secret', () => {
    expect(directVoiceResponse('Should I tell you my password?')).toBe(
      "Please don't share your password. I can help without it—what problem are you seeing?",
    )
    expect(directVoiceResponse('I forgot my password yesterday.')).toBeNull()
  })

  it('asks for the order number immediately after the product-help contact card', () => {
    expect(directVoiceResponse(
      'I have shared my name and email. Ask me for my order number before opening a ticket.',
    )).toBe('What is the order number from your confirmation email?')
  })

  it('does not ask for an order number that the caller already supplied', () => {
    const continuation = 'I have shared my name and email. Ask me for my order number before opening a ticket.'
    expect(directVoiceResponse(continuation, [
      { role: 'user', content: 'My order #4021 contains the leaking machine.' },
      { role: 'assistant', content: 'Add your name and email in the card below.' },
      { role: 'user', content: continuation },
    ])).toBeNull()
  })

  it('continues a direct order lookup after the contact card without asking twice', () => {
    expect(directVoiceResponse(ORDER_LOOKUP_CONTACT_CONTINUATION)).toBe(
      'What is the order number from your confirmation email?',
    )
    expect(directVoiceResponse(ORDER_LOOKUP_CONTACT_CONTINUATION, [
      { role: 'user', content: 'Where is order #SO-4021?' },
      { role: 'assistant', content: 'Add your name and email in the card below.' },
      { role: 'user', content: ORDER_LOOKUP_CONTACT_CONTINUATION },
    ])).toBeNull()
  })

  it('never promises order lookup when Shopify is unavailable', () => {
    const anonymous = voiceAgentSystemPrompt('Example Company', { orders: false, contact: false })
    expect(anonymous).toContain('Order lookup is not available in this workspace.')
    expect(anonymous).toContain('open a ticket for the team')
    expect(anonymous).not.toContain('I can check your order and get the team on it')

    const configured = voiceAgentSystemPrompt('Example Company', { orders: true, contact: false })
    expect(configured).toContain('I can check your order and get the team on it')
    expect(configured).not.toContain('Order lookup is not available in this workspace.')
  })

  it('treats a product-less warranty question as support context', () => {
    const prompt = voiceAgentSystemPrompt('Example Company', { orders: true, contact: false })

    expect(prompt).toContain(
      'A question about warranty or another support policy is in scope even when it does not name a product, order, or account.',
    )
    expect(prompt).toContain('For policy or warranty questions, call search_help_center first.')
  })

  it('uses specific empathy without repeating canned apologies', () => {
    const prompt = voiceAgentSystemPrompt('Example Company', { orders: true, contact: false })

    expect(prompt).toContain('Make any empathy specific to the problem or impact')
    expect(prompt).toContain('Do not begin each reply with an apology')
    expect(prompt).toContain('never use stock transitions such as "let\'s get this moving."')
    expect(prompt).toContain("A machine that won't start is frustrating. What kind of machine is it?")
    expect(prompt).not.toContain("I'm sorry, let's get this moving")
  })
})
