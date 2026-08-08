import { describe, expect, it } from 'vitest'
import {
  directVoiceResponse,
  prepareVoiceModelMessages,
  voiceAgentSystemPrompt,
} from '../src/voice/conversation'

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

  it('never promises order lookup when Shopify is unavailable', () => {
    const anonymous = voiceAgentSystemPrompt('Example Company', { orders: false, signedIn: false })
    expect(anonymous).toContain('Order lookup is not available in this workspace.')
    expect(anonymous).not.toContain('I can check your order and get the team on it')

    const configured = voiceAgentSystemPrompt('Example Company', { orders: true, signedIn: false })
    expect(configured).toContain('I can check your order and get the team on it')
    expect(configured).not.toContain('Order lookup is not available in this workspace.')
  })

  it('routes anonymous identity actions through store sign-in, never typed contact details', () => {
    const anonymous = voiceAgentSystemPrompt('Example Company', { orders: true, signedIn: false })
    expect(anonymous).toContain('call request_sign_in')
    expect(anonymous).toContain('Never ask the caller to type their name, email, or password in the chat')
    expect(anonymous).not.toContain('request_contact')
    expect(anonymous).not.toContain('add your name and email')

    const signedIn = voiceAgentSystemPrompt('Example Company', { orders: true, signedIn: true })
    expect(signedIn).toContain('signed in with their store account')
    expect(signedIn).toContain('call list_my_orders first')
    expect(signedIn).not.toContain('request_sign_in')

    const unconfigured = voiceAgentSystemPrompt('Example Company', { orders: false, signedIn: false, signInAvailable: false })
    expect(unconfigured).toContain('Store-account sign-in is not configured')
    expect(unconfigured).toContain('support request form')
    expect(unconfigured).not.toContain('request_sign_in')
  })

  it('treats a product-less warranty question as support context', () => {
    const prompt = voiceAgentSystemPrompt('Example Company', { orders: true, signedIn: false })

    expect(prompt).toContain(
      'A question about warranty or another support policy is in scope even when it does not name a product, order, or account.',
    )
    expect(prompt).toContain('For policy or warranty questions, call search_help_center first.')
  })

  it('uses specific empathy without repeating canned apologies', () => {
    const prompt = voiceAgentSystemPrompt('Example Company', { orders: true, signedIn: false })

    expect(prompt).toContain('Make any empathy specific to the problem or impact')
    expect(prompt).toContain('Do not begin each reply with an apology')
    expect(prompt).toContain('never use stock transitions such as "let\'s get this moving."')
    expect(prompt).toContain("A machine that won't start is frustrating. What kind of machine is it?")
    expect(prompt).not.toContain("I'm sorry, let's get this moving")
  })
})
