import { describe, expect, it } from 'vitest'
import { normalizeVoiceContact, SIGN_IN_CONTINUATION } from '../src/voice/contact'
import { HUMAN_HELP_MESSAGE, classifyEscalation, isTicketStatusRequest } from '../src/voice/escalation'
import {
  isVoiceDemoAgentPath,
  voiceBranding,
  voiceDemoEnabled,
  voiceDemoPageResponse,
} from '../src/voice/demo-page'

const BRANDING = voiceBranding({
  displayName: 'Example Company',
  logoUrl: 'https://cdn.example.test/logo.png',
  faviconUrl: '/favicon.png',
  homeUrl: 'https://company.example.test/',
})

describe('voice demo boundary', () => {
  it('is fail-closed unless the exact demo flag is enabled', () => {
    expect(voiceDemoEnabled({})).toBe(false)
    expect(voiceDemoEnabled({ ABLE_VOICE_DEMO_ENABLED: 'true' })).toBe(false)
    expect(voiceDemoEnabled({ ABLE_VOICE_DEMO_ENABLED: '1' })).toBe(true)
    expect(isVoiceDemoAgentPath('/agents/able-desk-agent/session-1')).toBe(true)
    expect(isVoiceDemoAgentPath('/agents/another-agent/session-1')).toBe(false)
  })

  it('renders a no-store, CSP-protected page that opens without an upfront contact gate', async () => {
    const response = voiceDemoPageResponse(BRANDING, 'turnstile-site-key')
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(response.headers.get('content-security-policy')).toContain('https://challenges.cloudflare.com')
    expect(response.headers.get('content-security-policy')).toContain('worker-src blob:')
    expect(response.headers.get('content-security-policy')).toContain("img-src 'self' data: https:")
    expect(response.headers.get('permissions-policy')).toContain('microphone=(self)')
    // The sign-in card parks hidden inside the transcript; identity is the
    // store account, asked for mid-conversation, not before it. Nothing on the
    // page asks the customer to type a name or an email.
    expect(html).toContain('<li class="bubble-row bubble-row--assistant" id="signin-flow" hidden>')
    expect(html).toContain('id="signin-button"')
    expect(html).not.toContain('id="contact-form"')
    expect(html).not.toContain('type="email"')
    expect(html).not.toContain('type="tel"')
    expect(html).not.toContain('autocomplete="name"')
    expect(html).toContain('id="session-turnstile"')
    expect(html).toContain('data-sitekey="turnstile-site-key"')
    expect(html).toContain('id="landing-status"')
    expect(html).toContain('<h1 id="help-title">How can we help?</h1>')
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    expect(html).toContain('role="log"')
    expect(html).toContain('start a common task, or open a private support request.')
    expect(html).toContain('Start anonymously. Ava answers from the help centre; use the support form for follow-up.')
    expect(html).toContain('id="landing-input"')
    expect(html).toContain('aria-label="Ask anything"')
    expect(html.indexOf('id="session-turnstile"')).toBeLessThan(html.indexOf('id="thread"'))
    expect(html).toContain('/voice-demo.js')
    expect(html).toContain('/voice-demo.css')
    expect(html).not.toContain('id="call-otp-form"')
    expect(html.toLowerCase()).not.toContain('otp')
  })

  it('advertises order lookup and sign-in according to configuration', async () => {
    const ticketsOnly = await voiceDemoPageResponse(BRANDING, 'turnstile-site-key').text()
    const withOrders = await voiceDemoPageResponse(BRANDING, 'turnstile-site-key', true).text()
    const withSignIn = await voiceDemoPageResponse(BRANDING, 'turnstile-site-key', true, [], { configured: true, customerName: null }).text()
    const signedIn = await voiceDemoPageResponse(BRANDING, 'turnstile-site-key', true, [], { configured: true, customerName: 'Rhea Kapoor' }).text()

    expect(ticketsOnly).toContain('data-support-message="I want to track my order."')
    expect(ticketsOnly).toContain('Ask Ava for the available tracking steps.')
    expect(ticketsOnly).not.toContain('/auth/shopify/start')
    expect(withOrders).toContain('Share the order number and Ava will check it.')
    expect(withSignIn).toContain('Sign in with your store account and Ava pulls it up instantly.')
    expect(withSignIn).toContain('href="/auth/shopify/start">Sign in for order help</a>')
    expect(signedIn).toContain('You’re signed in — Ava can pull up your recent orders.')
    expect(signedIn).toContain('Signed in as Rhea Kapoor.')
    expect(signedIn).toContain('href="/auth/shopify/logout">Sign out</a>')
    expect(signedIn).not.toContain('href="/auth/shopify/start"')
  })

  it('keeps the hosted store login as the only identity step', async () => {
    const html = await voiceDemoPageResponse(BRANDING, 'turnstile-site-key', true, [], { configured: true, customerName: null }).text()

    expect(html).toContain('Sign in with your store account')
    expect(html).toContain('Sign-in happens on the store’s own secure page.')
    expect(html.toLowerCase()).not.toContain('one-time-code')
    expect(html.toLowerCase()).not.toContain('otp')
    // No in-chat identity inputs of any kind.
    expect(html).not.toContain('autocomplete="email"')
  })

  it('renders an agent-first landing with voice as a secondary control', async () => {
    const response = voiceDemoPageResponse(BRANDING, 'turnstile-site-key')
    const html = await response.text()

    expect(html).toContain('Ask Ava anything about Example Company, start a common task, or open a private support request.')

    // A display name that already ends in "Support" must not double the word
    // in copy that addresses the workspace by its short name.
    const suffixed = voiceBranding({
      displayName: 'Example Company Support',
      logoUrl: null,
      faviconUrl: null,
      homeUrl: null,
    })
    const suffixedHtml = await voiceDemoPageResponse(suffixed, 'turnstile-site-key').text()
    expect(suffixedHtml).toContain('Ask Ava anything about Example Company, start a common task, or open a private support request.')
    expect(suffixedHtml).not.toContain('Ask Ava anything about Example Company Support,')
    expect(html).toContain('Support assistant')
    expect(html).toContain('id="text-form"')
    expect(html).toContain('id="landing-form"')
    expect(html).toContain('placeholder="Ask anything"')
    expect(html).toContain('data-support-message="My delivery is delayed."')
    expect(html).toContain('data-support-message="I need help with warranty or a repair."')
    expect(html).toContain('data-support-message="Help me choose the right product for my needs."')
    expect(html).toContain('href="/requests/recover"')
    expect(html).toContain('placeholder="Ask a follow-up…"')
    expect(html).toContain('data-connection="connecting"')
    expect(html).toContain('Ava is getting ready — you can ask now.')
    expect(html).toContain('id="mic-button"')
    expect(html).toContain('id="landing-mic-button"')
    expect(html).toContain('aria-label="Use voice"')
    expect(html).toContain('title="Talk instead of typing"')
    expect(html).toContain('New conversation')
    expect(html).toContain('href="/kb">Help centre</a>')
    expect(html).toContain('id="human-help-button"')
    expect(html).toContain('id="conversation-human-button"')
    expect(html).toContain('class="conversation-help-button" type="button">Contact support</button>')
    expect(html).not.toContain('class="human-action-button"')
    expect(html).toContain('Describe your issue first. Sign-in is needed only when a private request is opened.')
    expect(html).toContain('id="reconnect-banner"')
    expect(html).not.toContain('class="privacy-note"')
    expect(html).toContain('viewport-fit=cover')

    // The landing is the primary state; progressive cards remain parked in
    // the hidden transcript until the agent needs them.
    const thread = html.indexOf('id="thread"')
    const transcript = html.indexOf('id="transcript"')
    const signinFlow = html.indexOf('id="signin-flow"')
    const composer = html.indexOf('id="text-form"')
    expect(thread).toBeGreaterThan(-1)
    expect(transcript).toBeGreaterThan(thread)
    expect(signinFlow).toBeGreaterThan(transcript)
    expect(composer).toBeGreaterThan(signinFlow)
  })

  it('invites India customers to use English or Hinglish', async () => {
    const html = await voiceDemoPageResponse(
      BRANDING,
      'turnstile-site-key',
      true,
      [],
      { configured: false, customerName: null },
      'en-IN',
    ).text()

    expect(html).toContain('<html lang="en-IN">')
    expect(html).toContain('English ya Hinglish—jismein aap comfortable hain.')
    expect(html).toContain('placeholder="Ask in English or Hinglish"')
    expect(html).toContain('aria-label="Ask in English or Hinglish"')
  })

  it('renders escaped live help topics with conventional knowledge links', async () => {
    const html = await voiceDemoPageResponse(BRANDING, '', false, [{
      slug: 'machines & care',
      name: 'Machines & <care>',
      description: 'Set up & maintain your machine.',
      articles: [
        { slug: 'first <setup>', title: 'First <setup>' },
        { slug: 'second', title: 'Second' },
        { slug: 'third', title: 'Third' },
        { slug: 'fourth', title: 'Fourth should not render' },
      ],
    }]).text()

    expect(html).toContain('Browse by topic')
    expect(html).toContain('/kb?section=machines%20%26%20care')
    expect(html).toContain('Machines &amp; &lt;care&gt;')
    expect(html).toContain('Set up &amp; maintain your machine.')
    expect(html).toContain('/kb/first%20%3Csetup%3E')
    expect(html).toContain('First &lt;setup&gt;')
    expect(html).toContain('/kb/third')
    expect(html).not.toContain('/kb/fourth')
    expect(html).not.toContain('Fourth should not render')
    expect(html).not.toContain('role="search"')
  })

  it('brands the page from workspace settings and links the workspace theme first', async () => {
    const response = voiceDemoPageResponse(BRANDING, 'turnstile-site-key')
    const html = await response.text()

    expect(html).toContain('<title>Example Company support assistant</title>')
    expect(html).toContain('aria-label="Example Company home"')
    expect(html).toContain('href="https://company.example.test/"')
    expect(html).toContain('<img class="brand-logo" src="https://cdn.example.test/logo.png" alt="">')
    expect(html).toContain('<link rel="icon" href="/favicon.png">')
    expect(html).toContain('/workspace-theme.css')
    expect(html.indexOf('/workspace-theme.css')).toBeLessThan(html.indexOf('/voice-demo.css'))
    expect(html).toContain('<meta name="color-scheme" content="light">')
  })

  it('falls back to a monogram, home link, and escaped values without optional branding', async () => {
    const branding = voiceBranding({
      displayName: 'Rock & Roll Support',
      logoUrl: 'javascript:alert(1)',
      faviconUrl: null,
      homeUrl: 'http://insecure.example.test/',
    })
    const response = voiceDemoPageResponse(branding)
    const html = await response.text()

    expect(branding.logoUrl).toBeNull()
    expect(branding.homeUrl).toBeNull()
    expect(html).toContain('<title>Rock &amp; Roll Support — assistant</title>')
    expect(html).toContain('<span class="brand-mark" aria-hidden="true">RR</span>')
    expect(html).toContain('aria-label="Rock &amp; Roll Support home"')
    expect(html).toContain('href="/"')
    expect(html).not.toContain('javascript:alert')
    expect(html).not.toContain('rel="icon"')
  })

  it('removes the demo chrome from the customer-facing page', async () => {
    const response = voiceDemoPageResponse(BRANDING, 'turnstile-site-key')
    const html = await response.text()

    expect(html).not.toContain('Flux STT')
    expect(html).not.toContain('Try an escalation trigger')
    expect(html).not.toContain('Deterministic safety net')
    expect(html).not.toContain('data-prompt')
    expect(html).not.toContain('id="metrics"')
    expect(html).not.toContain('Cloudflare-native path')
    expect(html).not.toContain('demo session')
    expect(html).not.toContain('Able Desk')
    expect(html).not.toContain('Live browser call')
    expect(html).not.toContain('Live transcript')
    expect(html).not.toContain('voice-orb')
    expect(html).not.toContain('audio-level')
    expect(html).not.toContain('connection-badge')
    expect(html).not.toContain('Start browser call')
    expect(html).toContain('<h1 id="help-title">How can we help?</h1>')
    expect(html).not.toContain('Shopify')
    expect(html).toContain('id="handoff-card"')
    expect(html).toContain('id="handoff-reference"')
  })

  it.each([
    ['Please let me speak to a real person', 'explicit_human_request'],
    ['The plug sparked and now the machine is smoking', 'safety_risk'],
    ['Someone else accessed my account', 'account_security'],
    ['I was charged twice and want a refund', 'payment_or_refund'],
    ['This is a privacy request: delete my data', 'privacy_or_legal'],
    ['I already tried that and it is still not working', 'repeated_failure'],
  ] as const)('escalates %s as %s', (transcript, expected) => {
    expect(classifyEscalation(transcript)).toBe(expected)
  })

  it('leaves a routine care question with the voice model', () => {
    expect(classifyEscalation('How should I clean the printer rollers?')).toBeNull()
  })

  it('routes the landing human-help action through deterministic JIT escalation', () => {
    expect(classifyEscalation(HUMAN_HELP_MESSAGE)).toBe('explicit_human_request')
  })

  it('routes serious-category ticket status questions to status lookup instead of opening duplicates', () => {
    expect(isTicketStatusRequest('What is the status of my refund ticket AD-123?')).toBe(true)
    expect(isTicketStatusRequest('Has my refund been processed?')).toBe(true)
    expect(isTicketStatusRequest('I need a refund because I was charged twice.')).toBe(false)
    expect(classifyEscalation('Any update on my ticket? The machine is now smoking.')).toBe('safety_risk')
  })

  it('normalizes name and email while discarding untrusted extra fields', () => {
    expect(normalizeVoiceContact({
      email: 'CALLER@example.test',
      name: '  Ada Customer  ',
      phone: '+65 9123 4567',
    })).toEqual({ name: 'Ada Customer', email: 'caller@example.test' })
    expect(normalizeVoiceContact({ name: 'Ada', email: 'not-an-email' })).toBeNull()
    expect(normalizeVoiceContact({ email: 'ada@example.test' })).toBeNull()
    expect(normalizeVoiceContact({})).toBeNull()
  })

  it('resumes the interrupted flow with an explicit sign-in continuation', () => {
    expect(SIGN_IN_CONTINUATION).toContain('signed in with my store account')
  })

})
