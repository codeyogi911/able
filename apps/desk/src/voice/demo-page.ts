import { workspaceShortName } from '../settings'

export const VOICE_DEMO_AGENT_NAME = 'AbleDeskAgent'
export const VOICE_DEMO_AGENT_PATH = '/agents/able-desk-agent/'

export type VoiceBranding = {
  displayName: string
  logoUrl: string | null
  faviconUrl: string | null
  homeUrl: string | null
}

export type VoiceHelpTopic = {
  slug: string
  name: string
  description: string
  articles: Array<{ slug: string; title: string }>
}

export function voiceDemoEnabled(env: { ABLE_VOICE_DEMO_ENABLED?: string }): boolean {
  return env.ABLE_VOICE_DEMO_ENABLED === '1'
}

export function isVoiceDemoAgentPath(pathname: string): boolean {
  return pathname.startsWith(VOICE_DEMO_AGENT_PATH)
}

function safeHttpsOrPath(value: string | null): string | null {
  if (!value) return null
  if (value.startsWith('/') && !value.startsWith('//')) return value
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

export function voiceBranding(settings: {
  displayName: string
  logoUrl: string | null
  faviconUrl: string | null
  homeUrl: string | null
}): VoiceBranding {
  return {
    displayName: settings.displayName,
    logoUrl: safeHttpsOrPath(settings.logoUrl),
    faviconUrl: safeHttpsOrPath(settings.faviconUrl),
    homeUrl: safeHttpsOrPath(settings.homeUrl),
  }
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', '&quot;')
}

function monogram(displayName: string): string {
  const glyph = (word: string): string => word.match(/[\p{L}\p{N}]/u)?.[0] ?? ''
  const words = displayName.split(/\s+/).filter((word) => glyph(word) !== '')
  const letters = words.length >= 2
    ? `${glyph(words[0]!)}${glyph(words[1]!)}`
    : [...(words[0] ?? '').matchAll(/[\p{L}\p{N}]/gu)].slice(0, 2).map((match) => match[0]).join('')
  return (letters || 'S').toUpperCase()
}

export type VoiceIdentityView = {
  /** True when Shopify customer sign-in is configured for this deployment. */
  configured: boolean
  /** The signed-in customer's display name, or null when anonymous. */
  customerName: string | null
}

export function voiceDemoPageResponse(
  branding: VoiceBranding,
  turnstileSiteKey = '',
  ordersEnabled = false,
  topics: VoiceHelpTopic[] = [],
  identity: VoiceIdentityView = { configured: false, customerName: null },
): Response {
  const title = /\bsupport$/i.test(branding.displayName.trim())
    ? `${branding.displayName} — assistant`
    : `${branding.displayName} support assistant`
  const brandVisual = branding.logoUrl
    ? `<img class="brand-logo" src="${escapeAttribute(branding.logoUrl)}" alt="">`
    : `<span class="brand-mark" aria-hidden="true">${escapeText(monogram(branding.displayName))}</span>`
  const favicon = branding.faviconUrl
    ? `\n    <link rel="icon" href="${escapeAttribute(branding.faviconUrl)}">`
    : ''
  const avatar = `<span class="avatar" aria-hidden="true">${escapeText(monogram(branding.displayName))}</span>`
  const orderTaskCopy = identity.customerName
    ? 'You’re signed in — Ava can pull up your recent orders.'
    : ordersEnabled && identity.configured
      ? 'Sign in with your store account and Ava pulls it up instantly.'
      : ordersEnabled
        ? 'Share the order number and Ava will check it.'
        : 'Ask Ava for the available tracking steps.'
  const orderTaskMarkup = `<button class="support-task" type="button" data-support-message="I want to track my order." disabled>
                  <span class="support-task-title">Track an order</span>
                  <span class="support-task-copy">${orderTaskCopy}</span>
                </button>`
  const topicMarkup = topics.length > 0
    ? topics.slice(0, 9).map((topic) => `<section class="topic-card">
              <h3><a href="/kb?section=${encodeURIComponent(topic.slug)}">${escapeText(topic.name)}</a></h3>
              ${topic.description ? `<p>${escapeText(topic.description)}</p>` : ''}
              <ul>
                ${topic.articles.slice(0, 3).map((article) => `<li><a href="/kb/${encodeURIComponent(article.slug)}">${escapeText(article.title)}</a></li>`).join('\n                ')}
              </ul>
            </section>`).join('\n            ')
    : `<p class="topics-empty">Help articles are being prepared. Ava can still help you now.</p>`
  return new Response(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="color-scheme" content="light">
    <meta name="theme-color" content="#ffffff">
    <title>${escapeText(title)}</title>${favicon}
    <link rel="stylesheet" href="/workspace-theme.css">
    <link rel="stylesheet" href="/voice-demo.css">
    ${turnstileSiteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>' : ''}
    <script src="/voice-demo.js" defer></script>
  </head>
  <body>
    <a class="skip-link" href="#thread">Skip to support</a>
    <div id="support-app" class="app" data-view="landing">
      <header class="chat-header">
        <div class="chat-header-inner">
          <a class="brand" href="${escapeAttribute(branding.homeUrl ?? '/')}" aria-label="${escapeAttribute(`${branding.displayName} home`)}">
            ${brandVisual}
            <span class="brand-text">
              <span class="brand-name">${escapeText(branding.displayName)}</span>
              <span class="brand-sub">Support assistant</span>
            </span>
          </a>
          <div class="header-actions">
            <nav class="support-nav" aria-label="Support options">
              <a href="/kb">Browse help</a>${identity.customerName
                ? `\n              <span class="signed-in-as">${escapeText(identity.customerName)}</span>\n              <a href="/auth/shopify/logout">Sign out</a>`
                : identity.configured
                  ? '\n              <a href="/auth/shopify/start">Sign in for order help</a>'
                  : ''}
            </nav>
            <button id="clear-button" class="text-button" type="button" hidden disabled>Start over</button>
          </div>
        </div>
      </header>
      <div id="reconnect-banner" class="reconnect-banner" role="status" hidden>Reconnecting…</div>
      <div id="session-turnstile" class="session-turnstile" data-sitekey="${escapeAttribute(turnstileSiteKey)}"></div>

      <main id="thread" class="thread" tabindex="-1">
        <div class="thread-inner">
          <div id="landing-panel" class="landing-panel">
            <section class="landing-hero" aria-labelledby="help-title">
              <h1 id="help-title">How can we help?</h1>
              <p class="landing-lede">Ask Ava anything about ${escapeText(workspaceShortName(branding.displayName))}, start a common task, or open a private support request. She answers from our help articles and can bring in the team when you need them.</p>
              <form id="landing-form" class="ask-composer">
                <span class="ask-icon" aria-hidden="true">${avatar}</span>
                <input id="landing-input" name="question" autocomplete="off" maxlength="500" placeholder="Ask anything" aria-label="Ask anything">
                <button id="landing-mic-button" class="mic-button ask-mic-button" type="button" aria-label="Use voice" title="Talk instead of typing" disabled>
                  <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 10v1a7 7 0 0 0 14 0v-1"></path><path d="M12 18v4"></path></svg>
                </button>
                <button id="landing-submit" type="submit" class="send-button ask-send-button" aria-label="Send question" disabled>
                  <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 7-7 7 7"></path><path d="M12 19V5"></path></svg>
                </button>
              </form>
              <p class="landing-trust">${identity.customerName
                ? `Signed in as ${escapeText(identity.customerName)}. Ava can use your store account for order help.`
                : identity.configured
                  ? 'Start anonymously — answers need no account. Sign in with your store account for order help or tickets.'
                  : 'Start anonymously. Ava answers from the help centre; use the support form for follow-up.'}</p>
              <p id="landing-status" class="landing-status" role="status" aria-live="polite">Preparing secure chat…</p>
            </section>

            <section class="support-tasks" aria-labelledby="support-tasks-title">
              <div class="support-tasks-heading">
                <p class="eyebrow">Common tasks</p>
                <h2 id="support-tasks-title">Choose a starting point</h2>
              </div>
              <div class="support-task-grid">
                ${orderTaskMarkup}
                <button class="support-task" type="button" data-support-message="My delivery is delayed." disabled>
                  <span class="support-task-title">Delivery problem</span>
                  <span class="support-task-copy">Tell Ava what is delayed and she’ll find the right next step.</span>
                </button>
                <button class="support-task" type="button" data-support-message="I need help with warranty or a repair." disabled>
                  <span class="support-task-title">Warranty or repair</span>
                  <span class="support-task-copy">Tell Ava what needs repair or what you want to claim.</span>
                </button>
                <button class="support-task" type="button" data-support-message="I need help with my invoice." disabled>
                  <span class="support-task-title">Billing or invoice</span>
                  <span class="support-task-copy">Ask Ava about an invoice, a charge, or your billing details.</span>
                </button>
                <button id="human-help-button" class="support-task support-task--contact" type="button" disabled>
                  <span class="support-task-title">Contact support</span>
                  <span class="support-task-copy">Describe your issue first. Sign-in is needed only when a private request is opened.</span>
                </button>
                <a class="support-task" href="/requests/recover">
                  <span class="support-task-title">Find a request</span>
                  <span class="support-task-copy">Recover a private case link securely.</span>
                </a>
              </div>
            </section>

            <section class="topics-section" aria-labelledby="topics-title">
              <div class="topics-heading">
                <h2 id="topics-title">Browse by topic</h2>
                <a href="/kb">Browse all</a>
              </div>
              <div class="topic-grid">
                ${topicMarkup}
              </div>
            </section>

          </div>

          <ol id="transcript" class="thread-list" role="log" aria-label="Conversation with Ava" aria-live="polite" hidden>
            <li class="bubble-row bubble-row--assistant" id="signin-flow" hidden>
              ${avatar}
              <div class="bubble-stack">
                <div class="chat-card signin-card">
                  <p id="signin-card-lead" class="chat-card-lead">Sign in to continue</p>
                  <p id="signin-card-copy" class="chat-card-copy">Use your store account — a quick code by email, no password. You’ll come right back to this conversation.</p>
                  <button id="signin-button" class="access-button signin-button" type="button">Sign in with your store account</button>
                  <span class="access-feedback">Sign-in happens on the store’s own secure page.</span>
                </div>
              </div>
            </li>
            <li id="handoff-card" class="bubble-row bubble-row--assistant" hidden>
              ${avatar}
              <div class="chat-card ticket-card">
                <p class="eyebrow">Support ticket opened</p>
                <p class="ticket-title" id="handoff-category">Support ticket opened</p>
                <p class="ticket-copy" id="handoff-description">A support ticket was opened under your store account. The team will follow up by email.</p>
                <dl>
                  <div><dt>Reference</dt><dd id="handoff-reference">—</dd></div>
                  <div><dt>Status</dt><dd id="handoff-status">Open</dd></div>
                </dl>
              </div>
            </li>
          </ol>
        </div>
      </main>

      <footer id="composer-bar" class="composer-bar" hidden>
        <div class="composer-inner">
          <form id="text-form" class="composer">
            <input id="text-input" name="message" autocomplete="off" maxlength="500" placeholder="Ask a follow-up…" aria-label="Ask a follow-up">
            <button id="mic-button" class="mic-button" type="button" aria-label="Use voice" title="Talk instead of typing" disabled>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 10v1a7 7 0 0 0 14 0v-1"></path><path d="M12 18v4"></path></svg>
            </button>
            <button id="conversation-human-button" class="human-action-button" type="button" aria-label="Open a support request" title="Open a support request" disabled>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path><path d="M8 10h.01"></path><path d="M12 10h.01"></path><path d="M16 10h.01"></path></svg>
            </button>
            <button id="mute-button" class="mute-button" type="button" hidden disabled>Mute</button>
            <button type="submit" class="send-button" disabled>Send</button>
          </form>
        </div>
      </footer>
    </div>
  </body>
</html>`, {
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; base-uri 'none'; connect-src 'self' wss: https://challenges.cloudflare.com; font-src 'self'; form-action 'self'; frame-ancestors 'none'; frame-src https://challenges.cloudflare.com; img-src 'self' data: https:; media-src 'self' blob:; script-src 'self' blob: https://challenges.cloudflare.com; style-src 'self'; worker-src blob:",
      'content-type': 'text/html; charset=utf-8',
      'cross-origin-opener-policy': 'same-origin',
      'permissions-policy': 'camera=(), geolocation=(), microphone=(self), payment=()',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
  })
}
