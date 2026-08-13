import { describe, expect, it } from 'vitest'
import {
  budgetBundleReply,
  directVoiceResponse,
  inrBudgetFromTranscript,
  isStorefrontShoppingRequest,
  prepareVoiceModelMessages,
  spokenVoiceChunk,
  productComparisonReply,
  productComparisonTerms,
  voiceAgentSystemPrompt,
} from '../src/voice/conversation'

describe('voice conversation policy', () => {
  it('deterministically recognizes storefront shopping intent', () => {
    expect(isStorefrontShoppingRequest('What should I buy for two cappuccinos with a ₹45,000 budget?')).toBe(true)
    expect(isStorefrontShoppingRequest('Do you have the Example G5 in stock?')).toBe(true)
    expect(isStorefrontShoppingRequest('Compare the FlatMill 54 and FlatMill 64 grinders')).toBe(true)
    expect(isStorefrontShoppingRequest('How do I clean my grinder?')).toBe(false)
    expect(isStorefrontShoppingRequest('What does the warranty cover?')).toBe(false)
  })

  it('extracts explicit Indian shopping budgets without guessing other numbers', () => {
    expect(inrBudgetFromTranscript('My total budget is around ₹45,000')).toBe(45_000)
    expect(inrBudgetFromTranscript('Need a grinder under INR 20k')).toBe(20_000)
    expect(inrBudgetFromTranscript('Budget 35000 for a machine')).toBe(35_000)
    expect(inrBudgetFromTranscript('I make two cappuccinos every morning')).toBeNull()
  })

  it('renders only a live returned bundle whose maximum price fits the INR budget', () => {
    const products = [{
      title: 'Example Machine with Grinder',
      availableForSale: true,
      priceRange: {
        min: { amount: '43499.0', currencyCode: 'INR' },
        max: { amount: '44499.0', currencyCode: 'INR' },
      },
    }]
    expect(budgetBundleReply(products, 45_000)).toBe(
      'The Example Machine with Grinder is currently available at ₹43,499–₹44,499, so its highest listed price fits your ₹45,000 budget. It combines the machine and grinder in one storefront item.',
    )
    expect(budgetBundleReply(products, 40_000)).toBeNull()
  })

  it('compares the two requested standalone products instead of similarly named bundles', () => {
    expect(productComparisonTerms('Compare the FlatMill V4 and the ConeMill G5 for home espresso. What is the price difference?'))
      .toEqual(['FlatMill V4', 'ConeMill G5'])
    const flatProducts = [{
      title: 'Example Machine with FlatMill Grinder',
      description: 'A bundle with a grinder.',
      productType: 'Bundle',
      availableForSale: true,
      priceRange: { min: { amount: '52499', currencyCode: 'INR' }, max: { amount: '53499', currencyCode: 'INR' } },
    }, {
      title: 'FlatMill V4 - 54mm Flat Burr Coffee Grinder',
      description: 'For espresso with 54mm stainless-steel flat burrs.',
      productType: 'Grinder',
      availableForSale: true,
      priceRange: { min: { amount: '29999', currencyCode: 'INR' }, max: { amount: '29999', currencyCode: 'INR' } },
    }]
    const coneProducts = [{
      title: 'ConeMill G5 48mm Conical Burr Electric Coffee Grinder',
      description: 'For espresso with 48mm stainless-steel conical burrs.',
      productType: 'Grinder',
      availableForSale: true,
      priceRange: { min: { amount: '19999', currencyCode: 'INR' }, max: { amount: '19999', currencyCode: 'INR' } },
    }]
    expect(productComparisonReply('FlatMill V4', flatProducts, 'ConeMill G5', coneProducts)).toBe(
      'FlatMill V4 - 54mm Flat Burr Coffee Grinder is ₹29,999 and ConeMill G5 48mm Conical Burr Electric Coffee Grinder is ₹19,999, so FlatMill V4 - 54mm Flat Burr Coffee Grinder costs ₹10,000 more. For espresso, the main returned distinction is 54mm flat burrs versus 48mm conical burrs.',
    )
  })

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
    expect(prompt).toContain('a private request link, or the support-request process is also in scope')
  })

  it('separates storefront discovery from help-centre support grounding', () => {
    const configured = voiceAgentSystemPrompt('Example Company', {
      orders: true,
      products: true,
      signedIn: false,
    })
    expect(configured).toContain('call search_storefront_products first')
    expect(configured).toContain('call get_storefront_product with the exact handle returned by search')
    expect(configured).toContain('shopping, selection, price, or catalog-availability question uses the storefront tools')
    expect(configured).toContain('repair, or troubleshooting question')
    expect(configured).toContain('Do not ask the caller to identify or correct the product before that search')
    expect(configured).toContain('that is a documented answer')
    expect(configured).toContain('never say that no guide, no direct guide, or no information was found')
    expect(configured).toContain('never invent specifications, compatibility, price, availability, variants, or recommendations')

    const unavailable = voiceAgentSystemPrompt('Example Company', {
      orders: false,
      products: false,
      signedIn: false,
    })
    expect(unavailable).not.toContain('call search_storefront_products first')
    expect(unavailable).toContain('Use the help centre for product support')
  })

  it('uses specific empathy without repeating canned apologies', () => {
    const prompt = voiceAgentSystemPrompt('Example Company', { orders: true, signedIn: false })

    expect(prompt).toContain('Make any empathy specific to the problem or impact')
    expect(prompt).toContain('Do not begin each reply with an apology')
    expect(prompt).toContain('never use stock transitions such as "let\'s get this moving."')
    expect(prompt).toContain("A machine that won't start is frustrating. What kind of machine is it?")
    expect(prompt).not.toContain("I'm sorry, let's get this moving")
  })

  it('adds factual India customer guidance only for an India workspace', () => {
    const india = voiceAgentSystemPrompt('Example Company', {
      products: true,
      locale: 'en-IN',
      timezone: 'Asia/Kolkata',
    })
    expect(india).toContain('INDIA CUSTOMER EXPERIENCE')
    expect(india).toContain('Indian English, Hindi, and Hinglish')
    expect(india).toContain('Hindi in Devanagari, Roman-script Hindi')
    expect(india).toContain("Mirror the customer's language naturally")
    expect(india).toContain('prefer Roman script')
    expect(india).toContain('without caricaturing an accent')
    expect(india).toContain('Aapka budget kitna hai?')
    expect(india).toContain('₹')
    expect(india).toContain('Never assume GST invoice eligibility')
    expect(voiceAgentSystemPrompt('Example Company', { locale: 'en-SG' }))
      .not.toContain('INDIA CUSTOMER EXPERIENCE')
  })

  it('projects rich screen answers into concise natural speech', () => {
    expect(spokenVoiceChunk(
      '**DF54 V4** is ₹29,999. [See the product](https://example.test/products/df54)',
    )).toBe('DF54 V4 is 29,999 rupees. See the product')
    expect(spokenVoiceChunk('- First step\n- Second step:')).toBe('First step Second step.')
    expect(spokenVoiceChunk('A'.repeat(300), 80)).toBe(`${'A'.repeat(79)}.`)
    expect(spokenVoiceChunk('Anything', 20)).toBeNull()

    const prompt = voiceAgentSystemPrompt('Example Company', { locale: 'en-IN' })
    expect(prompt).toContain('Put the answer in voice-first order')
    expect(prompt).toContain('first sentence must be a self-contained, natural spoken summary')
    expect(prompt).toContain('place optional specifications, steps, and comparisons after it for the screen')
  })
})
